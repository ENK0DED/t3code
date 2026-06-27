import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // This migration was rewritten from an intermediate regular FTS5 table to a
  // contentless FTS5 table while still on the MCP orchestration branch.
  // Migration 035 repairs databases that ran the intermediate 034 shape. Keep
  // 035 immediately after 034; do not remove or reorder it.
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_messages_fts
    USING fts5(
      text,
      content='',
      tokenize='unicode61'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_fts(projection_thread_messages_fts)
    VALUES ('delete-all')
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_fts (
      rowid,
      text
    )
    SELECT
      rowid,
      text
    FROM projection_thread_messages
    WHERE is_streaming = 0
  `;
});
