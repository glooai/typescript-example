/**
 * Slack sink — thin wrapper around the Web API methods we actually use.
 *
 * Posting rules (enforced by the runners, not this module):
 *   - New RED failures: top-level `chat.postMessage` (returns ts)
 *   - Recurring RED failures: threaded reply to the original ts
 *   - Recovery: threaded reply ("✅ recovered") + `reactions.add`
 *     white_check_mark on the original top-level ts + `chat.update`
 *     on the top-level post prefixing ":white_check_mark: *Recovered*"
 *     so the closure is legible from the channel overview without
 *     needing to open the thread.
 *   - Daily digest: top-level post; YELLOW signals threaded onto it
 */

export type SlackPostArgs = {
  text: string;
  blocks?: unknown[];
  threadTs?: string;
};

export type SlackPostResult = {
  ts: string;
  channel: string;
};

export type SlackUpdateArgs = {
  ts: string;
  text: string;
  blocks?: unknown[];
};

export interface SlackClient {
  post(args: SlackPostArgs): Promise<SlackPostResult>;
  react(ts: string, emoji: string): Promise<void>;
  update(args: SlackUpdateArgs): Promise<void>;
}

const BASE = "https://slack.com/api";

export function createSlackClient(
  botToken: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): SlackClient {
  return {
    async post({
      text,
      blocks,
      threadTs,
    }: SlackPostArgs): Promise<SlackPostResult> {
      const res = await fetchImpl(`${BASE}/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: channelId,
          text,
          blocks,
          thread_ts: threadTs,
          // Only push a top-level alert as a thread "broadcast" when the alert
          // itself is a top-level post (no threadTs). We don't double-ping.
          unfurl_links: false,
          unfurl_media: false,
        }),
      });

      const body = (await res.json()) as {
        ok: boolean;
        ts?: string;
        channel?: string;
        error?: string;
      };
      if (!body.ok || !body.ts) {
        throw new Error(
          `Slack chat.postMessage failed: ${body.error ?? "unknown"}`
        );
      }
      return { ts: body.ts, channel: body.channel ?? channelId };
    },

    async react(ts: string, emoji: string): Promise<void> {
      const res = await fetchImpl(`${BASE}/reactions.add`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: channelId,
          timestamp: ts,
          name: emoji,
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok && body.error !== "already_reacted") {
        throw new Error(
          `Slack reactions.add failed: ${body.error ?? "unknown"}`
        );
      }
    },

    async update({ ts, text, blocks }: SlackUpdateArgs): Promise<void> {
      const res = await fetchImpl(`${BASE}/chat.update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: channelId,
          ts,
          text,
          blocks,
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        throw new Error(`Slack chat.update failed: ${body.error ?? "unknown"}`);
      }
    },
  };
}
