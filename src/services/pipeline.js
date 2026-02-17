/**
 * Orchestration pipeline: ties together upload → transcription → analysis → (optional) automated cutting.
 * Single entry point for the full processing workflow.
 */

const path = require('path');
const fs = require('fs');
const supabase = require('./supabase');
const transcription = require('./transcription');
const analysis = require('./analysis');
const videoProcessor = require('./videoProcessor');

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
  onStatus,
}) {
  let videoId = null;

  const notify = (status, detail) => {
    if (onStatus && videoId) onStatus(videoId, status, detail);
  };

  try {
    // 1. Upload to Supabase Storage
    const { publicUrl } = await supabase.uploadVideo(localVideoPath, originalName);

    // 2. Create video record
    const videoRecord = await supabase.createVideoRecord({
      videoUrl: publicUrl,
      videoType,
      userEmail,
    });
    videoId = videoRecord.id;
    notify('uploaded', 'Video uploaded to storage');

    // 3. Transcribe
    await supabase.updateVideoStatus(videoId, 'transcribing');
    notify('transcribing', 'Extracting audio and transcribing...');

    const transcriptResult = await transcription.processTranscription(localVideoPath);

    // Update duration
    if (transcriptResult.duration) {
      const client = supabase.getClient();
      await client.from('videos').update({ duration: transcriptResult.duration }).eq('id', videoId);
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
      notify('processing', 'Automatically cutting video into reels...');

      const cutData = analysis.parseCutData(analysisResult.cuttingGuide);
      if (cutData) {
        const outputDir = path.join(path.dirname(localVideoPath), `reels_${videoId}`);
        processedReels = await videoProcessor.processAllReels(
          localVideoPath,
          cutData,
          outputDir,
          { scaleVertical: true }
        );
        notify('processed', `Created ${processedReels.filter((r) => r.status === 'success').length} reel(s)`);
      } else {
        notify('process_skipped', 'Could not parse cut data for automated processing');
      }
    }

    // 6. Mark completed
    await supabase.updateVideoStatus(videoId, 'completed');
    notify('completed', 'All processing complete');

    // Clean up local video file
    try { fs.unlinkSync(localVideoPath); } catch (_) {}

    return {
      videoId,
      videoUrl: publicUrl,
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
    };
  } catch (err) {
    // Update status to error
    if (videoId) {
      try {
        await supabase.updateVideoStatus(videoId, 'error');
        notify('error', err.message);
      } catch (_) {}
    }

    // Clean up local file on error
    try { fs.unlinkSync(localVideoPath); } catch (_) {}

    throw err;
  }
}

module.exports = { processVideo };
