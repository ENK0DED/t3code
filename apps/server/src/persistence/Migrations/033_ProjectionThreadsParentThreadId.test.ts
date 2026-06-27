import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration033 from "./033_ProjectionThreadsParentThreadId.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadsParentThreadId", (it) => {
  it.effect("adds nullable parent_thread_id column without creating an unused parent index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          model_selection_json TEXT NOT NULL,
          runtime_mode TEXT NOT NULL,
          interaction_mode TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          latest_user_message_at TEXT,
          pending_approval_count INTEGER NOT NULL DEFAULT 0,
          pending_user_input_count INTEGER NOT NULL DEFAULT 0,
          has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT
        )
      `;

      yield* Migration033;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columns.some((column) => column.name === "parent_thread_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.isFalse(indexes.some((index) => index.name === "idx_projection_threads_parent"));
    }),
  );
});
