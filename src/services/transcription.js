const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const config = require('../config');

let openai = null;

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

    execFile(config.ffmpegPath, args, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`FFmpeg audio extraction failed: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Get video duration in seconds using ffprobe.
 */
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobePath = config.ffmpegPath.replace('ffmpeg', 'ffprobe');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ];

    execFile(ffprobePath, args, { timeout: 30000 }, (error, stdout) => {
      if (error) {
        // Fallback: return 0 if ffprobe fails
        resolve(0);
        return;
      }
      const duration = parseFloat(stdout.trim());
      resolve(isNaN(duration) ? 0 : Math.round(duration));
    });
  });
}

/**
 * Transcribe audio using OpenAI Whisper API.
 * Returns { text, segments } with timestamped data.
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

  // Build formatted timestamped transcript
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
 * Full pipeline: extract audio → transcribe → return structured result.
 */
async function processTranscription(videoPath) {
  const audioPath = await extractAudio(videoPath);
  const duration = await getVideoDuration(videoPath);

  try {
    const result = await transcribeAudio(audioPath);
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
