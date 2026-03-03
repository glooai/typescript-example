# Gloo AI TypeScript Quickstart (pnpm)

This example loads Gloo AI client credentials from `.env.local`, requests a client-credential OAuth token scoped to `api/access`, decodes the JWT `exp` to show when the token expires, and posts a chat completion with model `meta.llama3-70b-instruct-v1:0` using the system message `You are a human-flourishing assistant.`. The default run asks “How do I discover my purpose?”, logs the token expiry (Unix seconds), and prints the completion JSON.

## Setup

1. Use Node.js LTS with pnpm (`corepack enable pnpm` if needed). An `.nvmrc` pin of `lts/*` is provided.
2. Get your client ID and secret from https://studio.ai.gloo.com/build/keys, then copy `.env.example` to `.env.local` (kept out of git) and fill in `GLOO_AI_CLIENT_ID` and `GLOO_AI_CLIENT_SECRET`.
3. Install dependencies:
   ```bash
   pnpm install
   ```

## Run the chat example

```bash
pnpm glooai:chat
```

This invokes `src/index.ts`, fetches an access token from `https://platform.ai.gloo.com/oauth2/token` with the `api/access` scope, and calls `https://platform.ai.gloo.com/ai/v1/chat/completions` using `meta.llama3-70b-instruct-v1:0`. The CLI path loads `.env.local` for you, while library consumers should provide credentials via `process.env`. To reuse the helpers or supply a custom prompt programmatically:

```ts
import { getAccessToken, getChatCompletion, runExample } from "./src/index";

// Full flow with your own prompt
await runExample("What is the meaning of community?");

// Or call the pieces yourself
const { access_token } = await getAccessToken({
  clientId: process.env.GLOO_AI_CLIENT_ID!,
  clientSecret: process.env.GLOO_AI_CLIENT_SECRET!,
});
const completion = await getChatCompletion(access_token, "Hi there!");
console.log(completion);
```

## Scripts

- `pnpm format` / `pnpm format:check` – Prettier write/check
- `pnpm lint` – ESLint with zero tolerated warnings
- `pnpm typecheck` – TypeScript `--noEmit`
- `pnpm build` – Compile TypeScript to `dist/`
- `pnpm test` – Run unit tests (Vitest)
- `pnpm test:coverage` – Vitest with coverage (70% minimum thresholds)
- `pnpm glooai:chat` – Integration-style run of `src/index.ts`

Generated artifacts like `dist/`, `node_modules/`, and `coverage/` are gitignored.
