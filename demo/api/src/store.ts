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
} from "@aws-sdk/lib-dynamodb";
import type {
  CallMetrics,
  ChatMessage,
  LedgerRow,
  SessionSummary,
} from "./types.js";
import {
  recentLedgerPartitions,
  sessionKey,
  sortRowsNewestFirst,
  sortSessionsNewestFirst,
  toLedgerItem,
  toLedgerRow,
  toSessionIndexItem,
  toSessionItems,
  toSessionSummary,
  visitorKey,
  type LedgerItem,
  type SessionIndexItem,
} from "./ledger.js";
import type { VisitorTrace } from "./visitor.js";

/** DynamoDB caps a BatchWriteItem request at 25 items. */
const BATCH_LIMIT = 25;

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
      const items: Array<
        ReturnType<typeof toSessionItems>[number] | SessionIndexItem
      > = [...toSessionItems(sessionId, messages, at, trace)];
      // The summary row is written with the transcript rather than on its own
      // schedule, so a conversation can never be listed in history without the
      // messages that list entry promises to open.
      if (trace?.visitor_id) {
        items.push(
          toSessionIndexItem(trace.visitor_id, sessionId, messages, at)
        );
      }
      for (const batch of chunk(items, BATCH_LIMIT)) {
        await client.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: batch.map((Item) => ({ PutRequest: { Item } })),
            },
          })
        );
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
     * A visitor's past conversations, newest first. An unknown visitor is an
     * empty list rather than an error: a browser that refuses the cookie is
     * issued a new id on every request, so "no history" is the correct and
     * expected answer for it.
     */
    async listSessions(
      visitorId: string,
      limit: number
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
        .filter((session): session is SessionSummary => session !== null);
      return sortSessionsNewestFirst(sessions, limit);
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
