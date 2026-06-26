import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_messages_fts
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
    DELETE FROM projection_thread_messages_fts
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_fts (
      message_id,
      thread_id,
      role,
      text,
      created_at
    )
    SELECT
      message_id,
      thread_id,
      role,
      text,
      created_at
    FROM projection_thread_messages
  `;
});
