const express = require('express');
const path = require('path');
const router = express.Router();
const upload = require('../middleware/upload');
const { apiLimiter } = require('../middleware/rateLimiter');
const pipeline = require('../services/pipeline');
const supabase = require('../services/supabase');
const analysis = require('../services/analysis');
const { generateGuidePDF } = require('../utils/pdfGenerator');

// In-memory status tracking for SSE (Server-Sent Events)
const statusMap = new Map();

// --- Upload & Process ---

router.post('/upload', apiLimiter, upload.single('video'), async (req, res) => {
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
      onStatus: (videoId, status, detail) => {
        statusMap.set(videoId, { status, detail, updatedAt: Date.now() });
      },
    });

    // Wait briefly for the video record to be created so we can return the ID
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

router.post('/upload-async', apiLimiter, upload.single('video'), async (req, res) => {
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
    statusMap.set(videoId, { status: 'uploaded', detail: 'Video received, starting processing...', updatedAt: Date.now() });

    // Return immediately
    res.json({ success: true, videoId });

    // Process in background (pipeline skips cloud upload, processes locally)
    const shouldAutoProcess = autoProcess === 'true' || autoProcess === true;
    pipeline.processVideo({
      localVideoPath: req.file.path,
      originalName: req.file.originalname,
      videoType,
      userEmail: userEmail || null,
      autoProcess: shouldAutoProcess,
      onStatus: (vid, status, detail) => {
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

    const doc = generateGuidePDF(analysisData.cutting_guide, {
      videoType: video.video_type,
      duration: video.duration,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="capcut-guide-${videoId}.pdf"`);
    doc.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Trigger Phase 2 automated processing ---

router.post('/process/:videoId', apiLimiter, async (req, res) => {
  try {
    const { videoId } = req.params;
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

    res.json({
      success: true,
      message: 'Automated processing data available',
      cutData,
      note: 'Use the cutData with the video processor to generate reels automatically.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
