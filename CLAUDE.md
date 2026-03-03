# Project Instructions

<!-- COMPRESSED ROOT INDEX — keep under 8 KB total. -->

## Project

TypeScript example project for the Gloo AI platform API. Uses pnpm, tsx, vitest.

## Conventions

- API audit scripts in `scripts/src/`, tests in `scripts/tests/`
- Auth via OAuth2 client credentials (see context docs below)
- API target: Gloo Completions V2 (`/ai/v2/chat/completions`)

## Context Documentation

Reference docs live in `.context/`. Read the indexes first, then drill into source files only when you need full details.

### `.context/guides.md` — External API & Platform Guides

Covers Gloo AI platform docs: authentication, Completions V2 API reference, and tutorials. See `.context/guides/gloo.md` for a detailed per-file index.
