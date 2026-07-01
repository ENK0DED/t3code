import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // This migration was rewritten from an intermediate regular FTS5 table to a
  // contentless FTS5 table while still on the MCP orchestration branch.
  // Migration 035 repairs databases that ran the intermediate 034 shape. Keep
  // 035 immediately after 034; do not remove or reorder it.
  //
  // INVARIANT — do NOT run `VACUUM` (or enable `auto_vacuum`) on this database. This is a
  // CONTENTLESS FTS5 index (`content=''`): every index entry is keyed on
  // `projection_thread_messages.rowid`, and reads join `messages.rowid = fts.rowid` (see
  // ProjectionThreadMessageSearch). `projection_thread_messages` is an ordinary rowid
  // table, so VACUUM/auto_vacuum can reassign rowids and silently desync the FTS index
  // from the base table (wrong/missing search hits, with no error). The Sqlite layer sets
  // only WAL + foreign_keys and never VACUUMs — keep it that way. The durable fix is to
  // key the FTS on a stable surrogate integer column (a future migration), after which
  // this constraint can be lifted.
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
