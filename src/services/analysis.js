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

CRITICAL REQUIREMENT — You MUST include this at the very end of your response:

Output the exact text "<cut-data>" on its own line, then a valid JSON object, then "</cut-data>" on its own line. This JSON drives our automated video editor. Without it, no reels will be generated.

The "start" and "end" values MUST be numbers in seconds (e.g., 12.5, not "0:12"). Use the timestamps from the transcript to calculate exact seconds.

<cut-data>
{
  "reels": [
    {
      "id": 1,
      "title": "Reel title",
      "strategy": "Why this reel works",
      "target_duration_seconds": 30,
      "segments": [
        { "start": 0.0, "end": 15.5, "reason": "Strong opening hook" },
        { "start": 42.0, "end": 58.0, "reason": "Key message" }
      ],
      "effects": {
        "captions": true,
        "transitions": ["cut"],
        "speed_ramps": [],
        "text_overlays": [],
        "zoom_effects": []
      },
      "caption_text": "Caption for this reel",
      "template_style": "Dynamic"
    }
  ],
  "platform_recommendations": {
    "instagram": { "best_reel": 1, "optimal_length": 30 },
    "tiktok": { "best_reel": 1, "hook_adjustment": "none" }
  }
}
</cut-data>

Replace the example values above with real timestamps and data from the transcript. Every reel MUST have at least one segment with numeric start/end seconds.`;
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
 *
 * Handles multiple AI output formats:
 *  1. <cut-data>{...}</cut-data>
 *  2. ```json\n{...}\n``` (markdown code fences)
 *  3. Raw JSON block containing "reels" key
 */
function parseCutData(cuttingGuide) {
  if (!cuttingGuide) return null;

  // Strategy 1: <cut-data> tags (requested format)
  const tagMatch = cuttingGuide.match(/<cut-data>\s*([\s\S]*?)\s*<\/cut-data>/);
  if (tagMatch) {
    try {
      const parsed = JSON.parse(tagMatch[1].trim());
      if (parsed.reels && parsed.reels.length > 0) {
        console.log(`[parseCutData] Found ${parsed.reels.length} reel(s) via <cut-data> tags`);
        return parsed;
      }
    } catch (err) {
      console.error('[parseCutData] Found <cut-data> tags but JSON parse failed:', err.message);
    }
  }

  // Strategy 2: markdown code fences containing "reels"
  const codeBlockMatches = cuttingGuide.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g);
  for (const m of codeBlockMatches) {
    const block = m[1].trim();
    if (block.includes('"reels"')) {
      try {
        const parsed = JSON.parse(block);
        if (parsed.reels && parsed.reels.length > 0) {
          console.log(`[parseCutData] Found ${parsed.reels.length} reel(s) via markdown code fence`);
          return parsed;
        }
      } catch (err) {
        console.error('[parseCutData] Found code block with "reels" but JSON parse failed:', err.message);
      }
    }
  }

  // Strategy 3: find the last large JSON object in the text that contains "reels"
  const jsonMatches = cuttingGuide.matchAll(/\{[\s\S]*?"reels"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/g);
  let lastValid = null;
  for (const m of jsonMatches) {
    try {
      // Find the balanced braces — start from the match and find proper end
      const startIdx = cuttingGuide.indexOf(m[0]);
      const balanced = extractBalancedJson(cuttingGuide, startIdx);
      if (balanced) {
        const parsed = JSON.parse(balanced);
        if (parsed.reels && parsed.reels.length > 0) {
          lastValid = parsed;
        }
      }
    } catch {
      // try next match
    }
  }
  if (lastValid) {
    console.log(`[parseCutData] Found ${lastValid.reels.length} reel(s) via raw JSON extraction`);
    return lastValid;
  }

  console.error('[parseCutData] Could not find cut data in AI output. First 200 chars of end:', cuttingGuide.slice(-200));
  return null;
}

/**
 * Extract a balanced JSON object starting at the given index.
 */
function extractBalancedJson(text, startIdx) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.substring(startIdx, i + 1);
      }
    }
  }
  return null;
}

module.exports = {
  analyzeTranscript,
  analyzeWithClaude,
  analyzeWithGPT,
  buildPrompt,
  parseCutData,
};
