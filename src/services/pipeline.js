/**
 * Orchestration pipeline: ties together upload → transcription → analysis → (optional) automated cutting.
 * Single entry point for the full processing workflow.
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../config');
const supabase = require('./supabase');
const transcription = require('./transcription');
const analysis = require('./analysis');
const videoProcessor = require('./videoProcessor');
const driveUploader = require('./driveUploader');
const emailService = require('./emailService');

/**
 * Get available disk space in MB for the given path.
 */
function getFreeDiskMB(dirPath) {
  try {
    // df outputs 1K blocks available
    const output = execSync(`df -k "${path.dirname(dirPath)}" | tail -1`, { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    return Math.floor(availKB / 1024);
  } catch {
    return Infinity; // can't check — don't block processing
  }
}

/**
 * Recursively remove a directory and its contents.
 */
function cleanupDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_) {}
}

/**
 * Process a video through the full pipeline.
 *
 * @param {object} params
 * @param {string} params.localVideoPath - Path to the uploaded video file on disk
 * @param {string} params.originalName - Original file name
 * @param {string} params.videoType - Content type (wellness, testimonial, etc.)
 * @param {string} [params.userEmail] - Optional user email
 * @param {boolean} [params.autoProcess] - If true, run Phase 2 automated cutting
 * @param {function} [params.onStatus] - Callback for status updates: (videoId, status, detail) => void
 * @returns {object} Full result with video record, transcript, analysis, and optional processed files
 */
async function processVideo({
  localVideoPath,
  originalName,
  videoType,
  userEmail,
  autoProcess = false,
  existingVideoId = null,
  onStatus,
}) {
  let videoId = existingVideoId;
  let reelsOutputDir = null;

  const notify = (status, detail) => {
    if (onStatus && videoId) onStatus(videoId, status, detail);
  };

  try {
    // 0. Check disk space before processing
    const fileSizeMB = Math.ceil(fs.statSync(localVideoPath).size / (1024 * 1024));
    const freeDiskMB = getFreeDiskMB(localVideoPath);
    // Need ~3x file size for intermediates (audio + segments + reels)
    const requiredMB = Math.max(config.minFreeDiskMB, fileSizeMB * 3);

    if (freeDiskMB < requiredMB) {
      throw new Error(
        `Insufficient disk space: ${freeDiskMB}MB available, ~${requiredMB}MB required ` +
        `for a ${fileSizeMB}MB video. Free up space or reduce file size.`
      );
    }

    const isLargeFile = fileSizeMB > config.largeFileThresholdMB;
    if (isLargeFile) {
      console.log(`  Large file detected (${fileSizeMB}MB > ${config.largeFileThresholdMB}MB threshold) — skipping expensive re-encoding`);
    }

    // 1. Create video record if not already created (async route pre-creates it)
    if (!videoId) {
      const videoRecord = await supabase.createVideoRecord({
        videoUrl: originalName,
        videoType,
        userEmail,
      });
      videoId = videoRecord.id;
    }
    notify('uploading', `Video received (${fileSizeMB}MB), starting processing`);

    // 3. Transcribe
    await supabase.updateVideoStatus(videoId, 'transcribing');
    notify('transcribing', 'Extracting audio and transcribing...');

    const transcriptResult = await transcription.processTranscription(localVideoPath);

    // Update duration
    if (transcriptResult.duration) {
      const client = supabase.getClient();
      if (client) {
        await client.from('videos').update({ duration: transcriptResult.duration }).eq('id', videoId);
      }
    }

    const transcript = await supabase.saveTranscript({
      videoId,
      fullText: transcriptResult.fullText,
      timestampedJson: transcriptResult.segments,
      language: transcriptResult.language,
    });
    notify('transcribed', 'Transcription complete');

    // 4. AI Analysis
    await supabase.updateVideoStatus(videoId, 'analyzing');
    notify('analyzing', 'AI is generating CapCut cutting guide...');

    const analysisResult = await analysis.analyzeTranscript({
      videoType,
      duration: transcriptResult.duration,
      timestampedTranscript: transcriptResult.timestampedText,
    });

    const savedAnalysis = await supabase.saveAnalysis({
      videoId,
      cuttingGuide: analysisResult.cuttingGuide,
      reelCount: 3,
      aiModelUsed: analysisResult.aiModelUsed,
    });
    notify('analyzed', 'AI analysis complete');

    // 5. Phase 2: Automated cutting (if enabled)
    let processedReels = null;
    if (autoProcess) {
      await supabase.updateVideoStatus(videoId, 'processing');
      const modeNote = isLargeFile ? ' (large-file mode: skip re-encoding)' : '';
      notify('processing', `Automatically cutting video into reels...${modeNote}`);

      const cutData = analysis.parseCutData(analysisResult.cuttingGuide);
      if (cutData) {
        reelsOutputDir = path.join(path.dirname(localVideoPath), `reels_${videoId}`);
        processedReels = await videoProcessor.processAllReels(
          localVideoPath,
          cutData,
          reelsOutputDir,
          { scaleVertical: true, skipExpensiveOps: isLargeFile }
        );
        const successCount = processedReels.filter((r) => r.status === 'success').length;
        notify('processed', `Created ${successCount} reel(s)`);

        // 5b. Upload reels to Google Drive (frees local disk)
        if (driveUploader.isConfigured() && successCount > 0) {
          notify('uploading_drive', 'Uploading reels to Google Drive...');
          processedReels = await driveUploader.uploadReels(processedReels, videoId);
          const uploadedCount = processedReels.filter((r) => r.driveLink).length;
          notify('uploaded_drive', `Uploaded ${uploadedCount} reel(s) to Google Drive`);
        }
      } else {
        notify('process_skipped', 'Could not parse cut data for automated processing');
      }
    }

    // 6. Mark completed
    await supabase.updateVideoStatus(videoId, 'completed');
    notify('completed', 'All processing complete');

    // Clean up local video file and temp artifacts
    try { fs.unlinkSync(localVideoPath); } catch (_) {}

    // 7. Email results to user (non-blocking — don't fail the pipeline if email fails)
    if (userEmail) {
      try {
        const appUrl = process.env.APP_URL || `http://localhost:${config.port}`;
        await emailService.sendResultsEmail({
          to: userEmail,
          videoId,
          originalName,
          videoType,
          reels: processedReels,
          cuttingGuide: analysisResult.cuttingGuide,
          appUrl,
        });
      } catch (emailErr) {
        console.error('[pipeline] Email send failed (non-fatal):', emailErr.message);
      }
    }

    return {
      videoId,
      videoUrl: originalName,
      transcript: {
        fullText: transcriptResult.fullText,
        segments: transcriptResult.segments,
        language: transcriptResult.language,
      },
      analysis: {
        cuttingGuide: analysisResult.cuttingGuide,
        aiModelUsed: analysisResult.aiModelUsed,
      },
      processedReels,
      largeFileMode: isLargeFile,
    };
  } catch (err) {
    // Update status to error
    if (videoId) {
      try {
        await supabase.updateVideoStatus(videoId, 'error');
        notify('error', err.message);
      } catch (_) {}
    }

    // Clean up all temp files on error
    try { fs.unlinkSync(localVideoPath); } catch (_) {}
    if (reelsOutputDir) cleanupDir(reelsOutputDir);

    // Also clean any leftover .mp3 audio from transcription
    const audioPath = localVideoPath.replace(path.extname(localVideoPath), '.mp3');
    try { fs.unlinkSync(audioPath); } catch (_) {}

    throw err;
  }
}

module.exports = { processVideo };
