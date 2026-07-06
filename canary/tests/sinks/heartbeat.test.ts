import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHeartbeatClient } from "../../src/sinks/heartbeat.js";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("is a no-op when the URL is unset or empty", async () => {
  await createHeartbeatClient(undefined).report(true);
  await createHeartbeatClient("").report(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("POSTs the bare heartbeat URL on a green run", async () => {
  await createHeartbeatClient(
    "https://uptime.betterstack.com/api/v1/heartbeat/tok"
  ).report(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://uptime.betterstack.com/api/v1/heartbeat/tok");
  expect(init.method).toBe("POST");
});

it("POSTs the /fail endpoint on a red run, tolerating a trailing slash", async () => {
  await createHeartbeatClient(
    "https://uptime.betterstack.com/api/v1/heartbeat/tok/"
  ).report(false);
  expect(fetchMock.mock.calls[0][0]).toBe(
    "https://uptime.betterstack.com/api/v1/heartbeat/tok/fail"
  );
});

it("never throws — network errors are swallowed and logged", async () => {
  fetchMock.mockRejectedValue(new Error("ECONNRESET"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    createHeartbeatClient("https://example.com/hb").report(true)
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
