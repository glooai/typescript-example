import { describe, expect, it } from "vitest";
import {
  buildGlooBody,
  chatRequestSchema,
  compareRequestSchema,
  describeSelection,
  LIMITS,
  sessionPatchSchema,
} from "../src/routing.js";
import { TITLE_MAX_CHARS } from "../src/title.js";

const sessionId = "session-abcdef123";

describe("buildGlooBody", () => {
  it("sends exactly one routing mechanism for auto routing", () => {
    const body = buildGlooBody({
      messages: [{ role: "user", content: "hi" }],
      selection: { mode: "auto_routing" },
      stream: false,
    });

    expect(body.auto_routing).toBe(true);
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("model_family");
  });

  it("sends exactly one routing mechanism for family routing", () => {
    const body = buildGlooBody({
      messages: [{ role: "user", content: "hi" }],
      selection: { mode: "model_family", modelFamily: "anthropic" },
      stream: false,
    });

    expect(body.auto_routing).toBe(false);
    expect(body.model_family).toBe("anthropic");
    expect(body).not.toHaveProperty("model");
  });

  it("sends exactly one routing mechanism for direct model selection", () => {
    const body = buildGlooBody({
      messages: [{ role: "user", content: "hi" }],
      selection: { mode: "model", model: "gloo-openai-gpt-5-mini" },
      stream: false,
    });

    expect(body.auto_routing).toBe(false);
    expect(body.model).toBe("gloo-openai-gpt-5-mini");
    expect(body).not.toHaveProperty("model_family");
  });

  it("requests usage totals only when streaming", () => {
    const streamed = buildGlooBody({
      messages: [{ role: "user", content: "hi" }],
      selection: { mode: "auto_routing" },
      stream: true,
    });
    const buffered = buildGlooBody({
      messages: [{ role: "user", content: "hi" }],
      selection: { mode: "auto_routing" },
      stream: false,
    });

    expect(streamed.stream_options).toEqual({ include_usage: true });
    expect(buffered).not.toHaveProperty("stream_options");
  });

  it("passes tradition through and caps max_tokens", () => {
    const body = buildGlooBody({
      messages: [{ role: "user", content: "hi" }],
      selection: { mode: "auto_routing", tradition: "catholic" },
      stream: false,
    });

    expect(body.tradition).toBe("catholic");
    expect(body.max_tokens).toBe(LIMITS.maxTokens);
  });
});

describe("describeSelection", () => {
  it("labels each mode by what the caller asked for", () => {
    expect(describeSelection({ mode: "auto_routing" })).toBe("auto");
    expect(
      describeSelection({ mode: "model_family", modelFamily: "google" })
    ).toBe("google");
    expect(describeSelection({ mode: "model", model: "gloo-x" })).toBe(
      "gloo-x"
    );
  });
});

describe("chatRequestSchema", () => {
  const valid = {
    sessionId,
    messages: [{ role: "user", content: "hello" }],
    routing: { mode: "auto_routing" },
  };

  it("accepts a well-formed request", () => {
    expect(chatRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a model_family selection with no family", () => {
    const result = chatRequestSchema.safeParse({
      ...valid,
      routing: { mode: "model_family" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a model selection with no model id", () => {
    const result = chatRequestSchema.safeParse({
      ...valid,
      routing: { mode: "model" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a conversation over the total character budget", () => {
    const long = "x".repeat(LIMITS.maxCharsPerMessage);
    const messages = Array.from(
      { length: Math.ceil(LIMITS.maxTotalChars / long.length) + 1 },
      () => ({ role: "user" as const, content: long })
    );
    expect(chatRequestSchema.safeParse({ ...valid, messages }).success).toBe(
      false
    );
  });

  it("rejects a session id that is not an opaque token", () => {
    const result = chatRequestSchema.safeParse({
      ...valid,
      sessionId: "../../etc/passwd",
    });
    expect(result.success).toBe(false);
  });
});

describe("compareRequestSchema", () => {
  it("requires at least two variants", () => {
    const result = compareRequestSchema.safeParse({
      sessionId,
      prompt: "compare me",
      variants: [{ mode: "auto_routing" }],
    });
    expect(result.success).toBe(false);
  });

  it("caps the number of variants", () => {
    const result = compareRequestSchema.safeParse({
      sessionId,
      prompt: "compare me",
      variants: Array.from({ length: LIMITS.maxCompareVariants + 1 }, () => ({
        mode: "auto_routing",
      })),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a mixed set of routing modes", () => {
    const result = compareRequestSchema.safeParse({
      sessionId,
      prompt: "compare me",
      variants: [
        { mode: "auto_routing" },
        { mode: "model_family", modelFamily: "openai" },
        { mode: "model", model: "gloo-anthropic-claude-haiku-4.5" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("sessionPatchSchema", () => {
  it("accepts each change on its own", () => {
    expect(sessionPatchSchema.safeParse({ pinned: true }).success).toBe(true);
    expect(sessionPatchSchema.safeParse({ archived: true }).success).toBe(true);
    expect(sessionPatchSchema.safeParse({ title: "Psalm 23" }).success).toBe(
      true
    );
  });

  it("refuses a body that asks for nothing", () => {
    expect(sessionPatchSchema.safeParse({}).success).toBe(false);
  });

  it("holds a typed title to the same cap a generated one gets", () => {
    expect(
      sessionPatchSchema.safeParse({ title: "a".repeat(TITLE_MAX_CHARS) })
        .success
    ).toBe(true);
    expect(
      sessionPatchSchema.safeParse({ title: "a".repeat(TITLE_MAX_CHARS + 1) })
        .success
    ).toBe(false);
  });

  it("refuses an empty title rather than blanking a conversation", () => {
    expect(sessionPatchSchema.safeParse({ title: "" }).success).toBe(false);
  });
});
