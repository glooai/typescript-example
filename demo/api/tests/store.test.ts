import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createStore } from "../src/store.js";
import type { VisitorTrace } from "../src/visitor.js";

const TABLE = "gloo-demo";

const trace: VisitorTrace = {
  visitor_id: "v-0123456789abcdef0123456789abcdef",
  visitor_id_source: "cookie",
  visitor_session_id: "s-abcdef1234",
};

const at = new Date("2026-08-11T10:30:00.000Z");

type StoredItem = Record<string, unknown>;

type SentCommand = {
  input: {
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    RequestItems?: Record<string, Array<{ PutRequest: { Item: StoredItem } }>>;
  };
};

/**
 * A document client that records what it was asked to do and replays a
 * canned page. The AWS client is not stubbed at the network layer because
 * what is under test here is the key design, not the SDK.
 */
function fakeClient(items: unknown[] = []) {
  const sent: SentCommand[] = [];
  const client = {
    send(command: SentCommand) {
      sent.push(command);
      return Promise.resolve({ Items: items });
    },
  };
  return { sent, client: client as unknown as DynamoDBDocumentClient };
}

function writtenItems(sent: SentCommand[]): StoredItem[] {
  return sent.flatMap((command) =>
    (command.input.RequestItems?.[TABLE] ?? []).map(
      (request) => request.PutRequest.Item
    )
  );
}

describe("saveSession", () => {
  const messages = [
    { role: "user" as const, content: "How does Psalm 23 read?" },
    { role: "assistant" as const, content: "It reads..." },
  ];

  it("writes the history summary alongside the transcript", async () => {
    const { sent, client } = fakeClient();

    await createStore(TABLE, client).saveSession(
      "s-abcdef1234",
      messages,
      trace,
      at
    );

    const items = writtenItems(sent);
    expect(items.map((item) => item.entity)).toEqual([
      "session",
      "session",
      "session_index",
    ]);
    expect(items[2]).toMatchObject({
      pk: `VISITOR#${trace.visitor_id}`,
      sk: "SESSION#s-abcdef1234",
      session_id: "s-abcdef1234",
      last_message_at: at.toISOString(),
      preview: "How does Psalm 23 read?",
    });
  });

  it("stores the transcript with no summary when there is no visitor", async () => {
    const { sent, client } = fakeClient();

    await createStore(TABLE, client).saveSession(
      "s-abcdef1234",
      messages,
      undefined,
      at
    );

    expect(writtenItems(sent).map((item) => item.entity)).toEqual([
      "session",
      "session",
    ]);
  });
});

describe("listSessions", () => {
  it("queries the visitor's own partition, newest first", async () => {
    const { sent, client } = fakeClient([
      {
        session_id: "s-older",
        last_message_at: "2026-08-11T09:00:00.000Z",
        preview: "older",
      },
      {
        session_id: "s-newer",
        last_message_at: "2026-08-11T10:00:00.000Z",
        preview: "newer",
      },
    ]);

    const sessions = await createStore(TABLE, client).listSessions(
      trace.visitor_id,
      10
    );

    expect(sent[0]?.input.KeyConditionExpression).toBe("pk = :pk");
    expect(sent[0]?.input.ExpressionAttributeValues).toEqual({
      ":pk": `VISITOR#${trace.visitor_id}`,
    });
    expect(sessions.map((session) => session.id)).toEqual([
      "s-newer",
      "s-older",
    ]);
  });

  it("drops rows that are not usable history entries", async () => {
    const { client } = fakeClient([
      { session_id: "s-ok", last_message_at: "2026-08-11T10:00:00.000Z" },
      { pk: "VISITOR#v-1", sk: "SESSION#s-broken" },
    ]);

    const sessions = await createStore(TABLE, client).listSessions("v-1", 10);

    expect(sessions).toEqual([
      { id: "s-ok", lastMessageAt: "2026-08-11T10:00:00.000Z", preview: "" },
    ]);
  });

  it("caps the list", async () => {
    const { client } = fakeClient(
      Array.from({ length: 5 }, (_, index) => ({
        session_id: `s-${index}`,
        last_message_at: `2026-08-11T1${index}:00:00.000Z`,
        preview: "",
      }))
    );

    expect(
      await createStore(TABLE, client).listSessions("v-1", 2)
    ).toHaveLength(2);
  });
});
