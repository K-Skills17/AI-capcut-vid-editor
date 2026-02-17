/**
 * Phase 2: Automated Video Processing Pipeline
 *
 * This module handles fully automated video cutting using ffmpeg,
 * driven by the structured cut-data from the AI analysis.
 * No human intervention needed — the AI's cutting instructions
 * are executed programmatically.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');

/**
 * Cut a single segment from a video.
 * @param {string} inputPath - Path to source video
 * @param {number} startSec - Start time in seconds
 * @param {number} endSec - End time in seconds
 * @param {string} outputPath - Path for output segment
 */
function cutSegment(inputPath, startSec, endSec, outputPath) {
  return new Promise((resolve, reject) => {
    const duration = endSec - startSec;
    const args = [
      '-ss', String(startSec),
      '-i', inputPath,
      '-t', String(duration),
      '-c', 'copy',        // fast copy without re-encoding
      '-y',
      outputPath,
    ];

    execFile(config.ffmpegPath, args, { timeout: 120000 }, (error) => {
      if (error) {
        reject(new Error(`Failed to cut segment ${startSec}-${endSec}: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Concatenate multiple video segments into a single file.
 * @param {string[]} segmentPaths - Ordered list of segment file paths
 * @param {string} outputPath - Path for the final concatenated video
 */
function concatenateSegments(segmentPaths, outputPath) {
  return new Promise((resolve, reject) => {
    // Create a concat list file for ffmpeg
    const listPath = outputPath + '.txt';
    const listContent = segmentPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y',
      outputPath,
    ];

    execFile(config.ffmpegPath, args, { timeout: 300000 }, (error) => {
      // Clean up list file
      try { fs.unlinkSync(listPath); } catch (_) {}

      if (error) {
        reject(new Error(`Failed to concatenate segments: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Apply speed ramp to a video segment.
 * @param {string} inputPath - Input video path
 * @param {number} speed - Speed multiplier (e.g. 1.5 for 1.5x)
 * @param {string} outputPath - Output video path
 */
function applySpeedRamp(inputPath, speed, outputPath) {
  return new Promise((resolve, reject) => {
    const videoFilter = `setpts=${(1 / speed).toFixed(4)}*PTS`;
    const audioFilter = `atempo=${speed}`;

    const args = [
      '-i', inputPath,
      '-filter:v', videoFilter,
      '-filter:a', audioFilter,
      '-y',
      outputPath,
    ];

    execFile(config.ffmpegPath, args, { timeout: 300000 }, (error) => {
      if (error) {
        reject(new Error(`Failed to apply speed ramp: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Scale video to vertical format (9:16) for Reels/TikTok.
 * @param {string} inputPath - Input video path
 * @param {string} outputPath - Output video path
 */
function scaleToVertical(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
      '-c:a', 'copy',
      '-y',
      outputPath,
    ];

    execFile(config.ffmpegPath, args, { timeout: 300000 }, (error) => {
      if (error) {
        reject(new Error(`Failed to scale video: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Process a single reel: cut segments, concatenate, and optionally scale.
 * @param {string} inputVideoPath - Path to original video
 * @param {object} reelData - Structured reel data from AI analysis
 * @param {string} outputDir - Directory for output files
 * @param {object} options - Processing options
 * @returns {object} Result with outputPath and metadata
 */
async function processReel(inputVideoPath, reelData, outputDir, options = {}) {
  const { scaleVertical = false } = options;
  const reelId = reelData.id || 1;
  const segments = reelData.segments || [];

  if (segments.length === 0) {
    throw new Error(`Reel #${reelId} has no segments to process`);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Cut each segment
  const segmentPaths = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(outputDir, `reel${reelId}_seg${i}.mp4`);
    await cutSegment(inputVideoPath, seg.start, seg.end, segPath);
    segmentPaths.push(segPath);
  }

  // Step 2: Concatenate segments
  const concatPath = path.join(outputDir, `reel${reelId}_concat.mp4`);
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], concatPath);
  } else {
    await concatenateSegments(segmentPaths, concatPath);
  }

  // Step 3: Apply speed ramps if specified
  let currentPath = concatPath;
  const speedRamps = reelData.effects?.speed_ramps || [];
  if (speedRamps.length > 0) {
    // Apply first speed ramp to whole clip (simplified; per-segment ramps need more complex pipeline)
    const speedPath = path.join(outputDir, `reel${reelId}_speed.mp4`);
    await applySpeedRamp(currentPath, speedRamps[0].speed, speedPath);
    currentPath = speedPath;
  }

  // Step 4: Scale to vertical if requested
  if (scaleVertical) {
    const verticalPath = path.join(outputDir, `reel${reelId}_vertical.mp4`);
    await scaleToVertical(currentPath, verticalPath);
    currentPath = verticalPath;
  }

  // Step 5: Final output
  const finalPath = path.join(outputDir, `reel${reelId}_final.mp4`);
  if (currentPath !== finalPath) {
    fs.copyFileSync(currentPath, finalPath);
  }

  // Clean up intermediate files
  const intermediateFiles = [...segmentPaths, concatPath];
  if (currentPath !== concatPath && currentPath !== finalPath) {
    intermediateFiles.push(currentPath);
  }
  for (const f of intermediateFiles) {
    try { if (f !== finalPath) fs.unlinkSync(f); } catch (_) {}
  }

  return {
    reelId,
    title: reelData.title,
    outputPath: finalPath,
    targetDuration: reelData.target_duration_seconds,
    segmentCount: segments.length,
  };
}

/**
 * Process all reels from AI analysis cut data.
 * This is the main Phase 2 entry point.
 *
 * @param {string} inputVideoPath - Path to original video
 * @param {object} cutData - Parsed cut data from AI analysis
 * @param {string} outputDir - Directory for output files
 * @param {object} options - Processing options
 * @returns {object[]} Array of results per reel
 */
async function processAllReels(inputVideoPath, cutData, outputDir, options = {}) {
  if (!cutData || !cutData.reels || cutData.reels.length === 0) {
    throw new Error('No cut data available for automated processing');
  }

  const results = [];

  for (const reel of cutData.reels) {
    try {
      const result = await processReel(inputVideoPath, reel, outputDir, options);
      results.push({ ...result, status: 'success' });
    } catch (err) {
      results.push({
        reelId: reel.id,
        title: reel.title,
        status: 'error',
        error: err.message,
      });
    }
  }

  return results;
}

module.exports = {
  cutSegment,
  concatenateSegments,
  applySpeedRamp,
  scaleToVertical,
  processReel,
  processAllReels,
};
