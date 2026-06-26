import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const createContentlessFtsTable = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE VIRTUAL TABLE projection_thread_messages_fts
    USING fts5(
      text,
      content='',
      tokenize='unicode61'
    )
  `;

const resetContentlessFtsTable = (sql: SqlClient.SqlClient) =>
  sql`
    INSERT INTO projection_thread_messages_fts(projection_thread_messages_fts)
    VALUES ('delete-all')
  `;

const backfillContentlessFtsTable = (sql: SqlClient.SqlClient) =>
  sql`
    INSERT INTO projection_thread_messages_fts (
      rowid,
      text
    )
    SELECT
      rowid,
      text
    FROM projection_thread_messages
  `;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ readonly sql: string | null }>`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_thread_messages_fts'
  `;

  const existingDefinition = rows[0]?.sql ?? null;
  const isContentless = existingDefinition?.includes("content=''") ?? false;

  if (existingDefinition === null) {
    yield* createContentlessFtsTable(sql);
    yield* backfillContentlessFtsTable(sql);
    return;
  }

  if (!isContentless) {
    yield* sql`DROP TABLE projection_thread_messages_fts`;
    yield* createContentlessFtsTable(sql);
    yield* backfillContentlessFtsTable(sql);
    return;
  }

  yield* resetContentlessFtsTable(sql);
  yield* backfillContentlessFtsTable(sql);
});
