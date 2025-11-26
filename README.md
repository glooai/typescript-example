# Gloo AI TypeScript Quickstart (pnpm)

This minimal example loads Gloo AI client credentials from the environment, requests an OAuth token, calls the chat completions API, and prints both the token expiration time and the completion payload.

## Setup

1. Use Node.js 20+ with pnpm (`corepack enable pnpm` if needed).
2. Copy `.env.example` to `.env.local` (kept out of git) and fill in `GLOO_AI_CLIENT_ID` and `GLOO_AI_CLIENT_SECRET`.
3. Install dependencies:
   ```bash
   pnpm install
   ```

## Run the chat example

```bash
pnpm glooai:chat
```

This invokes `src/index.ts`, fetches an access token with the `api/access` scope, and calls the chat completions endpoint using `meta.llama3-70b-instruct-v1:0`.

## Scripts

- `pnpm format` / `pnpm format:check` – Prettier write/check
- `pnpm lint` – ESLint with zero tolerated warnings
- `pnpm typecheck` – TypeScript `--noEmit`
- `pnpm build` – Compile TypeScript to `dist/`
- `pnpm test` – Run unit tests (Vitest)
- `pnpm test:coverage` – Vitest with coverage (70% minimum thresholds)
- `pnpm glooai:chat` – Integration-style run of `src/index.ts`

Generated artifacts like `dist/`, `node_modules/`, and `coverage/` are gitignored.
