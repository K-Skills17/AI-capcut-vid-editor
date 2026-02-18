/* ═══════════════════════════════════════════════
   LK Digital Content Factory - Frontend App
   ═══════════════════════════════════════════════ */

(function () {
  'use strict';

  // --- State ---
  let selectedFile = null;
  let currentVideoId = null;
  let statusEventSource = null;

  // --- DOM Elements ---
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileSize = document.getElementById('fileSize');
  const removeFileBtn = document.getElementById('removeFile');
  const videoTypeSelect = document.getElementById('videoType');
  const emailInput = document.getElementById('userEmail');
  const autoProcessCheck = document.getElementById('autoProcess');
  const submitBtn = document.getElementById('submitBtn');

  const uploadSection = document.getElementById('uploadSection');
  const progressSection = document.getElementById('progressSection');
  const resultsSection = document.getElementById('resultsSection');

  const progressBar = document.getElementById('progressBar');
  const statusDetail = document.getElementById('statusDetail');
  const statusSteps = document.querySelectorAll('.status-steps li');

  const resultsContent = document.getElementById('resultsContent');
  const downloadPdfBtn = document.getElementById('downloadPdf');
  const processAnotherBtn = document.getElementById('processAnother');

  // --- Upload Zone Events ---

  uploadZone.addEventListener('click', () => fileInput.click());

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFile(files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
  });

  removeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearFile();
  });

  // --- File Handling ---

  function handleFile(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    const validExts = ['.mp4', '.mov', '.avi', '.mkv'];

    if (!validExts.includes(ext)) {
      showToast(`Unsupported format: ${ext}. Use MP4, MOV, AVI, or MKV.`, 'error');
      return;
    }

    if (file.size > 3072 * 1024 * 1024) {
      showToast('File too large. Maximum size is 3GB.', 'error');
      return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileInfo.classList.add('visible');
    uploadZone.classList.add('has-file');
    updateSubmitState();
  }

  function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.classList.remove('visible');
    uploadZone.classList.remove('has-file');
    updateSubmitState();
  }

  function updateSubmitState() {
    submitBtn.disabled = !selectedFile || !videoTypeSelect.value;
  }

  videoTypeSelect.addEventListener('change', updateSubmitState);

  // --- Submit (async upload — returns immediately, then SSE tracks progress) ---

  submitBtn.addEventListener('click', async () => {
    if (!selectedFile || !videoTypeSelect.value) return;

    const formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('videoType', videoTypeSelect.value);
    formData.append('autoProcess', autoProcessCheck.checked ? 'true' : 'false');
    if (emailInput.value.trim()) {
      formData.append('userEmail', emailInput.value.trim());
    }

    // Switch to progress view
    showSection('progress');
    setProgress(2);
    setStepActive(0, 'Uploading video to server...');

    try {
      // Upload file with progress, get videoId immediately
      const result = await uploadWithProgress(formData);

      if (result.error) {
        throw new Error(result.error);
      }

      currentVideoId = result.videoId;

      // File is on the server — mark step 0 done, start polling
      setStepDone(0);
      setProgress(20);
      setDetail('Video received, starting processing...');

      // Start SSE polling for real-time status updates
      pollStatus(result.videoId);
    } catch (err) {
      showToast(err.message || 'Upload failed. Please try again.', 'error');
      setStepError(0);
    }
  });

  function uploadWithProgress(formData) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 18) + 2;
          setProgress(pct);
          setDetail(`Uploading... ${Math.round((e.loaded / e.total) * 100)}%`);
        }
      });

      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 400) {
            reject(new Error(data.error || 'Upload failed'));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error('Invalid response from server'));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));

      // Use async endpoint — returns videoId immediately, processes in background
      xhr.open('POST', '/api/upload-async');
      xhr.timeout = 1800000; // 30 min timeout for large files
      xhr.send(formData);
    });
  }

  // --- Status Polling via SSE ---

  function pollStatus(videoId) {
    // Try SSE first
    if (typeof EventSource !== 'undefined') {
      statusEventSource = new EventSource(`/api/status/${videoId}/stream`);

      statusEventSource.addEventListener('message', (e) => {
        const data = JSON.parse(e.data);
        handleStatusUpdate(data);
      });

      statusEventSource.addEventListener('error', () => {
        statusEventSource.close();
        // Fallback to polling
        fallbackPoll(videoId);
      });
    } else {
      fallbackPoll(videoId);
    }
  }

  function fallbackPoll(videoId) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${videoId}`);
        const data = await res.json();
        handleStatusUpdate(data);

        if (data.status === 'completed' || data.status === 'error') {
          clearInterval(interval);
        }
      } catch {
        // Keep polling
      }
    }, 2000);
  }

  // Step indices: 0=upload, 1=transcribe, 2=analyze, 3=ffmpeg, 4=drive, 5=done

  function handleStatusUpdate(data) {
    const detail = data.detail || '';

    switch (data.status) {
      case 'uploading':
        setStepDone(0);
        setProgress(22);
        setDetail(detail);
        break;
      case 'transcribing':
        setStepDone(0);
        setStepActive(1, detail || 'Extracting audio and transcribing...');
        setProgress(30);
        break;
      case 'transcribed':
        setStepDone(1);
        setProgress(48);
        setDetail(detail || 'Transcription complete');
        break;
      case 'analyzing':
        setStepDone(1);
        setStepActive(2, detail || 'AI generating CapCut cutting guide...');
        setProgress(55);
        break;
      case 'analyzed':
        setStepDone(2);
        setProgress(70);
        setDetail(detail || 'AI analysis complete');
        break;
      case 'processing':
        setStepDone(2);
        setStepActive(3, detail || 'Cutting reels with FFmpeg...');
        setProgress(75);
        break;
      case 'processed':
        setStepDone(3);
        setProgress(85);
        setDetail(detail || 'Reels created');
        break;
      case 'uploading_drive':
        setStepDone(3);
        setStepActive(4, detail || 'Uploading reels to Google Drive...');
        setProgress(88);
        break;
      case 'uploaded_drive':
        setStepDone(4);
        setProgress(95);
        setDetail(detail || 'Reels uploaded to Google Drive');
        break;
      case 'process_skipped':
        // ffmpeg/drive skipped — mark both as done (grey)
        setStepDone(3);
        setStepDone(4);
        setProgress(92);
        setDetail(detail);
        break;
      case 'completed':
        // Mark all done
        for (let i = 0; i <= 5; i++) setStepDone(i);
        setProgress(100);
        setDetail('All processing complete!');
        if (statusEventSource) statusEventSource.close();
        // Fetch full results
        fetchResults(data.videoId);
        break;
      case 'error':
        showToast(detail || 'Processing failed', 'error');
        setDetail(detail);
        if (statusEventSource) statusEventSource.close();
        // Mark current active step as error
        statusSteps.forEach((step) => {
          if (step.classList.contains('active')) {
            step.classList.remove('active');
            step.classList.add('error');
            step.querySelector('.status-icon').textContent = '\u2717';
          }
        });
        break;
    }
  }

  async function fetchResults(videoId, retries) {
    retries = retries || 0;
    try {
      const res = await fetch(`/api/results/${videoId}`);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // If analysis isn't ready yet and we haven't retried too many times,
        // wait and retry — the pipeline may still be flushing to the DB
        if (res.status === 404 && retries < 3) {
          await new Promise((r) => setTimeout(r, 1500));
          return fetchResults(videoId, retries + 1);
        }
        throw new Error(errData.error || `Server returned ${res.status}`);
      }

      const data = await res.json();

      if (!data.analysis || !data.analysis.cuttingGuide) {
        throw new Error('Results are incomplete — analysis data is missing');
      }

      showResults({
        videoId,
        analysis: data.analysis,
        transcript: data.transcript,
        video: data.video,
        processedReels: data.processedReels,
      });
    } catch (err) {
      console.error('fetchResults error:', err);
      showToast(err.message || 'Failed to load results', 'error');
    }
  }

  // --- Results Display ---

  function showResults(data) {
    currentVideoId = data.videoId;
    showSection('results');

    const guide = data.analysis.cuttingGuide;

    // Split guide into reel sections
    const sections = parseReelSections(guide);

    let html = '';

    // Show processed reel download links (from Google Drive or local server)
    const reels = data.processedReels || [];
    const availableReels = reels.filter((r) => r.status === 'success' && (r.driveLink || r.localUrl));
    if (availableReels.length > 0) {
      html += '<div class="reel-downloads">';
      html += '<h3>Your Processed Reels</h3>';
      html += '<div class="reel-links">';
      availableReels.forEach((r) => {
        const link = r.driveLink || r.localUrl;
        html += `<a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm reel-link">
          <span>&#9654;</span> ${escapeHtml(r.title || 'Reel #' + r.reelId)}
          ${r.targetDuration ? '<span class="reel-duration">' + r.targetDuration + 's</span>' : ''}
        </a>`;
      });
      html += '</div></div>';
    }

    // Add timeline visualization if we have cut data
    if (data.analysis.cutData && data.video) {
      html += buildTimeline(data.analysis.cutData, data.video.duration);
    }

    // Render each reel section
    sections.forEach((section, i) => {
      const id = `reel-${i}`;
      html += `
        <div class="reel-card">
          <div class="reel-header" onclick="toggleReel('${id}')">
            <h3>${section.title}</h3>
            <div style="display:flex;align-items:center;gap:10px">
              <button class="copy-btn" onclick="event.stopPropagation();copySection('${id}')">Copy</button>
              <span class="toggle-icon">&#9660;</span>
            </div>
          </div>
          <div class="reel-body" id="${id}">
            <div class="reel-content">${escapeHtml(section.content)}</div>
          </div>
        </div>
      `;
    });

    resultsContent.innerHTML = html;
    const message = driveReels.length > 0
      ? `CapCut guide ready! ${driveReels.length} reel(s) uploaded to Google Drive.`
      : 'CapCut guide ready!';
    showToast(message, 'success');
  }

  function parseReelSections(guide) {
    // Remove cut-data block
    const cleanGuide = guide.replace(/<cut-data>[\s\S]*?<\/cut-data>/, '').trim();

    // Split on the separator lines
    const parts = cleanGuide.split(/═{10,}/);
    const sections = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;

      // Extract title (first non-empty line)
      const lines = part.split('\n').filter((l) => l.trim());
      const title = lines[0] || `Section ${sections.length + 1}`;
      const content = part;

      sections.push({ title, content });
    }

    // If parsing didn't produce sections, show as single block
    if (sections.length === 0) {
      sections.push({ title: 'CapCut Cutting Guide', content: cleanGuide });
    }

    return sections;
  }

  function buildTimeline(cutData, totalDuration) {
    if (!cutData || !cutData.reels || !totalDuration) return '';

    let html = '';
    cutData.reels.forEach((reel) => {
      const segments = reel.segments || [];
      if (segments.length === 0) return;

      let segHtml = '';
      segments.forEach((seg, si) => {
        const left = (seg.start / totalDuration) * 100;
        const width = ((seg.end - seg.start) / totalDuration) * 100;
        segHtml += `<div class="timeline-segment seg-${si + 1}"
          style="left:${left}%;width:${Math.max(width, 1)}%"
          title="${formatSec(seg.start)} - ${formatSec(seg.end)}: ${seg.reason || ''}"></div>`;
      });

      html += `
        <div class="timeline-viz">
          <div style="font-size:0.85rem;margin-bottom:8px;color:var(--primary-light)">
            Reel #${reel.id} Timeline
          </div>
          <div class="timeline-bar">${segHtml}</div>
          <div class="timeline-labels">
            <span>0:00</span>
            <span>${formatSec(totalDuration)}</span>
          </div>
        </div>
      `;
    });

    return html;
  }

  // --- Global Functions (called from onclick) ---

  window.toggleReel = function (id) {
    const body = document.getElementById(id);
    const header = body.previousElementSibling;
    body.classList.toggle('collapsed');
    header.classList.toggle('collapsed');
  };

  window.copySection = function (id) {
    const body = document.getElementById(id);
    const text = body.querySelector('.reel-content').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = body.previousElementSibling.querySelector('.copy-btn');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  };

  window.copyFullGuide = function () {
    const allContent = document.querySelectorAll('.reel-content');
    const text = Array.from(allContent).map((el) => el.textContent).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast('Full guide copied to clipboard', 'success');
    });
  };

  // --- PDF Download ---

  downloadPdfBtn.addEventListener('click', () => {
    if (!currentVideoId) return;
    window.open(`/api/results/${currentVideoId}/pdf`, '_blank');
  });

  // --- Process Another ---

  processAnotherBtn.addEventListener('click', () => {
    clearFile();
    videoTypeSelect.value = '';
    emailInput.value = '';
    autoProcessCheck.checked = true;
    currentVideoId = null;
    resetProgress();
    showSection('upload');
  });

  // --- UI Helpers ---

  function showSection(name) {
    uploadSection.style.display = name === 'upload' ? 'block' : 'none';
    progressSection.classList.toggle('visible', name === 'progress');
    resultsSection.classList.toggle('visible', name === 'results');
  }

  function setProgress(pct) {
    progressBar.style.width = pct + '%';
  }

  function setDetail(text) {
    statusDetail.textContent = text;
  }

  function setStepActive(index, detail) {
    if (index >= statusSteps.length) return;
    const step = statusSteps[index];
    step.classList.remove('done', 'error');
    step.classList.add('active');
    step.querySelector('.status-icon').textContent = '\u23F3';
    if (detail) setDetail(detail);
  }

  function setStepDone(index) {
    if (index >= statusSteps.length) return;
    const step = statusSteps[index];
    step.classList.remove('active', 'error');
    step.classList.add('done');
    step.querySelector('.status-icon').textContent = '\u2713';
  }

  function setStepError(index) {
    if (index >= statusSteps.length) return;
    const step = statusSteps[index];
    step.classList.remove('active', 'done');
    step.classList.add('error');
    step.querySelector('.status-icon').textContent = '\u2717';
  }

  function resetProgress() {
    setProgress(0);
    setDetail('');
    statusSteps.forEach((step) => {
      step.classList.remove('active', 'done', 'error');
      step.querySelector('.status-icon').textContent = '\u25CB';
    });
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function formatSec(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
