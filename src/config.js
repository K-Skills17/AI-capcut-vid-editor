require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 10,
  },

  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 3072,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  // Timeout for upload routes (default 30 minutes — needed for 3GB+ files on slow connections)
  uploadTimeoutMs: parseInt(process.env.UPLOAD_TIMEOUT_MS, 10) || 30 * 60 * 1000,

  // Files larger than this skip expensive re-encoding (speed ramps, vertical scaling)
  largeFileThresholdMB: parseInt(process.env.LARGE_FILE_THRESHOLD_MB, 10) || 1500,

  // Minimum free disk space required to start processing (MB)
  minFreeDiskMB: parseInt(process.env.MIN_FREE_DISK_MB, 10) || 2048,

  supportedFormats: ['.mp4', '.mov', '.avi', '.mkv'],
};
