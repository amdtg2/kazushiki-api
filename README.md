# Kazushiki API

Cloudflare Worker backend for Kazushiki Combat.

## Routes

- `GET /health` or `GET /ping` — health check
- `POST /ai/chat` — AI Coach (to be migrated from Rork)
- `POST /ai/video-review` — AI video review (to be migrated from Rork)

The AI routes intentionally return 503 until provider secrets and direct OpenAI/Gemini integrations are configured.
