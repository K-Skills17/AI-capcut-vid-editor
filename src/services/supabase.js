const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let supabase = null;

function getClient() {
  if (!supabase) {
    if (!config.supabase.url || !config.supabase.serviceKey) {
      throw new Error('Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
    }
    supabase = createClient(config.supabase.url, config.supabase.serviceKey);
  }
  return supabase;
}

// --- Videos table ---

async function createVideoRecord({ videoUrl, videoType, duration, userEmail }) {
  const client = getClient();
  const { data, error } = await client
    .from('videos')
    .insert({
      video_url: videoUrl,
      video_type: videoType,
      duration: duration || null,
      user_email: userEmail || null,
      status: 'uploading',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create video record: ${error.message}`);
  return data;
}

async function updateVideoStatus(videoId, status) {
  const client = getClient();
  const { error } = await client
    .from('videos')
    .update({ status })
    .eq('id', videoId);

  if (error) throw new Error(`Failed to update video status: ${error.message}`);
}

async function getVideo(videoId) {
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
  const client = getClient();
  const { data, error } = await client
    .from('analyses')
    .select('*')
    .eq('video_id', videoId)
    .single();

  if (error) return null;
  return data;
}

// --- Analytics ---

async function getAnalytics() {
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
