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
import type { CallMetrics, ChatMessage, LedgerRow } from "./types.js";
import {
  recentLedgerPartitions,
  sessionKey,
  sortRowsNewestFirst,
  toLedgerItem,
  toSessionItems,
} from "./ledger.js";

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
    async recordCall(metrics: CallMetrics, at = new Date()): Promise<void> {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: toLedgerItem(metrics, at),
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
      at = new Date()
    ): Promise<void> {
      const items = toSessionItems(sessionId, messages, at);
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
      const rows = pages.flatMap((page) => (page.Items ?? []) as LedgerRow[]);
      return sortRowsNewestFirst(rows, limit);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
