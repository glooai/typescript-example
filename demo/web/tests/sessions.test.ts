import { describe, expect, it } from "vitest";
import { historyEntries, relativeTime } from "../src/sessions";
import type { SessionSummary } from "../src/types";

const now = Date.parse("2026-08-11T12:00:00.000Z");

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s-1",
    lastMessageAt: "2026-08-11T12:00:00.000Z",
    preview: "How does Psalm 23 read?",
    ...overrides,
  };
}

describe("relativeTime", () => {
  it("reads at the scale a twelve hour retention window needs", () => {
    expect(relativeTime("2026-08-11T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-08-11T11:48:00.000Z", now)).toBe("12m ago");
    expect(relativeTime("2026-08-11T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-08-09T09:00:00.000Z", now)).toBe("2d ago");
  });

  it("does not report a negative age when a clock runs ahead", () => {
    expect(relativeTime("2026-08-11T12:05:00.000Z", now)).toBe("just now");
  });

  it("is empty for a timestamp it cannot parse", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("historyEntries", () => {
  it("labels each conversation and marks the open one", () => {
    const entries = historyEntries(
      [
        session({ id: "s-1" }),
        session({ id: "s-2", lastMessageAt: "2026-08-11T10:00:00.000Z" }),
      ],
      "s-2",
      now
    );

    expect(entries).toEqual([
      {
        id: "s-1",
        title: "How does Psalm 23 read?",
        when: "just now",
        active: false,
      },
      {
        id: "s-2",
        title: "How does Psalm 23 read?",
        when: "2h ago",
        active: true,
      },
    ]);
  });

  it("gives a conversation with no preview a readable label", () => {
    const [entry] = historyEntries([session({ preview: "   " })], "s-9", now);

    expect(entry?.title).toBe("Untitled conversation");
  });

  it("keeps the server's order", () => {
    const entries = historyEntries(
      [
        session({ id: "s-old", lastMessageAt: "2026-08-11T08:00:00.000Z" }),
        session({ id: "s-new" }),
      ],
      "s-new",
      now
    );

    expect(entries.map((entry) => entry.id)).toEqual(["s-old", "s-new"]);
  });

  it("marks nothing active when the open conversation has no stored turns", () => {
    const entries = historyEntries([session({ id: "s-1" })], "s-fresh", now);

    expect(entries.every((entry) => !entry.active)).toBe(true);
  });
});
