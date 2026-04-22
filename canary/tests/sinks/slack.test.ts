import { expect, it, vi } from "vitest";
import { createSlackClient } from "../../src/sinks/slack.js";

it("posts top-level messages and returns the ts", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, ts: "1700000000.000100", channel: "C123" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

  const slack = createSlackClient(
    "xoxb-fake",
    "C123",
    fetchImpl as unknown as typeof fetch
  );
  const result = await slack.post({ text: "hello world" });

  expect(result).toEqual({ ts: "1700000000.000100", channel: "C123" });
  expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
  expect(calls[0].init.method).toBe("POST");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.channel).toBe("C123");
  expect(body.text).toBe("hello world");
  expect(body.unfurl_links).toBe(false);
});

it("threads replies when threadTs is provided", async () => {
  const calls: Array<{ body: string }> = [];
  const fetchImpl = vi
    .fn()
    .mockImplementation(async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return new Response(JSON.stringify({ ok: true, ts: "x" }), {
        status: 200,
      });
    });

  const slack = createSlackClient(
    "xoxb-fake",
    "C123",
    fetchImpl as unknown as typeof fetch
  );
  await slack.post({ text: "reply", threadTs: "1700000000.000100" });

  expect(JSON.parse(calls[0].body).thread_ts).toBe("1700000000.000100");
});

it("throws when Slack returns ok:false", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
      status: 200,
    })
  );
  const slack = createSlackClient(
    "xoxb-bad",
    "C123",
    fetchImpl as unknown as typeof fetch
  );

  await expect(slack.post({ text: "x" })).rejects.toThrow(/invalid_auth/);
});

it("adds reactions and tolerates already_reacted", async () => {
  const calls: Array<{ body: string }> = [];
  const fetchImpl = vi
    .fn()
    .mockImplementationOnce(async (_u: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
    .mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
          status: 200,
        })
    );

  const slack = createSlackClient(
    "xoxb-fake",
    "C123",
    fetchImpl as unknown as typeof fetch
  );
  await slack.react("1700000000.000100", "white_check_mark");
  await slack.react("1700000000.000100", "white_check_mark"); // idempotent

  const parsed = JSON.parse(calls[0].body);
  expect(parsed.channel).toBe("C123");
  expect(parsed.timestamp).toBe("1700000000.000100");
  expect(parsed.name).toBe("white_check_mark");
});

it("throws on non-already_reacted errors", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
      status: 200,
    })
  );
  const slack = createSlackClient(
    "xoxb-fake",
    "C123",
    fetchImpl as unknown as typeof fetch
  );
  await expect(slack.react("1700000000", "white_check_mark")).rejects.toThrow(
    /missing_scope/
  );
});

it("chat.update rewrites a previously-posted message", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = vi
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

  const slack = createSlackClient(
    "xoxb-fake",
    "C123",
    fetchImpl as unknown as typeof fetch
  );
  await slack.update({
    ts: "1700000000.000100",
    text: ":white_check_mark: Recovered — original failure text",
  });

  expect(calls[0].url).toBe("https://slack.com/api/chat.update");
  const parsed = JSON.parse(calls[0].body);
  expect(parsed.channel).toBe("C123");
  expect(parsed.ts).toBe("1700000000.000100");
  expect(parsed.text).toContain(":white_check_mark:");
  expect(parsed.unfurl_links).toBe(false);
  expect(parsed.unfurl_media).toBe(false);
});

it("chat.update throws on Slack errors so the caller can log and skip non-fatally", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "message_not_found" }), {
      status: 200,
    })
  );
  const slack = createSlackClient(
    "xoxb-fake",
    "C123",
    fetchImpl as unknown as typeof fetch
  );
  await expect(slack.update({ ts: "1700000000", text: "hi" })).rejects.toThrow(
    /message_not_found/
  );
});
