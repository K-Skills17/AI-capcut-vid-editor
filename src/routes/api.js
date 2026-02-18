const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const upload = require('../middleware/upload');
const { apiLimiter } = require('../middleware/rateLimiter');
const pipeline = require('../services/pipeline');
const supabase = require('../services/supabase');
const analysis = require('../services/analysis');
const videoProcessor = require('../services/videoProcessor');
const driveUploader = require('../services/driveUploader');
const config = require('../config');
const { generateGuidePDF } = require('../utils/pdfGenerator');

// In-memory status tracking for SSE (Server-Sent Events)
const statusMap = new Map();

// Store processed reel results (Drive links) keyed by videoId
const reelsMap = new Map();

// TTL cleanup: remove entries older than 2 hours to prevent memory leaks
const STATUS_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of statusMap) {
    if (now - val.updatedAt > STATUS_TTL_MS) {
      statusMap.delete(key);
    }
  }
  for (const [key, val] of reelsMap) {
    if (now - (val._storedAt || 0) > STATUS_TTL_MS) {
      reelsMap.delete(key);
    }
  }
}, 10 * 60 * 1000); // check every 10 minutes

// Middleware: extend timeout for upload routes (default 30 min for large files)
function uploadTimeout(req, res, next) {
  req.setTimeout(config.uploadTimeoutMs);
  res.setTimeout(config.uploadTimeoutMs);
  next();
}

// --- Upload & Process ---

router.post('/upload', apiLimiter, uploadTimeout, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { videoType, userEmail, autoProcess } = req.body;
    if (!videoType) {
      return res.status(400).json({ error: 'videoType is required' });
    }

    const validTypes = ['wellness', 'testimonial', 'educational', 'product_demo', 'healthcare'];
    if (!validTypes.includes(videoType)) {
      return res.status(400).json({
        error: `Invalid videoType. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    const localVideoPath = req.file.path;
    const originalName = req.file.originalname;
    const shouldAutoProcess = autoProcess === 'true' || autoProcess === true;

    // Start processing in background
    const processingPromise = pipeline.processVideo({
      localVideoPath,
      originalName,
      videoType,
      userEmail: userEmail || null,
      autoProcess: shouldAutoProcess,
      onStatus: (videoId, status, detail, extra) => {
        // On completed: store reels BEFORE setting statusMap so SSE consumers
        // can fetch results immediately without a race condition
        if (status === 'completed' && extra?.processedReels) {
          extra.processedReels._storedAt = Date.now();
          reelsMap.set(videoId, extra.processedReels);
        }
        statusMap.set(videoId, { status, detail, updatedAt: Date.now() });
      },
    });

    // Wait for full processing to complete
    const result = await processingPromise;

    res.json({
      success: true,
      videoId: result.videoId,
      videoUrl: result.videoUrl,
      transcript: {
        fullText: result.transcript.fullText,
        language: result.transcript.language,
        segmentCount: result.transcript.segments.length,
      },
      analysis: {
        cuttingGuide: result.analysis.cuttingGuide,
        aiModelUsed: result.analysis.aiModelUsed,
      },
      processedReels: result.processedReels,
    });
  } catch (err) {
    console.error('Upload/process error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start processing asynchronously (returns immediately with video ID) ---

router.post('/upload-async', apiLimiter, uploadTimeout, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { videoType, userEmail, autoProcess } = req.body;
    if (!videoType) {
      return res.status(400).json({ error: 'videoType is required' });
    }

    const validTypes = ['wellness', 'testimonial', 'educational', 'product_demo', 'healthcare'];
    if (!validTypes.includes(videoType)) {
      return res.status(400).json({
        error: `Invalid videoType. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    // Create video record immediately (no cloud upload)
    const supabaseService = require('../services/supabase');
    const videoRecord = await supabaseService.createVideoRecord({
      videoUrl: req.file.originalname,
      videoType,
      userEmail: userEmail || null,
    });

    const videoId = videoRecord.id;
    statusMap.set(videoId, { status: 'uploading', detail: 'Video received, starting processing...', updatedAt: Date.now() });

    // Return immediately
    res.json({ success: true, videoId });

    // Process in background — pass existing videoId so pipeline doesn't create a duplicate
    const shouldAutoProcess = autoProcess === 'true' || autoProcess === true;
    pipeline.processVideo({
      localVideoPath: req.file.path,
      originalName: req.file.originalname,
      videoType,
      userEmail: userEmail || null,
      autoProcess: shouldAutoProcess,
      existingVideoId: videoId,
      onStatus: (vid, status, detail, extra) => {
        // On completed: store reels BEFORE setting statusMap so SSE consumers
        // can fetch results immediately without a race condition
        if (status === 'completed' && extra?.processedReels) {
          extra.processedReels._storedAt = Date.now();
          reelsMap.set(vid, extra.processedReels);
        }
        statusMap.set(vid, { status, detail, updatedAt: Date.now() });
      },
    }).catch((err) => {
      console.error(`Background processing error for ${videoId}:`, err);
      statusMap.set(videoId, { status: 'error', detail: err.message, updatedAt: Date.now() });
    });
  } catch (err) {
    console.error('Async upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Status check ---

router.get('/status/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    // Check in-memory first (for real-time updates)
    const memStatus = statusMap.get(videoId);
    if (memStatus) {
      return res.json({ videoId, ...memStatus });
    }

    // Fall back to database
    const video = await supabase.getVideo(videoId);
    res.json({ videoId, status: video.status, detail: null, updatedAt: video.created_at });
  } catch (err) {
    res.status(404).json({ error: 'Video not found' });
  }
});

// --- SSE for real-time status ---

router.get('/status/:videoId/stream', (req, res) => {
  const { videoId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const interval = setInterval(() => {
    const status = statusMap.get(videoId);
    if (status) {
      res.write(`data: ${JSON.stringify({ videoId, ...status })}\n\n`);
      if (status.status === 'completed' || status.status === 'error') {
        clearInterval(interval);
        res.end();
      }
    }
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

// --- Get results ---

router.get('/results/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const video = await supabase.getVideo(videoId);
    const transcript = await supabase.getTranscript(videoId);
    const analysisData = await supabase.getAnalysis(videoId);

    if (!analysisData) {
      return res.status(404).json({ error: 'Analysis not yet available' });
    }

    // Parse structured cut data for Phase 2
    const cutData = analysis.parseCutData(analysisData.cutting_guide);

    // Include processed reel links if available
    const reels = reelsMap.get(videoId) || null;

    res.json({
      video: {
        id: video.id,
        type: video.video_type,
        duration: video.duration,
        status: video.status,
        url: video.video_url,
      },
      transcript: transcript ? {
        fullText: transcript.full_text,
        segments: transcript.timestamped_json,
        language: transcript.language,
      } : null,
      analysis: {
        cuttingGuide: analysisData.cutting_guide,
        reelCount: analysisData.reel_count,
        aiModelUsed: analysisData.ai_model_used,
        cutData,
      },
      processedReels: reels,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Download PDF ---

router.get('/results/:videoId/pdf', async (req, res) => {
  try {
    const { videoId } = req.params;
    const video = await supabase.getVideo(videoId);
    const analysisData = await supabase.getAnalysis(videoId);

    if (!analysisData) {
      return res.status(404).json({ error: 'Analysis not yet available' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="capcut-guide-${videoId}.pdf"`);

    // Pass res as outputStream so pipe happens before content is written
    generateGuidePDF(analysisData.cutting_guide, {
      videoType: video.video_type,
      duration: video.duration,
    }, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Trigger Phase 2 automated processing ---

router.post('/process/:videoId', apiLimiter, async (req, res) => {
  try {
    const { videoId } = req.params;
    const video = await supabase.getVideo(videoId);
    const analysisData = await supabase.getAnalysis(videoId);

    if (!analysisData) {
      return res.status(404).json({ error: 'Analysis not available. Process the video first.' });
    }

    const cutData = analysis.parseCutData(analysisData.cutting_guide);
    if (!cutData) {
      return res.status(400).json({
        error: 'No structured cut data found in analysis. Re-run analysis to generate machine-readable data.',
      });
    }

    // Check if a local video file still exists for this videoId
    const uploadsDir = path.join(__dirname, '../../uploads');
    const possibleExts = ['.mp4', '.mov', '.avi', '.mkv'];
    let localVideoPath = null;

    // Search uploads dir for a file matching this video's original name or UUID
    try {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (possibleExts.includes(ext)) {
          const fullPath = path.join(uploadsDir, file);
          // Check if file is associated with this video (match by stat time or name)
          if (file.includes(videoId)) {
            localVideoPath = fullPath;
            break;
          }
        }
      }
    } catch (_) {}

    if (!localVideoPath) {
      // No local file — return cut data only (original file was cleaned up)
      return res.json({
        success: true,
        message: 'Cut data available but original video has been cleaned up. Re-upload to process reels.',
        cutData,
        reprocessable: false,
      });
    }

    // Actually trigger Phase 2 processing
    const reelsOutputDir = path.join(uploadsDir, 'reels', videoId);
    await supabase.updateVideoStatus(videoId, 'processing');
    statusMap.set(videoId, { status: 'processing', detail: 'Cutting reels with FFmpeg...', updatedAt: Date.now() });

    const processedReels = await videoProcessor.processAllReels(
      localVideoPath,
      cutData,
      reelsOutputDir,
      { scaleVertical: true, skipExpensiveOps: false }
    );

    const successCount = processedReels.filter((r) => r.status === 'success').length;

    // Upload to Drive if configured
    let finalReels = processedReels;
    if (driveUploader.isConfigured() && successCount > 0) {
      finalReels = await driveUploader.uploadReels(processedReels, videoId);
    } else if (successCount > 0) {
      // Add local URLs for serving
      finalReels = processedReels.map((reel) => {
        if (reel.status !== 'success' || !reel.outputPath) return reel;
        return {
          ...reel,
          localUrl: `/api/reels/${videoId}/${path.basename(reel.outputPath)}`,
        };
      });
    }

    finalReels._storedAt = Date.now();
    reelsMap.set(videoId, finalReels);
    await supabase.updateVideoStatus(videoId, 'completed');
    statusMap.set(videoId, { status: 'completed', detail: `Created ${successCount} reel(s)`, updatedAt: Date.now() });

    res.json({
      success: true,
      message: `Processed ${successCount} reel(s)`,
      cutData,
      processedReels: finalReels,
      reprocessable: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Serve locally-stored reels (when Google Drive is not configured) ---

router.get('/reels/:videoId/:filename', (req, res) => {
  const { videoId, filename } = req.params;

  // Sanitize filename to prevent path traversal
  const safeName = path.basename(filename);
  const filePath = path.join(__dirname, '../../uploads/reels', videoId, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Reel not found' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// --- Analytics ---

router.get('/analytics', async (req, res) => {
  try {
    const stats = await supabase.getAnalytics();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
