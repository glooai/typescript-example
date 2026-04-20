import { z } from "zod";

/**
 * Expected minimal shape of V1 Messages (`/ai/v1/chat/completions`) and V2
 * Completions (`/ai/v2/chat/completions`) responses. We keep these loose — a
 * tight schema would break on harmless additions. We're checking for
 * structural drift, not exact-shape.
 */

export const ChatChoiceSchema = z.object({
  index: z.number().optional(),
  message: z
    .object({
      role: z.string().optional(),
      content: z.string().nullable().optional(),
    })
    .optional(),
  finish_reason: z.string().optional(),
});

export const ChatCompletionSchema = z.object({
  choices: z.array(ChatChoiceSchema).min(1),
});

export const V2CompletionSchema = ChatCompletionSchema.extend({
  model: z.string().optional(),
  routing_mechanism: z.string().optional(),
  routing_tier: z.string().optional(),
});

export type SchemaResult =
  | { ok: true }
  | { ok: false; issues: string[]; sample: unknown };

export function validate<T>(schema: z.ZodType<T>, raw: unknown): SchemaResult {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
    ),
    sample: raw,
  };
}
