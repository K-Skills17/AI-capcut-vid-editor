const rateLimit = require('express-rate-limit');
const config = require('../config');

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    error: 'Too many requests. Please try again later.',
    retryAfterMs: config.rateLimit.windowMs,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { apiLimiter };
