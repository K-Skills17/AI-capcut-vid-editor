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

  const notify = (status, detail, extra) => {
    if (onStatus && videoId) onStatus(videoId, status, detail, extra);
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

    // Update duration in database (or in-memory store)
    if (transcriptResult.duration) {
      const client = supabase.getClient();
      if (client) {
        await client.from('videos').update({ duration: transcriptResult.duration }).eq('id', videoId);
      } else {
        // In-memory mode: update the record directly
        try {
          const video = await supabase.getVideo(videoId);
          if (video) video.duration = transcriptResult.duration;
        } catch (_) {}
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
        console.log(`[pipeline] Cut data parsed: ${cutData.reels.length} reel(s) with segments:`,
          cutData.reels.map((r) => `Reel #${r.id}: ${r.segments?.length || 0} segments`).join(', '));

        // Verify video file still exists before attempting cuts
        if (!fs.existsSync(localVideoPath)) {
          throw new Error(`Video file missing before ffmpeg cuts: ${localVideoPath}`);
        }

        reelsOutputDir = path.join(path.dirname(localVideoPath), `reels_${videoId}`);
        console.log(`[pipeline] Starting ffmpeg cuts: input=${localVideoPath}, output=${reelsOutputDir}`);

        processedReels = await videoProcessor.processAllReels(
          localVideoPath,
          cutData,
          reelsOutputDir,
          { scaleVertical: true, skipExpensiveOps: isLargeFile }
        );

        const successCount = processedReels.filter((r) => r.status === 'success').length;
        const errorCount = processedReels.filter((r) => r.status === 'error').length;
        console.log(`[pipeline] FFmpeg results: ${successCount} success, ${errorCount} errors`);
        if (errorCount > 0) {
          processedReels.filter((r) => r.status === 'error').forEach((r) => {
            console.error(`[pipeline] Reel #${r.reelId} failed: ${r.error}`);
          });
        }
        notify('processed', `Created ${successCount} reel(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}`);

        // 5b. Upload reels to Google Drive (frees local disk)
        if (driveUploader.isConfigured() && successCount > 0) {
          notify('uploading_drive', 'Uploading reels to Google Drive...');
          processedReels = await driveUploader.uploadReels(processedReels, videoId);
          const uploadedCount = processedReels.filter((r) => r.driveLink).length;
          const failedDriveCount = processedReels.filter((r) => r.driveError).length;

          if (uploadedCount > 0) {
            notify('uploaded_drive', `Uploaded ${uploadedCount} reel(s) to Google Drive${failedDriveCount > 0 ? ` (${failedDriveCount} failed)` : ''}`);
          }

          // For reels that failed Drive upload, fall back to local serving
          if (failedDriveCount > 0) {
            console.warn(`[pipeline] ${failedDriveCount} reel(s) failed Drive upload — falling back to local serving`);
            const servableDir = path.join(__dirname, '../../uploads/reels', videoId);
            if (!fs.existsSync(servableDir)) {
              fs.mkdirSync(servableDir, { recursive: true });
            }
            processedReels = processedReels.map((reel) => {
              if (!reel.driveError || !reel.outputPath || !fs.existsSync(reel.outputPath)) return reel;
              try {
                const destPath = path.join(servableDir, path.basename(reel.outputPath));
                fs.renameSync(reel.outputPath, destPath);
                return {
                  ...reel,
                  outputPath: destPath,
                  localUrl: `/api/reels/${videoId}/${path.basename(reel.outputPath)}`,
                };
              } catch (moveErr) {
                console.error(`[pipeline] Failed to move reel #${reel.reelId} to servable dir:`, moveErr.message);
                return reel;
              }
            });
          }

          // Clean up reels directory after Drive upload
          cleanupDir(reelsOutputDir);
          reelsOutputDir = null;
        } else if (!driveUploader.isConfigured() && successCount > 0) {
          // Move reels to a persistent servable directory (/uploads/reels/<videoId>/)
          const servableDir = path.join(__dirname, '../../uploads/reels', videoId);
          if (!fs.existsSync(servableDir)) {
            fs.mkdirSync(servableDir, { recursive: true });
          }

          processedReels = processedReels.map((reel) => {
            if (reel.status !== 'success' || !reel.outputPath) return reel;
            try {
              const destPath = path.join(servableDir, path.basename(reel.outputPath));
              fs.renameSync(reel.outputPath, destPath);
              return {
                ...reel,
                outputPath: destPath,
                localUrl: `/api/reels/${videoId}/${path.basename(reel.outputPath)}`,
              };
            } catch (moveErr) {
              console.error(`[pipeline] Failed to move reel #${reel.reelId}:`, moveErr.message);
              return reel;
            }
          });

          // Clean up now-empty temp reels dir
          cleanupDir(reelsOutputDir);
          reelsOutputDir = null;
          console.log(`[pipeline] Google Drive not configured — reels served locally at /api/reels/${videoId}/`);
        }
      } else {
        console.error('[pipeline] parseCutData returned null — autocut skipped. AI output may not contain structured cut data.');
        notify('process_skipped', 'Could not parse cut data from AI output — try re-processing');
      }
    } else {
      console.log('[pipeline] autoProcess=false — skipping Phase 2 cuts');
    }

    // 6. Mark completed — pass reels in notify so caller stores them
    // BEFORE statusMap is set to 'completed' (prevents SSE race condition)
    await supabase.updateVideoStatus(videoId, 'completed');
    notify('completed', 'All processing complete', { processedReels });

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
