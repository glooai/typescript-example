import { expect, it, vi } from "vitest";
import * as gloo from "../src/index.js";
import { mockFetch, restoreEnvAndMocks, type FetchCall } from "./helpers.js";

restoreEnvAndMocks();

it("loads the API key from the environment", () => {
  process.env.GLOO_AI_API_KEY = "test-key";

  expect(gloo.loadApiKey()).toBe("test-key");
});

it("throws when the API key is missing", () => {
  delete process.env.GLOO_AI_API_KEY;

  expect(() => gloo.loadApiKey()).toThrow(
    /Missing GLOO_AI_API_KEY environment variable/
  );
});

it("posts chat completions with the given prompt", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({
        choices: [{ message: { content: "hello" } }],
      });
    });

  const response = await gloo.getChatCompletion("token123", "Hi there!");

  expect(response.choices[0].message.content).toBe("hello");
  expect(calls.url).toBe("https://platform.ai.gloo.com/ai/v1/chat/completions");
  expect(calls.init?.headers).toMatchObject({
    Authorization: "Bearer token123",
    "Content-Type": "application/json",
  });
  const parsedBody = JSON.parse(
    calls.init?.body ? String(calls.init?.body) : "{}"
  );
  expect(parsedBody.model).toBe("meta.llama3-70b-instruct-v1:0");
  expect(parsedBody.messages[1].content).toBe("Hi there!");
  fetchSpy.mockRestore();
});

it("raises on failed chat completion responses", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response("boom", { status: 500, statusText: "Server Error" });
  });

  await expect(gloo.getChatCompletion("token123", "Hi?")).rejects.toThrow(
    /status 500/
  );
});

it("runs the example flow with mocked network calls", async () => {
  process.env.GLOO_AI_API_KEY = "test-key";

  vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
    mockFetch({ choices: [{ message: { content: "ok" } }] })
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await gloo.runExample("Hello?");

  expect(logSpy).toHaveBeenCalledWith(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }, null, 2)
  );
});
