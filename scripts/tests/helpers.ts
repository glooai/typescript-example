import { afterEach, beforeEach, vi } from "vitest";

export type FetchCall = {
  url?: string | URL | Request;
  init?: RequestInit;
};

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const mockFetch = (payload: unknown, status = 200): Promise<Response> =>
  Promise.resolve(jsonResponse(payload, status));

/**
 * Snapshots `process.env` at suite setup and restores it (plus any spies)
 * around every test, so env-driven scripts cannot leak state between files.
 */
export function restoreEnvAndMocks(): void {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });
}
