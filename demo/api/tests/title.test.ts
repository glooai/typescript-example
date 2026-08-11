import { describe, expect, it } from "vitest";
import {
  TITLE_MAX_CHARS,
  normalizeTitle,
  shouldGenerateTitle,
  titlePromptMessages,
  truncateOnWordBoundary,
} from "../src/title.js";
import type { ChatMessage } from "../src/types.js";

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

describe("shouldGenerateTitle", () => {
  it("names a conversation on its first turn", () => {
    expect(shouldGenerateTitle([user("How does Psalm 23 read?")])).toBe(true);
  });

  it("does not name it again on any later turn", () => {
    expect(
      shouldGenerateTitle([
        user("How does Psalm 23 read?"),
        assistant("It reads..."),
        user("And Psalm 24?"),
      ])
    ).toBe(false);
  });

  it("ignores a system preamble when counting the turn", () => {
    expect(
      shouldGenerateTitle([
        { role: "system", content: "Be brief." },
        user("How does Psalm 23 read?"),
      ])
    ).toBe(true);
  });

  it("does not name a conversation that has asked nothing", () => {
    expect(shouldGenerateTitle([])).toBe(false);
    expect(shouldGenerateTitle([assistant("hello")])).toBe(false);
  });
});

describe("truncateOnWordBoundary", () => {
  it("leaves anything inside the budget alone", () => {
    expect(truncateOnWordBoundary("Psalm 23 outline", 40)).toBe(
      "Psalm 23 outline"
    );
  });

  it("drops the last whole word rather than cutting one in half", () => {
    expect(truncateOnWordBoundary("Comparing grace and mercy", 22)).toBe(
      "Comparing grace and"
    );
  });

  it("cuts a single over-long word where it must", () => {
    expect(truncateOnWordBoundary("Antidisestablishmentarianism", 10)).toBe(
      "Antidisest"
    );
  });
});

describe("normalizeTitle", () => {
  it("strips the quoting and trailing punctuation a model adds", () => {
    expect(normalizeTitle('"Psalm 23 outline."')).toBe("Psalm 23 outline");
    expect(normalizeTitle("Grace versus mercy!")).toBe("Grace versus mercy");
  });

  it("collapses whitespace into one line", () => {
    expect(normalizeTitle("  Psalm 23\n  outline  ")).toBe("Psalm 23 outline");
  });

  it("never returns more than the cap, on a word boundary", () => {
    const title = normalizeTitle(
      "How the Old Testament connects to the New Testament in detail"
    );

    expect(title).toBe("How the Old Testament connects to the");
    expect((title ?? "").length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(title).not.toMatch(/\s$/);
  });

  it("is null when the model returned nothing usable", () => {
    expect(normalizeTitle("")).toBeNull();
    expect(normalizeTitle("   \n ")).toBeNull();
    expect(normalizeTitle('"..."')).toBeNull();
  });
});

describe("titlePromptMessages", () => {
  it("asks for a title inside the same budget the code enforces", () => {
    const [, request] = titlePromptMessages(
      [user("How does Psalm 23 read?")],
      "It reads as a shepherd psalm."
    );

    expect(request?.content).toContain(`${TITLE_MAX_CHARS} characters`);
    expect(request?.content).toContain("How does Psalm 23 read?");
    expect(request?.content).toContain("It reads as a shepherd psalm.");
  });

  it("bounds what a long first exchange can send upstream", () => {
    const messages = titlePromptMessages(
      [user("x".repeat(5000))],
      "y".repeat(5000)
    );

    expect(messages[1]?.content.length).toBeLessThan(2000);
  });
});
