const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const config = require('./config');
const apiRoutes = require('./routes/api');

const app = express();

// Ensure required directories exist
const uploadsDir = path.join(__dirname, '../uploads');
const reelsDir = path.join(__dirname, '../uploads/reels');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(reelsDir)) fs.mkdirSync(reelsDir, { recursive: true });

// Verify ffmpeg is available at startup
try {
  const version = execFileSync(config.ffmpegPath, ['-version'], { timeout: 5000, encoding: 'utf8' });
  const firstLine = version.split('\n')[0];
  console.log(`  FFmpeg: ${firstLine}`);
} catch (err) {
  console.error(`  WARNING: ffmpeg not found at "${config.ffmpegPath}". Video processing will fail.`);
  console.error(`  Install ffmpeg or set FFMPEG_PATH in .env`);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Health check (no dependencies — always responds)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api', apiRoutes);

// SPA fallback - serve index.html for non-API routes
app.get('*path', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Maximum size is ${config.maxFileSizeMB}MB.` });
  }

  if (err.message && err.message.includes('Unsupported format')) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  console.log(`\n  🎬 LK Digital Content Factory`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Server running on http://localhost:${config.port}`);
  console.log(`  Environment: ${config.nodeEnv}`);
  console.log(`  Max upload: ${config.maxFileSizeMB}MB`);
  console.log(`  Upload timeout: ${config.uploadTimeoutMs / 60000} min`);
  console.log(`  Supabase URL: ${config.supabase.url || '(not set)'}`);
  console.log(`  OpenAI: ${config.openai.apiKey ? 'configured' : 'NOT configured'}`);
  console.log(`  Anthropic: ${config.anthropic.apiKey ? 'configured' : 'NOT configured'}`);
  console.log(`  Google Drive: ${config.googleDrive.credentialsJson && config.googleDrive.folderId ? 'configured' : 'NOT configured (reels served locally)'}`);
  console.log();
});

// Allow long uploads — Node default is 2 min which kills 3GB transfers
server.timeout = config.uploadTimeoutMs;
server.keepAliveTimeout = config.uploadTimeoutMs;

module.exports = app;
