/**
 * Email service — sends processing results to user via SMTP.
 * Includes Google Drive links for reels and the cutting guide summary.
 */

const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;

function isConfigured() {
  return !!(config.email.user && config.email.pass);
}

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 465,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
  });

  return transporter;
}

/**
 * Send processing results email to user.
 * @param {object} params
 * @param {string} params.to - Recipient email
 * @param {string} params.videoId - Video ID
 * @param {string} params.originalName - Original file name
 * @param {string} params.videoType - Video type
 * @param {object[]} [params.reels] - Processed reels with Drive links
 * @param {string} [params.cuttingGuide] - Text cutting guide summary
 * @param {string} params.appUrl - Base URL for the app (for PDF link)
 */
async function sendResultsEmail({ to, videoId, originalName, videoType, reels, cuttingGuide, appUrl }) {
  if (!isConfigured()) {
    console.log('[email] Not configured — skipping. Set SMTP_USER and SMTP_PASS');
    return null;
  }

  if (!to) {
    console.log('[email] No recipient email provided — skipping');
    return null;
  }

  const transport = getTransporter();

  // Build reel links section
  let reelSection = '';
  if (reels && reels.length > 0) {
    const reelLinks = reels
      .filter((r) => r.status === 'success' && r.driveLink)
      .map((r) => `  - ${r.title || `Reel #${r.reelId}`}: ${r.driveLink}`)
      .join('\n');

    if (reelLinks) {
      reelSection = `
YOUR PROCESSED REELS (Google Drive):
${reelLinks}

`;
    }
  }

  // Trim the cutting guide for email (remove the <cut-data> JSON block)
  let guidePreview = '';
  if (cuttingGuide) {
    const cutIndex = cuttingGuide.indexOf('<cut-data>');
    const trimmed = cutIndex > 0 ? cuttingGuide.substring(0, cutIndex) : cuttingGuide;
    // Take first ~2000 chars for email
    guidePreview = trimmed.length > 2000 ? trimmed.substring(0, 2000) + '\n\n... (full guide available in app)' : trimmed;
  }

  const pdfLink = appUrl ? `${appUrl}/api/results/${videoId}/pdf` : '';

  const textBody = `
LK Digital Content Factory - Your Video Is Ready!

Video: ${originalName}
Type: ${videoType}
Video ID: ${videoId}

${reelSection}${pdfLink ? `DOWNLOAD FULL PDF GUIDE:\n${pdfLink}\n\n` : ''}CAPCUT CUTTING GUIDE PREVIEW:
${guidePreview}

---
Powered by LK Digital Content Factory
`.trim();

  // HTML version
  const reelHtml = reels && reels.length > 0
    ? reels
      .filter((r) => r.status === 'success' && r.driveLink)
      .map((r) => `<li><a href="${r.driveLink}">${r.title || `Reel #${r.reelId}`}</a> (${r.targetDuration || '?'}s)</li>`)
      .join('\n')
    : '';

  const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #6c5ce7;">Your Video Is Ready!</h1>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 8px; color: #666;">Video</td><td style="padding: 8px; font-weight: bold;">${originalName}</td></tr>
    <tr><td style="padding: 8px; color: #666;">Type</td><td style="padding: 8px;">${videoType}</td></tr>
  </table>

  ${reelHtml ? `
  <h2 style="color: #6c5ce7;">Your Processed Reels</h2>
  <ul>${reelHtml}</ul>
  <p style="color: #666; font-size: 13px;">Click any link to view/download from Google Drive.</p>
  ` : ''}

  ${pdfLink ? `<p><a href="${pdfLink}" style="display: inline-block; background: #6c5ce7; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Download PDF Cutting Guide</a></p>` : ''}

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="color: #999; font-size: 12px;">Powered by LK Digital Content Factory</p>
</div>
`.trim();

  const info = await transport.sendMail({
    from: config.email.from,
    to,
    subject: `Your CapCut guide is ready - ${originalName}`,
    text: textBody,
    html: htmlBody,
  });

  console.log(`[email] Sent results to ${to} (messageId: ${info.messageId})`);
  return info;
}

module.exports = { isConfigured, sendResultsEmail };
