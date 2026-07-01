import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration036 from "./036_ProjectionThreadProvenance.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadProvenance", (it) => {
  it.effect("backfills existing threads as user-created with no creator thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_thread_id TEXT,
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
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        ) VALUES (
          'thread-existing',
          'project-existing',
          'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.5"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* Migration036;

      const rows = yield* sql<{
        readonly created_via: string;
        readonly created_by_thread_id: string | null;
      }>`
        SELECT created_via, created_by_thread_id
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.strictEqual(rows[0]?.created_via, "user");
      assert.strictEqual(rows[0]?.created_by_thread_id ?? null, null);
    }),
  );
});
