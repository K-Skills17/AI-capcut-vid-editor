const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const config = require('../config');

let anthropic = null;
let openai = null;

function getAnthropic() {
  if (!anthropic) {
    if (!config.anthropic.apiKey) {
      throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY in .env');
    }
    anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropic;
}

function getOpenAI() {
  if (!openai) {
    if (!config.openai.apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in .env');
    }
    openai = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openai;
}

/**
 * Build the analysis prompt from the exact template specified.
 */
function buildPrompt({ videoType, duration, timestampedTranscript }) {
  const durationFormatted = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;

  return `Analyze this video transcript and create a CapCut Pro cutting guide.

VIDEO METADATA:
- Type: ${videoType}
- Duration: ${durationFormatted}
- Platform targets: Instagram Reels, TikTok
- Language: Portuguese/English

TRANSCRIPT WITH TIMESTAMPS:
${timestampedTranscript}

TASK: Create a detailed CapCut cutting guide with multiple reel variations.

OUTPUT FORMAT (use this EXACT structure):

═══════════════════════════════════════════════
📱 REEL #1: QUICK HOOK (15-30 seconds)
═══════════════════════════════════════════════

🎯 STRATEGY: Fast attention-grab for maximum virality

CAPCUT INSTRUCTIONS:
1. Import video to CapCut Pro
2. Timeline cuts:
   • Cut 1: [MM:SS] to [MM:SS] - [Why this segment]
   • Cut 2: [MM:SS] to [MM:SS] - [Why this segment]
   • Delete everything else
3. Sequence order: Cut 1 → Cut 2
4. Total duration: ~XX seconds

📝 CAPTION HOOK: [Compelling first line for caption]

🎨 CAPCUT TEMPLATE SUGGESTION: [Trending/Dynamic/Minimal/Tutorial] - [Why this style fits]

⚡ EFFECTS TO ADD IN CAPCUT:
- Auto-captions: ON (Portuguese/English)
- Transitions: [Specific transition types]
- Speed: [Any speed ramps needed]
- Emphasis: [Zoom/highlight at specific moments]

═══════════════════════════════════════════════
📱 REEL #2: VALUE-PACKED (30-60 seconds)
═══════════════════════════════════════════════

🎯 STRATEGY: Educational/informative for saves and shares

CAPCUT INSTRUCTIONS:
1. Timeline cuts:
   • Segment 1: [MM:SS] to [MM:SS] - [Content purpose]
   • Segment 2: [MM:SS] to [MM:SS] - [Content purpose]
   • Segment 3: [MM:SS] to [MM:SS] - [Content purpose]
2. Keep natural flow between segments
3. Total duration: ~XX seconds

📝 CAPTION ANGLE: [Educational hook + key takeaways]

🎨 CAPCUT TEMPLATE SUGGESTION: [Template type and reasoning]

⚡ EFFECTS TO ADD IN CAPCUT:
- Auto-captions with keyword emphasis
- B-roll suggestions: [If applicable]
- Text overlays for key points at: [timestamps]

═══════════════════════════════════════════════
📱 REEL #3: COMPLETE STORY (60+ seconds)
═══════════════════════════════════════════════

🎯 STRATEGY: Full narrative for engaged audience

CAPCUT INSTRUCTIONS:
1. Keep these segments:
   • [MM:SS] to [MM:SS] - [Why keep]
   • [MM:SS] to [MM:SS] - [Why keep]
   • [MM:SS] to [MM:SS] - [Why keep]
2. Remove/trim these parts:
   • [MM:SS] to [MM:SS] - [Why remove: filler/repetition/slow pacing]
3. Final duration: ~XX seconds

📝 LONG-FORM CAPTION: [Complete story angle]

═══════════════════════════════════════════════
🎯 PLATFORM-SPECIFIC TIPS
═══════════════════════════════════════════════

INSTAGRAM REELS:
- Best version: Reel #[X]
- Optimal length: XX seconds
- Hashtag strategy: [Suggestions]
- Post timing: [Recommendation]

TIKTOK:
- Best version: Reel #[X]
- Hook adjustment: [Any differences]
- Sound recommendation: [Trending/original]
- Duet/stitch potential: [Yes/No and why]

═══════════════════════════════════════════════
⚠️ QUALITY CHECKLIST FOR CAPCUT
═══════════════════════════════════════════════

Before exporting in CapCut Pro:
✓ Auto-captions enabled and reviewed
✓ Audio levels balanced
✓ No dead air longer than 2 seconds
✓ Hook is within first 3 seconds
✓ Transitions feel natural
✓ Mobile-friendly framing (vertical 9:16)
✓ Export settings: 1080x1920, 30fps, High quality

═══════════════════════════════════════════════

ADDITIONALLY, output a machine-readable JSON block at the very end wrapped in <cut-data> tags for automated processing. The JSON should contain:
{
  "reels": [
    {
      "id": 1,
      "title": "...",
      "strategy": "...",
      "target_duration_seconds": ...,
      "segments": [
        { "start": seconds_float, "end": seconds_float, "reason": "..." }
      ],
      "effects": {
        "captions": true/false,
        "transitions": ["type1", "type2"],
        "speed_ramps": [{ "start": seconds, "end": seconds, "speed": multiplier }],
        "text_overlays": [{ "text": "...", "start": seconds, "end": seconds }],
        "zoom_effects": [{ "start": seconds, "end": seconds, "scale": multiplier }]
      },
      "caption_text": "...",
      "template_style": "..."
    }
  ],
  "platform_recommendations": {
    "instagram": { "best_reel": 1, "optimal_length": seconds },
    "tiktok": { "best_reel": 1, "hook_adjustment": "..." }
  }
}`;
}

/**
 * Analyze transcript using Claude API (primary).
 */
async function analyzeWithClaude({ videoType, duration, timestampedTranscript }) {
  const client = getAnthropic();
  const prompt = buildPrompt({ videoType, duration, timestampedTranscript });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return { cuttingGuide: text, aiModelUsed: 'claude-sonnet-4-5-20250929' };
}

/**
 * Analyze transcript using GPT-4 (fallback).
 */
async function analyzeWithGPT({ videoType, duration, timestampedTranscript }) {
  const client = getOpenAI();
  const prompt = buildPrompt({ videoType, duration, timestampedTranscript });

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const text = response.choices[0]?.message?.content || '';
  return { cuttingGuide: text, aiModelUsed: 'gpt-4o' };
}

/**
 * Run analysis with Claude as primary, GPT-4 as fallback.
 */
async function analyzeTranscript({ videoType, duration, timestampedTranscript }) {
  // Try Claude first
  if (config.anthropic.apiKey) {
    try {
      return await analyzeWithClaude({ videoType, duration, timestampedTranscript });
    } catch (err) {
      console.error('Claude analysis failed, trying GPT fallback:', err.message);
    }
  }

  // Fallback to GPT-4
  if (config.openai.apiKey) {
    return await analyzeWithGPT({ videoType, duration, timestampedTranscript });
  }

  throw new Error('No AI API keys configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env');
}

/**
 * Parse the machine-readable cut data from the analysis output.
 * This enables Phase 2 automated processing.
 */
function parseCutData(cuttingGuide) {
  const match = cuttingGuide.match(/<cut-data>([\s\S]*?)<\/cut-data>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1].trim());
  } catch (err) {
    console.error('Failed to parse cut-data JSON:', err.message);
    return null;
  }
}

module.exports = {
  analyzeTranscript,
  analyzeWithClaude,
  analyzeWithGPT,
  buildPrompt,
  parseCutData,
};
