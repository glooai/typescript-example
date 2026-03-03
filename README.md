<p align="center">
  <a href="https://gloo.com/ai">
    <img src="assets/gloo-ai-logo.svg" alt="Gloo AI" width="240" />
  </a>
</p>

# Gloo AI TypeScript Examples

TypeScript examples for the [Gloo AI](https://www.ai.gloo.com/) platform API — a monorepo with two workspace packages:

| Package                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| [`chatbot/`](chatbot/) | Next.js streaming chatbot using the Completions V2 API             |
| [`scripts/`](scripts/) | CLI scripts for auth, chat, ingestion, search, and item management |

## Prerequisites

- **Node.js LTS** (`.nvmrc` provided — run `nvm use` or `fnm use`)
- **pnpm** (`corepack enable pnpm` if needed)
- **Gloo AI credentials** — get a client ID and secret at https://studio.ai.gloo.com/build/keys

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Configure credentials for the CLI scripts
cp scripts/.env.example scripts/.env.local
# Edit scripts/.env.local with your GLOO_AI_CLIENT_ID and GLOO_AI_CLIENT_SECRET

# 3. Configure credentials for the chatbot
cp chatbot/.env.local.example chatbot/.env.local
# Edit chatbot/.env.local with your GLOO_AI_CLIENT_ID and GLOO_AI_CLIENT_SECRET
```

## Chatbot

A Next.js app demonstrating streaming markdown rendering with the Gloo Completions V2 API. Uses Vercel AI SDK v6 with a custom OpenAI-compatible provider, react-markdown for streaming token rendering, and Tailwind CSS v4.

Supports all three Gloo routing modes (AI Core, AI Core Select, AI Select) plus tradition-aware responses.

```bash
# Development server at http://localhost:3000
pnpm dev

# Production build
pnpm --filter gloo-chatbot build
```

### Deploy to Vercel

Set **Root Directory** to `chatbot` and add the environment variables `GLOO_CLIENT_ID` and `GLOO_CLIENT_SECRET`.

## CLI Scripts

Standalone scripts for exploring the Gloo AI platform APIs.

```bash
pnpm glooai:chat            # Chat completion (Completions V1)
pnpm glooai:ingest          # Content ingestion
pnpm glooai:items           # List items
pnpm glooai:items:metadata  # Item metadata
pnpm glooai:search          # Semantic search
pnpm glooai:jwt             # Decode and inspect access token
```

## Development

The repo uses [Turborepo](https://turbo.build/) for task orchestration. Root scripts delegate to workspaces:

```bash
pnpm build           # Build all packages
pnpm lint            # Lint all packages
pnpm typecheck       # Type-check all packages
pnpm test            # Run all tests
pnpm test:coverage   # Vitest coverage (scripts only, 70% minimum)
pnpm format          # Prettier — format all files
pnpm format:check    # Prettier — check formatting
```

## Project Structure

```
├── chatbot/                 # Next.js streaming chatbot
│   ├── app/                 # App Router pages + API route
│   ├── components/          # Chat UI, message renderer, settings
│   └── lib/                 # Gloo auth + provider wrappers
├── scripts/                 # CLI scripts + tests
│   ├── src/                 # Auth, chat, ingestion, search, items
│   └── tests/               # Vitest unit tests
├── turbo.json               # Turborepo task config
└── pnpm-workspace.yaml      # Workspace packages
```
