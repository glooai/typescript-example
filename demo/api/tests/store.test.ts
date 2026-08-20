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
    Key?: Record<string, unknown>;
    ConditionExpression?: string;
    UpdateExpression?: string;
    KeyConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    RequestItems?: Record<string, Array<{ PutRequest: { Item: StoredItem } }>>;
  };
};

/**
 * A document client that records what it was asked to do and replays a
 * canned page. The AWS client is not stubbed at the network layer because
 * what is under test here is the key design, not the SDK.
 *
 * `refuse` makes the next conditional write fail the way DynamoDB does, so
 * the store's handling of a refused condition is exercised rather than
 * assumed.
 */
function fakeClient(items: unknown[] = [], refuse = false) {
  const sent: SentCommand[] = [];
  const client = {
    send(command: SentCommand) {
      sent.push(command);
      if (refuse && command.input.ConditionExpression) {
        const error = new Error("The conditional request failed");
        error.name = "ConditionalCheckFailedException";
        return Promise.reject(error);
      }
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

function updates(sent: SentCommand[]): SentCommand["input"][] {
  return sent
    .map((command) => command.input)
    .filter((input) => input.UpdateExpression !== undefined);
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

    expect(writtenItems(sent).map((item) => item.entity)).toEqual([
      "session",
      "session",
    ]);
    const [summary] = updates(sent);
    expect(summary?.Key).toEqual({
      pk: `VISITOR#${trace.visitor_id}`,
      sk: "SESSION#s-abcdef1234",
    });
    expect(summary?.ExpressionAttributeValues).toMatchObject({
      ":session_id": "s-abcdef1234",
      ":last_message_at": at.toISOString(),
      ":preview": "How does Psalm 23 read?",
    });
  });

  it("leaves the flags a visitor set untouched on a later turn", async () => {
    const { sent, client } = fakeClient();

    await createStore(TABLE, client).saveSession(
      "s-abcdef1234",
      messages,
      trace,
      at
    );

    expect(updates(sent)[0]?.UpdateExpression).not.toMatch(
      /pinned|archived|title/
    );
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
    expect(updates(sent)).toHaveLength(0);
  });
});

describe("patchSession", () => {
  it("writes to the caller's own partition and reports success", async () => {
    const { sent, client } = fakeClient();

    const changed = await createStore(TABLE, client).patchSession(
      trace.visitor_id,
      "s-abcdef1234",
      { pinned: true }
    );

    expect(changed).toBe(true);
    expect(sent[0]?.input.Key).toEqual({
      pk: `VISITOR#${trace.visitor_id}`,
      sk: "SESSION#s-abcdef1234",
    });
    expect(sent[0]?.input.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("reports a conversation that is not in this visitor's history", async () => {
    const { client } = fakeClient([], true);

    expect(
      await createStore(TABLE, client).patchSession(
        trace.visitor_id,
        "s-abcdef1234",
        { archived: true }
      )
    ).toBe(false);
  });

  it("writes nothing when the patch asks for nothing", async () => {
    const { sent, client } = fakeClient();

    expect(
      await createStore(TABLE, client).patchSession(
        trace.visitor_id,
        "s-abcdef1234",
        {}
      )
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("applyGeneratedTitle", () => {
  it("refuses to overwrite a title the visitor set", async () => {
    const { sent, client } = fakeClient();

    await createStore(TABLE, client).applyGeneratedTitle(
      trace.visitor_id,
      "s-abcdef1234",
      "Reading Psalm 23"
    );

    expect(sent[0]?.input.ConditionExpression).toBe(
      "attribute_exists(pk) AND attribute_not_exists(title_is_custom)"
    );
  });

  it("is not an error when that condition refuses the write", async () => {
    const { client } = fakeClient([], true);

    await expect(
      createStore(TABLE, client).applyGeneratedTitle(
        trace.visitor_id,
        "s-abcdef1234",
        "Reading Psalm 23"
      )
    ).resolves.toBeUndefined();
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
      {
        id: "s-ok",
        lastMessageAt: "2026-08-11T10:00:00.000Z",
        preview: "",
        title: null,
        pinned: false,
        archived: false,
      },
    ]);
  });

  it("hides archived conversations from the default list", async () => {
    const rows = [
      {
        session_id: "s-live",
        last_message_at: "2026-08-11T10:00:00.000Z",
        preview: "live",
      },
      {
        session_id: "s-archived",
        last_message_at: "2026-08-11T11:00:00.000Z",
        preview: "archived",
        archived: true,
      },
    ];

    expect(
      (
        await createStore(TABLE, fakeClient(rows).client).listSessions(
          "v-1",
          10
        )
      ).map((session) => session.id)
    ).toEqual(["s-live"]);
  });

  it("shows only the archived ones when they are asked for", async () => {
    const rows = [
      {
        session_id: "s-live",
        last_message_at: "2026-08-11T10:00:00.000Z",
        preview: "live",
      },
      {
        session_id: "s-archived",
        last_message_at: "2026-08-11T11:00:00.000Z",
        preview: "archived",
        archived: true,
      },
    ];

    expect(
      (
        await createStore(TABLE, fakeClient(rows).client).listSessions(
          "v-1",
          10,
          true
        )
      ).map((session) => session.id)
    ).toEqual(["s-archived"]);
  });

  it("floats pinned conversations to the top of the list", async () => {
    const rows = [
      {
        session_id: "s-newer",
        last_message_at: "2026-08-11T11:00:00.000Z",
        preview: "newer",
      },
      {
        session_id: "s-pinned",
        last_message_at: "2026-08-11T09:00:00.000Z",
        preview: "pinned",
        pinned: true,
      },
    ];

    expect(
      (
        await createStore(TABLE, fakeClient(rows).client).listSessions(
          "v-1",
          10
        )
      ).map((session) => session.id)
    ).toEqual(["s-pinned", "s-newer"]);
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
