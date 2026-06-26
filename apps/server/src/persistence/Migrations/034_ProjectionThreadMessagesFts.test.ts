import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration034 from "./034_ProjectionThreadMessagesFts.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionThreadMessagesFts", (it) => {
  it.effect("creates and backfills the FTS table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
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
      yield* sql`
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
        VALUES (
          'message-1',
          'thread-1',
          NULL,
          'user',
          'Investigate reconnect failures',
          NULL,
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* Migration034;

      const rows = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages_fts
        WHERE projection_thread_messages_fts MATCH 'reconnect'
      `;
      assert.deepEqual(rows, [{ messageId: "message-1" }]);
    }),
  );
});
