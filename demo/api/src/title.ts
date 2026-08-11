/**
 * Automatic chat naming: the gate, the prompt, and the cap.
 *
 * Everything here is pure so the rules that decide whether a conversation is
 * named, and what that name is allowed to be, are testable without a network
 * call to Gloo or a write to DynamoDB.
 */
import type { ChatMessage } from "./types.js";

/**
 * Hard cap on a stored title. The history list is a single narrow line beside
 * a relative timestamp, and 40 characters is what fits there without the row
 * ellipsing in the common case. The prompt asks the model to stay inside this
 * budget and `normalizeTitle` enforces it regardless of what comes back, since
 * a model asked for six words will occasionally return nine.
 */
export const TITLE_MAX_CHARS = 40;

/** The word budget the prompt asks for; the character cap is the real limit. */
const TITLE_MAX_WORDS = 6;

/** How much of the first exchange the naming prompt is allowed to quote. */
const EXCERPT_MAX_CHARS = 600;

/**
 * Whether this turn should produce a title. The transcript in the request is
 * the only input, which makes the server the authority on "is this the first
 * turn" rather than a client flag: a client can retry, replay, or hold a stale
 * view of its own state, and any of those would name a conversation twice.
 */
export function shouldGenerateTitle(messages: ChatMessage[]): boolean {
  return messages.filter((message) => message.role === "user").length === 1;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS);
}

/**
 * The naming request sent to Gloo. It quotes the first exchange rather than
 * the whole transcript because it only ever runs on the first turn, and a
 * bounded excerpt keeps a long pasted prompt from turning a cheap call into
 * an expensive one.
 */
export function titlePromptMessages(
  messages: ChatMessage[],
  reply: string
): ChatMessage[] {
  const question = excerpt(
    messages.find((message) => message.role === "user")?.content ?? ""
  );
  return [
    {
      role: "system",
      content:
        "You name chat conversations. Reply with the title alone: no quotes, no punctuation at the end, no explanation.",
    },
    {
      role: "user",
      content: [
        `Write a title for this conversation in at most ${TITLE_MAX_WORDS} words and at most ${TITLE_MAX_CHARS} characters.`,
        "",
        `Question: ${question}`,
        `Answer: ${excerpt(reply)}`,
      ].join("\n"),
    },
  ];
}

/**
 * Cut to `max` characters on a word boundary. A mid-word cut reads as a typo
 * rather than as a shortened title, so the last whole word is dropped instead;
 * a single word longer than the cap has no boundary to fall back to and is cut
 * where it must be.
 */
export function truncateOnWordBoundary(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  return lastSpace > 0 ? head.slice(0, lastSpace) : head;
}

/**
 * Turn raw model output into a storable title, or null when there is nothing
 * usable in it. Surrounding quotes and trailing punctuation are stripped
 * because a model asked for a bare title still returns `"A Title."` often
 * enough to matter, and null rather than an empty string so the caller keeps
 * the conversation's existing label instead of blanking it.
 */
export function normalizeTitle(raw: string): string | null {
  const tidied = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
  if (tidied.length === 0) {
    return null;
  }
  return truncateOnWordBoundary(tidied, TITLE_MAX_CHARS);
}
