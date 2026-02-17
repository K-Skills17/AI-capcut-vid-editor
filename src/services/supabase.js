const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const config = require('../config');

let supabase = null;
let _configured = null;

// In-memory store used when Supabase is not configured
const memStore = {
  videos: new Map(),
  transcripts: new Map(),
  analyses: new Map(),
};

function isConfigured() {
  if (_configured === null) {
    const url = (config.supabase.url || '').trim();
    const key = (config.supabase.serviceKey || '').trim();
    _configured = !!(url && key && /^https?:\/\/.+/.test(url));
    if (!_configured) {
      console.log('[supabase] Not configured or invalid URL — using in-memory store');
      if (url) console.log(`[supabase] SUPABASE_URL="${url}" (valid=${/^https?:\/\/.+/.test(url)})`);
    }
  }
  return _configured;
}

function getClient() {
  if (!isConfigured()) return null;
  if (!supabase) {
    try {
      supabase = createClient(config.supabase.url.trim(), config.supabase.serviceKey.trim());
    } catch (err) {
      console.error('[supabase] createClient failed, falling back to in-memory:', err.message);
      _configured = false;
      return null;
    }
  }
  return supabase;
}

// --- Videos table ---

async function createVideoRecord({ videoUrl, videoType, duration, userEmail }) {
  if (!isConfigured()) {
    const id = crypto.randomUUID();
    const record = {
      id,
      video_url: videoUrl,
      video_type: videoType,
      duration: duration || null,
      user_email: userEmail || null,
      status: 'received',
      created_at: new Date().toISOString(),
    };
    memStore.videos.set(id, record);
    return record;
  }

  const client = getClient();
  const { data, error } = await client
    .from('videos')
    .insert({
      video_url: videoUrl,
      video_type: videoType,
      duration: duration || null,
      user_email: userEmail || null,
      status: 'received',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create video record: ${error.message}`);
  return data;
}

async function updateVideoStatus(videoId, status) {
  if (!isConfigured()) {
    const record = memStore.videos.get(videoId);
    if (record) record.status = status;
    return;
  }

  const client = getClient();
  const { error } = await client
    .from('videos')
    .update({ status })
    .eq('id', videoId);

  if (error) throw new Error(`Failed to update video status: ${error.message}`);
}

async function getVideo(videoId) {
  if (!isConfigured()) {
    const record = memStore.videos.get(videoId);
    if (!record) throw new Error('Video not found');
    return record;
  }

  const client = getClient();
  const { data, error } = await client
    .from('videos')
    .select('*')
    .eq('id', videoId)
    .single();

  if (error) throw new Error(`Video not found: ${error.message}`);
  return data;
}

// --- Transcripts table ---

async function saveTranscript({ videoId, fullText, timestampedJson, language }) {
  if (!isConfigured()) {
    const record = {
      id: crypto.randomUUID(),
      video_id: videoId,
      full_text: fullText,
      timestamped_json: timestampedJson,
      language: language || 'pt',
    };
    memStore.transcripts.set(videoId, record);
    return record;
  }

  const client = getClient();
  const { data, error } = await client
    .from('transcripts')
    .insert({
      video_id: videoId,
      full_text: fullText,
      timestamped_json: timestampedJson,
      language: language || 'pt',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save transcript: ${error.message}`);
  return data;
}

async function getTranscript(videoId) {
  if (!isConfigured()) {
    return memStore.transcripts.get(videoId) || null;
  }

  const client = getClient();
  const { data, error } = await client
    .from('transcripts')
    .select('*')
    .eq('video_id', videoId)
    .single();

  if (error) return null;
  return data;
}

// --- Analyses table ---

async function saveAnalysis({ videoId, cuttingGuide, reelCount, aiModelUsed }) {
  if (!isConfigured()) {
    const record = {
      id: crypto.randomUUID(),
      video_id: videoId,
      cutting_guide: cuttingGuide,
      reel_count: reelCount || 3,
      ai_model_used: aiModelUsed,
    };
    memStore.analyses.set(videoId, record);
    return record;
  }

  const client = getClient();
  const { data, error } = await client
    .from('analyses')
    .insert({
      video_id: videoId,
      cutting_guide: cuttingGuide,
      reel_count: reelCount || 3,
      ai_model_used: aiModelUsed,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save analysis: ${error.message}`);
  return data;
}

async function getAnalysis(videoId) {
  if (!isConfigured()) {
    return memStore.analyses.get(videoId) || null;
  }

  const client = getClient();
  const { data, error } = await client
    .from('analyses')
    .select('*')
    .eq('id', videoId)
    .single();

  if (error) return null;
  return data;
}

// --- Analytics ---

async function getAnalytics() {
  if (!isConfigured()) {
    const videos = Array.from(memStore.videos.values());
    const typeCounts = {};
    videos.forEach((v) => {
      typeCounts[v.video_type] = (typeCounts[v.video_type] || 0) + 1;
    });
    return {
      totalVideos: videos.length,
      completedVideos: videos.filter((v) => v.status === 'completed').length,
      videoTypeDistribution: typeCounts,
    };
  }

  const client = getClient();

  const { count: totalVideos } = await client
    .from('videos')
    .select('*', { count: 'exact', head: true });

  const { count: completedVideos } = await client
    .from('videos')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'completed');

  const { data: typeStats } = await client
    .from('videos')
    .select('video_type');

  const typeCounts = {};
  if (typeStats) {
    typeStats.forEach((v) => {
      typeCounts[v.video_type] = (typeCounts[v.video_type] || 0) + 1;
    });
  }

  return { totalVideos, completedVideos, videoTypeDistribution: typeCounts };
}

module.exports = {
  isConfigured,
  getClient,
  createVideoRecord,
  updateVideoStatus,
  getVideo,
  saveTranscript,
  getTranscript,
  saveAnalysis,
  getAnalysis,
  getAnalytics,
};
