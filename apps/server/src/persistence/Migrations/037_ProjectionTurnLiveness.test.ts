import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration037 from "./037_ProjectionTurnLiveness.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProjectionTurnLiveness", (it) => {
  it.effect("adds nullable liveness columns idempotently without disturbing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          pending_message_id TEXT,
          source_proposed_plan_thread_id TEXT,
          source_proposed_plan_id TEXT,
          assistant_message_id TEXT,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          checkpoint_turn_count INTEGER,
          checkpoint_ref TEXT,
          checkpoint_status TEXT,
          checkpoint_files_json TEXT NOT NULL,
          UNIQUE (thread_id, turn_id),
          UNIQUE (thread_id, checkpoint_turn_count)
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        ) VALUES (
          'thread-1',
          'turn-1',
          'message-1',
          NULL,
          NULL,
          'assistant-1',
          'completed',
          '2026-06-29T00:00:00.000Z',
          '2026-06-29T00:00:01.000Z',
          '2026-06-29T00:00:02.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[]'
        )
      `;

      yield* Migration037;
      yield* Migration037;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.isTrue(columns.some((column) => column.name === "last_provider_signal_at"));
      assert.isTrue(columns.some((column) => column.name === "last_observable_progress_at"));
      assert.isTrue(columns.some((column) => column.name === "last_signal_kind"));

      const rows = yield* sql<{
        readonly threadId: string;
        readonly turnId: string | null;
        readonly lastProviderSignalAt: string | null;
        readonly lastObservableProgressAt: string | null;
        readonly lastSignalKind: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          last_provider_signal_at AS "lastProviderSignalAt",
          last_observable_progress_at AS "lastObservableProgressAt",
          last_signal_kind AS "lastSignalKind"
        FROM projection_turns
        WHERE thread_id = 'thread-1'
          AND turn_id = 'turn-1'
      `;
      assert.deepEqual(rows, [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          lastProviderSignalAt: null,
          lastObservableProgressAt: null,
          lastSignalKind: null,
        },
      ]);
    }),
  );
});
