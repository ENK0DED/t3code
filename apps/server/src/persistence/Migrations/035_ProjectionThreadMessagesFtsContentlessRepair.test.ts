import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration035 from "./035_ProjectionThreadMessagesFtsContentlessRepair.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const resetTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DROP TABLE IF EXISTS projection_thread_messages_fts`;
    yield* sql`DROP TABLE IF EXISTS projection_thread_messages`;
  });

const createProjectionThreadMessagesTable = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

const insertMessages = (sql: SqlClient.SqlClient) =>
  sql`
    INSERT INTO projection_thread_messages (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      attachments_json,
      is_streaming,
      created_at,
      updated_at
    )
    VALUES
      (
        'message-1',
        'thread-1',
        NULL,
        'user',
        'Investigate reconnect failures',
        NULL,
        0,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      ),
      (
        'message-2',
        'thread-1',
        NULL,
        'assistant',
        'Index canonical rowids for repair validation',
        NULL,
        0,
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      )
  `;

const expectContentlessDefinition = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly sql: string }>`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'projection_thread_messages_fts'
    `;
    assert.isTrue((rows[0]?.sql ?? "").includes("content=''"));
  });

const expectSearchRows = (sql: SqlClient.SqlClient, query: string) =>
  sql<{ readonly messageId: string }>`
    SELECT messages.message_id AS "messageId"
    FROM projection_thread_messages_fts
    INNER JOIN projection_thread_messages AS messages
      ON messages.rowid = projection_thread_messages_fts.rowid
    WHERE projection_thread_messages_fts MATCH ${query}
    ORDER BY messages.message_id
  `;

layer("035_ProjectionThreadMessagesFtsContentlessRepair", (it) => {
  it.effect(
    "repairs a preexisting regular FTS table into contentless FTS and backfills by rowid",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* resetTables(sql);
        yield* createProjectionThreadMessagesTable(sql);
        yield* insertMessages(sql);
        yield* sql`
        CREATE VIRTUAL TABLE projection_thread_messages_fts
        USING fts5(
          message_id UNINDEXED,
          thread_id UNINDEXED,
          role UNINDEXED,
          text,
          created_at UNINDEXED,
          tokenize='unicode61'
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_messages_fts (
          rowid,
          message_id,
          thread_id,
          role,
          text,
          created_at
        )
        SELECT
          rowid,
          message_id,
          thread_id,
          role,
          text,
          created_at
        FROM projection_thread_messages
      `;

        yield* Migration035;

        yield* expectContentlessDefinition(sql);
        const rows = yield* expectSearchRows(sql, "reconnect OR canonical");
        assert.deepEqual(rows, [{ messageId: "message-1" }, { messageId: "message-2" }]);
      }),
  );

  it.effect(
    "is idempotent and refreshes an already contentless FTS table with canonical rowids",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* resetTables(sql);
        yield* createProjectionThreadMessagesTable(sql);
        yield* insertMessages(sql);
        yield* sql`
        CREATE VIRTUAL TABLE projection_thread_messages_fts
        USING fts5(
          text,
          content='',
          tokenize='unicode61'
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_messages_fts (
          rowid,
          text
        )
        VALUES (
          999,
          'stale row that should be removed'
        )
      `;

        yield* Migration035;
        yield* Migration035;

        yield* expectContentlessDefinition(sql);

        const staleRows = yield* expectSearchRows(sql, "stale");
        assert.deepEqual(staleRows, []);

        const refreshedRows = yield* expectSearchRows(sql, "reconnect OR canonical");
        assert.deepEqual(refreshedRows, [{ messageId: "message-1" }, { messageId: "message-2" }]);
      }),
  );
});
