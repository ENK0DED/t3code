import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;

  if (!columns.some((column) => column.name === "last_provider_signal_at")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN last_provider_signal_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "last_observable_progress_at")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN last_observable_progress_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "last_signal_kind")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN last_signal_kind TEXT
    `;
  }
});
