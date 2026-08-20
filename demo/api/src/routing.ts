/**
 * Request validation and Gloo Completions V2 body construction.
 *
 * Everything here is pure so it can be unit tested without AWS or network.
 * The single rule this module exists to enforce is the V2 contract: a
 * request must carry exactly one routing mechanism (`auto_routing`,
 * `model_family`, or `model`). Sending two is a 400 from the platform.
 */
import { z } from "zod";
import type { ChatRequest, CompareRequest, RoutingSelection } from "./types.js";

/** Families the platform accepts for `model_family` routing. */
export const MODEL_FAMILIES = [
  "openai",
  "anthropic",
  "google",
  "open source",
] as const;

/** Traditions the platform accepts. Empty/absent means general. */
export const TRADITIONS = ["evangelical", "catholic", "mainline"] as const;

/**
 * Hard caps. This is a public demo behind a token-cost API key, so the
 * proxy refuses anything that could turn into an expensive prompt before
 * it reaches Gloo.
 */
export const LIMITS = {
  maxMessages: 20,
  maxCharsPerMessage: 4000,
  maxTotalChars: 12000,
  maxCompareVariants: 4,
  /** Keeps demo responses short, snappy, and cheap to compare side by side. */
  maxTokens: 600,
} as const;

const routingSelectionSchema = z
  .object({
    mode: z.enum(["auto_routing", "model_family", "model"]),
    modelFamily: z.enum(MODEL_FAMILIES).optional(),
    model: z.string().min(1).max(120).optional(),
    tradition: z.enum(TRADITIONS).optional(),
  })
  .superRefine((selection, ctx) => {
    if (selection.mode === "model_family" && !selection.modelFamily) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelFamily is required when mode is model_family",
      });
    }
    if (selection.mode === "model" && !selection.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model is required when mode is model",
      });
    }
  });

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(LIMITS.maxCharsPerMessage),
});

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const messagesSchema = z
  .array(messageSchema)
  .min(1)
  .max(LIMITS.maxMessages)
  .refine(
    (messages) =>
      messages.reduce((total, m) => total + m.content.length, 0) <=
      LIMITS.maxTotalChars,
    { message: `conversation exceeds ${LIMITS.maxTotalChars} characters` }
  );

export const chatRequestSchema: z.ZodType<ChatRequest> = z.object({
  sessionId: sessionIdSchema,
  messages: messagesSchema,
  routing: routingSelectionSchema,
});

export const compareRequestSchema: z.ZodType<CompareRequest> = z.object({
  sessionId: sessionIdSchema,
  prompt: z.string().min(1).max(LIMITS.maxCharsPerMessage),
  variants: z
    .array(routingSelectionSchema)
    .min(2)
    .max(LIMITS.maxCompareVariants),
});

/**
 * Human-readable label for what the caller asked for, before Gloo resolves
 * it. Stored on the ledger row so the "requested vs resolved" column pair
 * in the UI stays meaningful for auto-routed calls.
 */
export function describeSelection(selection: RoutingSelection): string {
  switch (selection.mode) {
    case "model_family":
      return selection.modelFamily ?? "unknown family";
    case "model":
      return selection.model ?? "unknown model";
    default:
      return "auto";
  }
}

/**
 * Build the Gloo Completions V2 request body. Exactly one routing key is
 * ever set, and `auto_routing` is explicitly `false` for the other two
 * modes because the platform treats an absent flag as unspecified.
 */
export function buildGlooBody(options: {
  messages: Array<{ role: string; content: string }>;
  selection: RoutingSelection;
  stream: boolean;
}): Record<string, unknown> {
  const { messages, selection, stream } = options;

  const body: Record<string, unknown> = {
    messages,
    max_tokens: LIMITS.maxTokens,
    stream,
  };

  if (stream) {
    // Without this the terminal usage chunk is omitted and we cannot cost
    // a streamed call.
    body.stream_options = { include_usage: true };
  }

  switch (selection.mode) {
    case "model_family":
      body.auto_routing = false;
      body.model_family = selection.modelFamily;
      break;
    case "model":
      body.auto_routing = false;
      body.model = selection.model;
      break;
    default:
      body.auto_routing = true;
      break;
  }

  if (selection.tradition) {
    body.tradition = selection.tradition;
  }

  return body;
}
