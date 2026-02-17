const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const config = require('../config');

let openai = null;

// Whisper accepts max 25MB — stay safely under that
const MAX_CHUNK_BYTES = 24 * 1024 * 1024;
// 20 minutes per chunk at 128kbps 16kHz ≈ ~18MB, well under limit
const CHUNK_DURATION_SECS = 20 * 60;

function getOpenAI() {
  if (!openai) {
    if (!config.openai.apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in .env');
    }
    openai = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openai;
}

/**
 * Extract audio from video file using ffmpeg.
 * Returns path to the extracted .mp3 file.
 */
function extractAudio(videoPath) {
  return new Promise((resolve, reject) => {
    const outputPath = videoPath.replace(path.extname(videoPath), '.mp3');

    const args = [
      '-i', videoPath,
      '-vn',                 // no video
      '-acodec', 'libmp3lame',
      '-ab', '128k',
      '-ar', '16000',        // 16kHz for Whisper
      '-y',                  // overwrite
      outputPath,
    ];

    execFile(config.ffmpegPath, args, { timeout: 600000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`FFmpeg audio extraction failed: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Split an audio file into chunks using ffmpeg.
 * Returns array of { path, startOffset } for each chunk.
 */
function splitAudio(audioPath, durationSecs) {
  const chunkCount = Math.ceil(durationSecs / CHUNK_DURATION_SECS);
  const chunks = [];
  const promises = [];

  for (let i = 0; i < chunkCount; i++) {
    const startOffset = i * CHUNK_DURATION_SECS;
    const chunkPath = audioPath.replace('.mp3', `_chunk${i}.mp3`);
    chunks.push({ path: chunkPath, startOffset });

    const promise = new Promise((resolve, reject) => {
      const args = [
        '-i', audioPath,
        '-ss', String(startOffset),
        '-t', String(CHUNK_DURATION_SECS),
        '-acodec', 'libmp3lame',
        '-ab', '128k',
        '-ar', '16000',
        '-y',
        chunkPath,
      ];

      execFile(config.ffmpegPath, args, { timeout: 120000 }, (error) => {
        if (error) {
          reject(new Error(`FFmpeg chunk split failed: ${error.message}`));
          return;
        }
        resolve();
      });
    });

    promises.push(promise);
  }

  return Promise.all(promises).then(() => chunks);
}

/**
 * Get video/audio duration in seconds using ffprobe.
 */
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobePath = config.ffmpegPath.replace('ffmpeg', 'ffprobe');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ];

    execFile(ffprobePath, args, { timeout: 30000 }, (error, stdout) => {
      if (error) {
        resolve(0);
        return;
      }
      const duration = parseFloat(stdout.trim());
      resolve(isNaN(duration) ? 0 : Math.round(duration));
    });
  });
}

/**
 * Transcribe a single audio file using OpenAI Whisper API.
 */
async function transcribeAudio(audioPath) {
  const client = getOpenAI();

  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  const segments = (response.segments || []).map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
  }));

  const timestampedText = segments
    .map((seg) => `[${formatTime(seg.start)} - ${formatTime(seg.end)}] ${seg.text}`)
    .join('\n');

  return {
    fullText: response.text,
    language: response.language || 'pt',
    segments,
    timestampedText,
  };
}

/**
 * Transcribe audio that exceeds Whisper's 25MB limit by splitting into chunks.
 * Timestamps are adjusted so they reflect the original video timeline.
 */
async function transcribeChunked(audioPath, durationSecs) {
  const chunks = await splitAudio(audioPath, durationSecs);

  const allSegments = [];
  const fullTexts = [];
  let language = 'pt';

  try {
    for (const chunk of chunks) {
      const result = await transcribeAudio(chunk.path);
      language = result.language;
      fullTexts.push(result.fullText);

      // Offset timestamps to match original timeline
      for (const seg of result.segments) {
        allSegments.push({
          start: seg.start + chunk.startOffset,
          end: seg.end + chunk.startOffset,
          text: seg.text,
        });
      }
    }
  } finally {
    // Clean up all chunk files
    for (const chunk of chunks) {
      try { fs.unlinkSync(chunk.path); } catch (_) {}
    }
  }

  const timestampedText = allSegments
    .map((seg) => `[${formatTime(seg.start)} - ${formatTime(seg.end)}] ${seg.text}`)
    .join('\n');

  return {
    fullText: fullTexts.join(' '),
    language,
    segments: allSegments,
    timestampedText,
  };
}

/**
 * Full pipeline: extract audio → check size → transcribe (chunked if needed) → return result.
 */
async function processTranscription(videoPath) {
  const audioPath = await extractAudio(videoPath);
  const duration = await getVideoDuration(videoPath);

  try {
    const audioSize = fs.statSync(audioPath).size;

    let result;
    if (audioSize > MAX_CHUNK_BYTES) {
      const audioDuration = await getVideoDuration(audioPath);
      result = await transcribeChunked(audioPath, audioDuration || duration);
    } else {
      result = await transcribeAudio(audioPath);
    }

    return { ...result, duration };
  } finally {
    // Clean up extracted audio
    try { fs.unlinkSync(audioPath); } catch (_) {}
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

module.exports = {
  extractAudio,
  getVideoDuration,
  transcribeAudio,
  processTranscription,
  formatTime,
};
