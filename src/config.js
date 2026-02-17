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

  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 1024,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  supportedFormats: ['.mp4', '.mov', '.avi', '.mkv'],
  storageBucket: 'videos',
};
