# AI CapCut Optimizer

AI-powered video analysis tool that generates precise cutting instructions for CapCut Pro. Built for LK Digital Content Factory.

## What it does

1. **Upload** a raw video through the web interface
2. **Transcribe** audio using OpenAI Whisper API
3. **Analyze** content using Claude AI (or GPT-4 fallback)
4. **Generate** detailed CapCut Pro cutting guides with 3 reel variations (15s, 30s, 60s)
5. **Phase 2** (built-in): Automated video cutting via ffmpeg — no human intervention needed

## Quick Start

### Prerequisites

- Node.js 18+
- ffmpeg installed (`apt install ffmpeg` or `brew install ffmpeg`)
- Supabase project (free tier works)
- OpenAI API key (for Whisper transcription)
- Anthropic API key (for Claude analysis) or OpenAI key (GPT-4 fallback)

### Setup

```bash
# Clone and install
git clone https://github.com/K-Skills17/AI-capcut-vid-editor.git
cd AI-capcut-vid-editor
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys and Supabase credentials

# Set up database (run in Supabase SQL editor)
# Copy contents of supabase/migrations/001_initial_schema.sql

# Create storage bucket in Supabase dashboard:
# Name: "videos", Public: true

# Start server
npm start
```

Open http://localhost:3000

### Docker

```bash
docker build -t capcut-optimizer .
docker run -p 3000:3000 --env-file .env capcut-optimizer
```

## Architecture

```
src/
  server.js              Express server entry point
  config.js              Environment configuration
  routes/
    api.js               REST API endpoints
  services/
    supabase.js          Storage & database operations
    transcription.js     FFmpeg audio extraction + Whisper API
    analysis.js          Claude/GPT analysis with CapCut prompt
    videoProcessor.js    Phase 2: Automated ffmpeg video cutting
    pipeline.js          Orchestration pipeline
  middleware/
    upload.js            Multer file upload handling
    rateLimiter.js       Express rate limiting
  utils/
    pdfGenerator.js      PDF export of cutting guides
public/
  index.html             Single-page frontend
  css/styles.css         UI styles
  js/app.js              Frontend logic
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload video & process (synchronous) |
| POST | `/api/upload-async` | Upload video & process (returns immediately) |
| GET | `/api/status/:videoId` | Check processing status |
| GET | `/api/status/:videoId/stream` | SSE real-time status stream |
| GET | `/api/results/:videoId` | Get full results with cutting guide |
| GET | `/api/results/:videoId/pdf` | Download PDF of cutting guide |
| POST | `/api/process/:videoId` | Get Phase 2 structured cut data |
| GET | `/api/analytics` | Usage statistics |

## Phase 2: Automated Processing

The system outputs machine-readable `<cut-data>` JSON alongside the human-readable guide. When "Auto-process reels" is checked, the server uses ffmpeg to:

1. Cut video segments as specified by the AI
2. Concatenate segments into complete reels
3. Apply speed ramps where recommended
4. Scale to vertical 9:16 format for Reels/TikTok

This requires ffmpeg on the server (included in Docker image).

## Database Schema

Three tables in Supabase:

- **videos** — upload records with status tracking
- **transcripts** — Whisper output with timestamped segments
- **analyses** — AI-generated cutting guides

Run `supabase/migrations/001_initial_schema.sql` in your Supabase SQL editor.

## Deployment

Ready for Railway, Render, or Fly.io:

- Set environment variables from `.env.example`
- Uses `npm start` as entry point
- Dockerfile included for container deployments

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `OPENAI_API_KEY` | Yes | For Whisper transcription |
| `ANTHROPIC_API_KEY` | Recommended | For Claude analysis (primary) |
| `PORT` | No | Server port (default: 3000) |
| `FFMPEG_PATH` | No | Path to ffmpeg binary (default: ffmpeg) |

---

Built by LK Digital for the Content Factory service.
