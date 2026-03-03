# Gloo AI Documentation Index

<!-- COMPRESSED INDEX — keep under 8 KB. Summarize, don't duplicate source files. -->

Platform docs for the Gloo AI API. Read the linked files for full details; this index provides orientation only.

## API Reference

### `api/completions-v2.md` — Completions V2 API

POST `https://platform.ai.gloo.com/ai/v2/chat/completions`

Three routing modes:
| Mode | Parameter | Behavior |
|---|---|---|
| AI Core | `auto_routing: true` | Gloo picks optimal model automatically |
| AI Core Select | `model_family: "anthropic"` | Gloo picks best model within a provider |
| AI Select | `model: "gloo-openai-gpt-5-mini"` | Caller specifies exact model |

Key request params: `messages` (required), routing param (one required), `tradition`, `stream`, `temperature`, `max_tokens`, `tools`.

Response includes `model`, `provider`, `model_family`, `routing_mechanism`. Auto-routing adds `routing_tier` and `routing_confidence`.

Supports streaming, tool/function calling, and tradition-aware responses (`evangelical`, `catholic`, `mainline`).

Includes V1→V2 migration guide (endpoint change, routing param required, new metadata fields).

## Tutorials

### `tutorials/authentication.md` — OAuth2 Authentication

OAuth2 client credentials flow:
1. Get `GLOO_CLIENT_ID` and `GLOO_CLIENT_SECRET` from Gloo AI Studio
2. POST to `https://platform.ai.gloo.com/oauth2/token` with `grant_type=client_credentials&scope=api/access` using Basic Auth
3. Returns `access_token` + `expires_in`; use as `Bearer` token
4. Refresh before expiry (check `expires_at - 60s`)

Multi-language examples: Python, JavaScript, TypeScript, PHP, Go, Java.

### `tutorials/completions-v2.md` — Completions V2 Tutorial

Step-by-step usage of all three routing modes with working code in 6 languages. Covers:
- Auto-routing, model family, and direct model selection
- Streaming responses (SSE format)
- Tool/function calling (single + multi-step)
- Tradition-aware requests
- Error handling patterns (401/403/429)
- Token management integration with auth tutorial
