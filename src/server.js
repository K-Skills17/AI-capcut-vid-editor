const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const apiRoutes = require('./routes/api');

const app = express();

// Ensure required directories exist
const uploadsDir = path.join(__dirname, '../uploads');
const tempDir = path.join(__dirname, '../temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

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
app.get('*', (req, res) => {
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

app.listen(config.port, () => {
  console.log(`\n  🎬 LK Digital Content Factory`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Server running on http://localhost:${config.port}`);
  console.log(`  Environment: ${config.nodeEnv}`);
  console.log(`  Supabase: ${config.supabase.url ? 'configured' : 'NOT configured'}`);
  console.log(`  OpenAI: ${config.openai.apiKey ? 'configured' : 'NOT configured'}`);
  console.log(`  Anthropic: ${config.anthropic.apiKey ? 'configured' : 'NOT configured'}`);
  console.log();
});

module.exports = app;
