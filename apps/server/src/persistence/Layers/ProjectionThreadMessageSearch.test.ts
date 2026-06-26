import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadMessageSearchRepositoryLive } from "./ProjectionThreadMessageSearch.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadMessageSearchRepository } from "../Services/ProjectionThreadMessageSearch.ts";

const layer = it.layer(
  ProjectionThreadMessageSearchRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const backfillThreadMessageFts = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO projection_thread_messages_fts(projection_thread_messages_fts)
      VALUES ('delete-all')
    `;
    yield* sql`
      INSERT INTO projection_thread_messages_fts (
        rowid,
        text
      )
      SELECT rowid, text
      FROM projection_thread_messages
    `;
  });

layer("ProjectionThreadMessageSearchRepository", (it) => {
  it.effect("searches active project threads and excludes archived threads by default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project',
          '/repo',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          parent_thread_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-1',
            NULL,
            'Active',
            '{"instanceId":"codex","model":"gpt-5.5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-archived',
            'project-1',
            NULL,
            'Archived',
            '{"instanceId":"codex","model":"gpt-5.5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            NULL,
            0,
            0,
            0,
            NULL
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
        VALUES
          (
            'message-active',
            'thread-active',
            NULL,
            'user',
            'Find reconnect problem',
            NULL,
            0,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          ),
          (
            'message-archived',
            'thread-archived',
            NULL,
            'user',
            'Find reconnect archive',
            NULL,
            0,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          )
      `;
      yield* backfillThreadMessageFts(sql);

      const repo = yield* ProjectionThreadMessageSearchRepository;
      const hits = yield* repo.searchByProject({
        projectId: ProjectId.make("project-1"),
        query: "reconnect",
        archived: "exclude",
        limit: 20,
      });

      assert.deepEqual(
        hits.map((hit) => hit.threadId),
        ["thread-active"],
      );
      assert.isTrue((hits[0]?.snippet ?? "").includes("reconnect"));
    }),
  );

  it.effect("supports include and only archive filters", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-filters',
          'Project',
          '/repo',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          parent_thread_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-include-active',
            'project-archive-filters',
            NULL,
            'Active',
            '{"instanceId":"codex","model":"gpt-5.5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-include-archived',
            'project-archive-filters',
            NULL,
            'Archived',
            '{"instanceId":"codex","model":"gpt-5.5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            NULL,
            0,
            0,
            0,
            NULL
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
        VALUES
          (
            'message-include-active',
            'thread-include-active',
            NULL,
            'user',
            'Reconnect active result',
            NULL,
            0,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          ),
          (
            'message-include-archived',
            'thread-include-archived',
            NULL,
            'user',
            'Reconnect archived result',
            NULL,
            0,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          )
      `;
      yield* backfillThreadMessageFts(sql);

      const repo = yield* ProjectionThreadMessageSearchRepository;
      const includeHits = yield* repo.searchByProject({
        projectId: ProjectId.make("project-archive-filters"),
        query: "reconnect",
        archived: "include",
        limit: 20,
      });
      const onlyHits = yield* repo.searchByProject({
        projectId: ProjectId.make("project-archive-filters"),
        query: "reconnect",
        archived: "only",
        limit: 20,
      });

      assert.deepEqual(includeHits.map((hit) => hit.threadId).sort(), [
        "thread-include-active",
        "thread-include-archived",
      ]);
      assert.deepEqual(
        onlyHits.map((hit) => hit.threadId),
        ["thread-include-archived"],
      );
    }),
  );

  it.effect("excludes deleted threads even when the FTS row matches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted-thread',
          'Project',
          '/repo',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          parent_thread_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-deleted-active',
            'project-deleted-thread',
            NULL,
            'Active',
            '{"instanceId":"codex","model":"gpt-5.5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-deleted-hidden',
            'project-deleted-thread',
            NULL,
            'Deleted',
            '{"instanceId":"codex","model":"gpt-5.5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-01-02T00:00:00.000Z'
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
        VALUES
          (
            'message-deleted-active',
            'thread-deleted-active',
            NULL,
            'user',
            'Reconnect active thread',
            NULL,
            0,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          ),
          (
            'message-deleted-hidden',
            'thread-deleted-hidden',
            NULL,
            'user',
            'Reconnect deleted thread',
            NULL,
            0,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          )
      `;
      yield* backfillThreadMessageFts(sql);

      const repo = yield* ProjectionThreadMessageSearchRepository;
      const hits = yield* repo.searchByProject({
        projectId: ProjectId.make("project-deleted-thread"),
        query: "reconnect",
        archived: "include",
        limit: 20,
      });

      assert.deepEqual(
        hits.map((hit) => hit.threadId),
        ["thread-deleted-active"],
      );
    }),
  );
});
