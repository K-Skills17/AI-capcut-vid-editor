/**
 * Google Drive uploader — uploads processed reels to a shared folder
 * and returns public share links for delivery via email.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let driveClient = null;

function isConfigured() {
  return !!(config.googleDrive.credentialsJson && config.googleDrive.folderId);
}

function getClient() {
  if (driveClient) return driveClient;

  let credentials;
  try {
    credentials = JSON.parse(config.googleDrive.credentialsJson);
  } catch {
    throw new Error('Invalid GOOGLE_CREDENTIALS_JSON — must be valid JSON');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Upload a single file to Google Drive.
 * @param {string} filePath - Local path to the file
 * @param {string} fileName - Name for the file in Drive
 * @returns {{ fileId: string, webViewLink: string, webContentLink: string }}
 */
async function uploadFile(filePath, fileName) {
  const drive = getClient();

  const fileMetadata = {
    name: fileName,
    parents: [config.googleDrive.folderId],
  };

  const media = {
    mimeType: 'video/mp4',
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, webViewLink, webContentLink',
  });

  // Make the file accessible to anyone with the link
  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink,
    webContentLink: response.data.webContentLink,
  };
}

/**
 * Upload all processed reels to Google Drive.
 * @param {object[]} reels - Array of reel results from videoProcessor
 * @param {string} videoId - Video ID for naming
 * @returns {object[]} Reels with driveLink added
 */
async function uploadReels(reels, videoId) {
  if (!isConfigured()) {
    console.log('[drive] Not configured — skipping upload. Set GOOGLE_CREDENTIALS_JSON and GOOGLE_DRIVE_FOLDER_ID');
    return reels;
  }

  const results = [];

  for (const reel of reels) {
    if (reel.status !== 'success' || !reel.outputPath) {
      results.push(reel);
      continue;
    }

    const fileName = `reel${reel.reelId}_${videoId}.mp4`;
    let uploaded = false;

    // Retry up to 3 times with exponential backoff for transient network errors
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[drive] Uploading ${fileName}... (attempt ${attempt})`);

        const driveResult = await uploadFile(reel.outputPath, fileName);

        results.push({
          ...reel,
          driveLink: driveResult.webViewLink,
          driveDownloadLink: driveResult.webContentLink,
          driveFileId: driveResult.fileId,
        });

        // Delete local file after successful upload to free disk
        try { fs.unlinkSync(reel.outputPath); } catch (_) {}
        console.log(`[drive] Uploaded ${fileName} -> ${driveResult.webViewLink}`);
        uploaded = true;
        break;
      } catch (err) {
        console.error(`[drive] Attempt ${attempt} failed for reel #${reel.reelId}:`, err.message);
        if (attempt < 3) {
          const waitMs = attempt * 2000;
          console.log(`[drive] Retrying in ${waitMs / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }

    if (!uploaded) {
      console.error(`[drive] All 3 attempts failed for reel #${reel.reelId} — keeping local file`);
      results.push({ ...reel, driveError: 'Upload failed after 3 attempts' });
    }
  }

  // Clean up the reels output directory if empty
  if (reels.length > 0 && reels[0].outputPath) {
    const dir = path.dirname(reels[0].outputPath);
    try {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) fs.rmdirSync(dir);
    } catch (_) {}
  }

  return results;
}

module.exports = { isConfigured, uploadFile, uploadReels };
