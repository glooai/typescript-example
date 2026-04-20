import { fetchJson } from "./auth.js";

export const COMPLETIONS_V2_URL =
  "https://platform.ai.gloo.com/ai/v2/chat/completions";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type RoutingMode =
  | { auto_routing: true; model?: never; model_family?: never }
  | { auto_routing?: false; model: string; model_family?: never }
  | { auto_routing?: false; model?: never; model_family: string };

export type Tradition = "evangelical" | "catholic" | "mainline";

export type CompletionsV2Request = {
  messages: ChatMessage[];
  tradition?: Tradition;
  stream?: false; // POC: non-streaming only
  temperature?: number;
  max_tokens?: number;
} & RoutingMode;

export type CompletionsV2Choice = {
  index: number;
  finish_reason: string;
  message: {
    role: ChatRole;
    content: string;
  };
};

export type CompletionsV2Response = {
  id: string;
  object: string;
  created: number;
  model: string;
  provider?: string;
  model_family?: string;
  auto_routing?: boolean;
  routing_mechanism?:
    | "auto_routing"
    | "model_family"
    | "direct_model_selection";
  routing_tier?: string;
  routing_confidence?: number;
  tradition?: Tradition;
  choices: CompletionsV2Choice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
};

/**
 * Post a Completions V2 chat request.
 *
 * This is the minimal wrapper used by the a downstream app moderation reproducer. It
 * intentionally does not massage the request body — we want the raw payload
 * to match what downstream apps (e.g. a downstream app) are sending so the behavior we
 * observe here is apples-to-apples with the bug report.
 */
export async function postCompletionsV2(
  accessToken: string,
  request: CompletionsV2Request,
  timeoutMs = 30_000
): Promise<CompletionsV2Response> {
  return fetchJson<CompletionsV2Response>(
    COMPLETIONS_V2_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(request),
    },
    timeoutMs
  );
}

/**
 * Heuristics for spotting overly-aggressive content moderation in the assistant
 * reply. These strings are taken from the actual refusal screenshot in the
 * a downstream app bug report. If the assistant *refuses* a benign homestead/tax question
 * citing drug-use or medical-harm safety, we flag the moderation as too
 * aggressive.
 */
export const REFUSAL_PATTERNS: RegExp[] = [
  /i can(?:'|’)?t help with/i,
  /unsafe drug use/i,
  /poisoning/i,
  /overdose/i,
  /dangerous medical harm/i,
  /addiction treatment/i,
];

export function looksLikeRefusal(content: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(content));
}
