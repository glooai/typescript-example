/**
 * DynamoDB access. One table, pay-per-request, TTL on `expires_at`.
 *
 * Writes are fire-and-forget from the caller's point of view but awaited
 * here so failures surface in CloudWatch; a ledger write failing must never
 * fail the user's completion, so callers wrap these in `catch`.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  CallMetrics,
  ChatMessage,
  LedgerRow,
  SessionPatch,
  SessionSummary,
} from "./types.js";
import {
  EXISTING_SESSION_CONDITION,
  GENERATED_TITLE_CONDITION,
  generatedTitleUpdate,
  recentLedgerPartitions,
  sessionIndexKey,
  sessionIndexUpdate,
  sessionKey,
  sessionPatchUpdate,
  sortRowsNewestFirst,
  sortSessionsForHistory,
  toLedgerItem,
  toLedgerRow,
  toSessionItems,
  toSessionSummary,
  visitorKey,
  type LedgerItem,
} from "./ledger.js";
import type { VisitorTrace } from "./visitor.js";

/** DynamoDB caps a BatchWriteItem request at 25 items. */
const BATCH_LIMIT = 25;

/**
 * A conditional write that was refused. This is an expected outcome on both
 * conditional writes here (a conversation that is not the caller's, a title
 * the visitor already set), so it is a return value rather than an error.
 */
function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function createStore(
  tableName: string,
  client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({}),
    { marshallOptions: { removeUndefinedValues: true } }
  )
) {
  return {
    async recordCall(
      metrics: CallMetrics,
      trace?: VisitorTrace,
      at = new Date()
    ): Promise<void> {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: toLedgerItem(metrics, at, trace),
        })
      );
    },

    /**
     * Overwrite the stored transcript for a session. The whole conversation
     * is rewritten rather than appended because the client always holds the
     * authoritative message list, and idempotent overwrite means a retried
     * request cannot duplicate turns.
     */
    async saveSession(
      sessionId: string,
      messages: ChatMessage[],
      trace?: VisitorTrace,
      at = new Date()
    ): Promise<void> {
      for (const batch of chunk(
        toSessionItems(sessionId, messages, at, trace),
        BATCH_LIMIT
      )) {
        await client.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: batch.map((Item) => ({ PutRequest: { Item } })),
            },
          })
        );
      }
      // The summary row is written with the transcript rather than on its own
      // schedule, so a conversation can never be listed in history without the
      // messages that list entry promises to open. It goes after them, and as
      // an update rather than a put, so the visitor's own pin, title, and
      // archive state on that row survives every subsequent turn.
      if (trace?.visitor_id) {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: sessionIndexKey(trace.visitor_id, sessionId),
            ...sessionIndexUpdate(sessionId, messages, at),
          })
        );
      }
    },

    /**
     * Apply a visitor's pin, rename, or archive to one of their own
     * conversations. Returns false when the conversation is not in this
     * visitor's history, which covers both a stale id and an attempt to reach
     * someone else's: the key is built from the caller's own visitor id, so
     * there is no id a caller could send that addresses another partition.
     */
    async patchSession(
      visitorId: string,
      sessionId: string,
      patch: SessionPatch
    ): Promise<boolean> {
      const update = sessionPatchUpdate(patch);
      if (!update) {
        return false;
      }
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: sessionIndexKey(visitorId, sessionId),
            ConditionExpression: EXISTING_SESSION_CONDITION,
            ...update,
          })
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) {
          return false;
        }
        throw error;
      }
    },

    /**
     * Store an automatically generated title, unless the visitor has already
     * named the conversation themselves. A rename that lands first wins, and a
     * rename that lands during generation wins too, because the condition is
     * evaluated by DynamoDB at write time and not by this process at read time.
     */
    async applyGeneratedTitle(
      visitorId: string,
      sessionId: string,
      title: string
    ): Promise<void> {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: sessionIndexKey(visitorId, sessionId),
            ConditionExpression: GENERATED_TITLE_CONDITION,
            ...generatedTitleUpdate(title),
          })
        );
      } catch (error) {
        if (!isConditionFailure(error)) {
          throw error;
        }
      }
    },

    async loadSession(sessionId: string): Promise<ChatMessage[]> {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": sessionKey(sessionId) },
        })
      );
      return (result.Items ?? []).map((item) => ({
        role: item.role as ChatMessage["role"],
        content: String(item.content ?? ""),
      }));
    },

    /**
     * A visitor's past conversations, pinned first then newest first. An
     * unknown visitor is an empty list rather than an error: a browser that
     * refuses the cookie is issued a new id on every request, so "no history"
     * is the correct and expected answer for it.
     *
     * Archived conversations are excluded unless asked for. The split is done
     * here rather than with a DynamoDB FilterExpression because the query
     * reads one small partition either way and the two views would otherwise
     * be two different reads of the same rows.
     */
    async listSessions(
      visitorId: string,
      limit: number,
      archived = false
    ): Promise<SessionSummary[]> {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": visitorKey(visitorId) },
        })
      );
      const sessions = (result.Items ?? [])
        .map(toSessionSummary)
        .filter(
          (session): session is SessionSummary =>
            session !== null && session.archived === archived
        );
      return sortSessionsForHistory(sessions, limit);
    },

    async recentCalls(limit: number, now = new Date()): Promise<LedgerRow[]> {
      const partitions = recentLedgerPartitions(now);
      const pages = await Promise.all(
        partitions.map((pk) =>
          client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: { ":pk": pk },
              ScanIndexForward: false,
              Limit: limit,
            })
          )
        )
      );
      const rows = pages.flatMap((page) =>
        (page.Items ?? []).map((item) => toLedgerRow(item as LedgerItem))
      );
      return sortRowsNewestFirst(rows, limit);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
