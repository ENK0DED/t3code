# T3Code MCP Orchestration Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP orchestration tools that let provider agents discover models/projects/threads, create and message child threads, update thread settings, and inspect history while T3 Code visualizes sub-thread delegation.

**Architecture:** Add durable schema support first, then projection/search support, then a shared `McpOrchestrationService` consumed by thin MCP toolkit handlers. Keep UI changes as consumers of the new contract fields: provider settings writes server-side MCP model preferences, and the sidebar renders projected parent/child thread relationships.

**Tech Stack:** TypeScript, Effect services/schemas/layers, Effect SQL SQLite migrations, React/Vite web UI, Zustand client UI state, MCP tools via `effect/unstable/ai`.

## Global Constraints

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
- Use `vp test` for the built-in Vite+ test command and `vp run test` only when specifically needing the package `test` script.
- Do not edit files under `.repos/`.
- Before writing Effect code, read `.repos/effect-smol/LLMS.md` and use `Effect.gen` / named `Effect.fn` for service logic.
- Keep `packages/contracts` schema-only.
- Keep `packages/shared` runtime helpers under explicit subpath exports; do not add a barrel index.
- Use existing orchestration commands, projection pipeline, provider registry, and settings service patterns instead of parallel state.
- Do not queue messages into active threads. MCP write tools must error unless the target thread is idle/ready.
- The unrelated dirty file `apps/mobile/app.config.ts` existed before planning; do not modify or revert it.

---

## File Structure

Create or modify these focused units:

- `packages/contracts/src/settings.ts`: server setting and patch schema for MCP-disabled model slugs.
- `packages/contracts/src/settings.test.ts`: decode/patch/default behavior for MCP model enablement.
- `packages/contracts/src/orchestration.ts`: `parentThreadId` on thread command/event/read-model/shell schemas and bootstrap create-thread schema.
- `packages/contracts/src/orchestration.test.ts`: parent thread decode defaults and command/event coverage.
- `apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.ts`: projection table migration.
- `apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts`: migration assertion.
- `apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.ts`: FTS5 table/triggers or table setup for message search.
- `apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts`: FTS availability and backfill assertion.
- `apps/server/src/persistence/Migrations.ts`: register migrations 033 and 034.
- `apps/server/src/persistence/Services/ProjectionThreads.ts`: add `parentThreadId` to projected thread rows.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`: persist/read parent thread id.
- `apps/server/src/persistence/Services/ProjectionThreadMessageSearch.ts`: new service contract for FTS search.
- `apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.ts`: FTS-backed implementation with bounded fallback.
- `apps/server/src/orchestration/decider.ts`: same-project parent validation and parent payload emission.
- `apps/server/src/orchestration/projector.ts`: in-memory read model support for parent thread id.
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`: projection persistence for parent id and FTS sync on message changes/reverts.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`: include `parentThreadId`, project/thread list helpers, and thread-search query support.
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`: expose query methods needed by MCP service.
- `apps/server/src/textGeneration/TextGeneration.ts`: add thread summary operation.
- `apps/server/src/textGeneration/TextGenerationPrompts.ts`: add thread summary prompt builder.
- provider-specific text generation layers/tests: route the new summary operation through existing configured text generation model flow.
- `apps/server/src/mcp/McpInvocationContext.ts`: add orchestration capabilities.
- `apps/server/src/mcp/McpSessionRegistry.ts`: issue fixed first-party capability set.
- `apps/server/src/mcp/McpHttpServer.ts`: register orchestration toolkit.
- `apps/server/src/mcp/toolkits/orchestration/tools.ts`: MCP tool definitions and JSON schemas.
- `apps/server/src/mcp/toolkits/orchestration/handlers.ts`: thin handlers that call `McpOrchestrationService`.
- `apps/server/src/mcp/Services/McpOrchestrationService.ts`: service interface and errors.
- `apps/server/src/mcp/Layers/McpOrchestrationService.ts`: implementation.
- `apps/server/src/mcp/McpOrchestrationService.test.ts`: unit tests for validation and tool behavior.
- `apps/server/src/ws.ts`: extend bootstrap create-thread path to pass `parentThreadId` for `create_thread(message)`.
- `apps/web/src/components/settings/ProviderModelsSection.tsx`: model MCP enablement toggle.
- `apps/web/src/modelSelection.ts`: helpers for reading and toggling MCP-disabled model slugs.
- `apps/web/src/components/Sidebar.logic.ts`: tree-building, visible-row flattening, descendant status roll-up helpers.
- `apps/web/src/components/Sidebar.logic.test.ts`: tree helper tests.
- `apps/web/src/components/Sidebar.tsx`: recursive or flattened nested rendering and expansion state.
- `apps/web/src/uiStateStore.ts`: persisted or client-local thread tree expansion state.
- `apps/web/src/types.ts`, `apps/web/src/store.ts`, `apps/web/src/threadDerivation.ts`: include `parentThreadId` in client thread shapes.

---

### Task 1: Contracts For MCP Model Settings And Thread Parents

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/orchestration.test.ts`

**Interfaces:**

- Produces: `ServerSettings.mcpDisabledModelsByProvider: Record<ProviderInstanceId, string[]>`
- Produces: `ServerSettingsPatch.mcpDisabledModelsByProvider?: Record<ProviderInstanceId, string[]>`
- Produces: `parentThreadId: ThreadId | null` on thread create command, bootstrap create-thread payload, created event payload, read-model thread, and shell thread.
- Consumed by: persistence, MCP service, provider settings UI, sidebar.

- [ ] **Step 1: Write failing settings schema tests**

Add tests to `packages/contracts/src/settings.test.ts`:

```ts
describe("ServerSettings.mcpDisabledModelsByProvider", () => {
  it("defaults to an empty disabled-model map", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.mcpDisabledModelsByProvider).toEqual({});
  });

  it("decodes disabled model slugs by provider instance id", () => {
    const decoded = decodeServerSettings({
      mcpDisabledModelsByProvider: {
        codex: ["gpt-5.5"],
        codex_work: ["company/private-model"],
      },
    });

    expect(decoded.mcpDisabledModelsByProvider.codex).toEqual(["gpt-5.5"]);
    expect(decoded.mcpDisabledModelsByProvider.codex_work).toEqual(["company/private-model"]);
  });

  it("accepts whole-map replacement in server settings patches", () => {
    const patch = decodeServerSettingsPatch({
      mcpDisabledModelsByProvider: {
        claudeAgent: ["claude-opus-4-6"],
      },
    });

    expect(patch.mcpDisabledModelsByProvider).toEqual({
      claudeAgent: ["claude-opus-4-6"],
    });
  });
});
```

- [ ] **Step 2: Run settings tests and verify they fail**

Run:

```sh
vp test packages/contracts/src/settings.test.ts
```

Expected: FAIL because `mcpDisabledModelsByProvider` is not in `ServerSettings` or `ServerSettingsPatch`.

- [ ] **Step 3: Implement settings schema**

In `packages/contracts/src/settings.ts`, add this schema near `ServerSettings`:

```ts
const McpDisabledModelsByProvider = Schema.Record(
  ProviderInstanceId,
  Schema.Array(TrimmedNonEmptyString),
);
```

Add this field to `ServerSettings`:

```ts
mcpDisabledModelsByProvider: McpDisabledModelsByProvider.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
),
```

Add this field to `ServerSettingsPatch`:

```ts
mcpDisabledModelsByProvider: Schema.optionalKey(McpDisabledModelsByProvider),
```

- [ ] **Step 4: Run settings tests and verify they pass**

Run:

```sh
vp test packages/contracts/src/settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing orchestration parent tests**

Add tests to `packages/contracts/src/orchestration.test.ts`:

```ts
it.effect("decodes thread parent relationships on thread.create", () =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknown(OrchestrationCommand)({
      type: "thread.create",
      commandId: "cmd-parent-thread",
      threadId: "thread-child",
      projectId: "project-1",
      parentThreadId: "thread-parent",
      title: "Child",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.create");
    if (parsed.type === "thread.create") {
      assert.strictEqual(parsed.parentThreadId, "thread-parent");
    }
  }),
);

it.effect("defaults omitted thread parent relationships to null", () =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknown(OrchestrationCommand)({
      type: "thread.create",
      commandId: "cmd-top-level-thread",
      threadId: "thread-top",
      projectId: "project-1",
      title: "Top",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.create");
    if (parsed.type === "thread.create") {
      assert.strictEqual(parsed.parentThreadId, null);
    }
  }),
);
```

- [ ] **Step 6: Run orchestration tests and verify they fail**

Run:

```sh
vp test packages/contracts/src/orchestration.test.ts
```

Expected: FAIL because `parentThreadId` is not decoded on thread commands.

- [ ] **Step 7: Implement orchestration parent schemas**

In `packages/contracts/src/orchestration.ts`, add `parentThreadId` to:

```ts
export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: TrimmedNonEmptyString,
  // existing fields remain unchanged
});
```

```ts
export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: TrimmedNonEmptyString,
  // existing fields remain unchanged
});
```

```ts
const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: TrimmedNonEmptyString,
  // existing fields remain unchanged
});
```

```ts
const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: TrimmedNonEmptyString,
  // existing fields remain unchanged
});
```

```ts
export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: TrimmedNonEmptyString,
  // existing fields remain unchanged
});
```

- [ ] **Step 8: Run contracts tests**

Run:

```sh
vp test packages/contracts/src/settings.test.ts packages/contracts/src/orchestration.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```sh
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts
git commit -m "feat: add MCP model and thread parent contracts"
```

---

### Task 2: Persist Parent Thread Relationships

**Files:**

- Create: `apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.ts`
- Create: `apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionThreads.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- Modify: `apps/server/src/orchestration/decider.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`
- Test: existing orchestration/projector/projection tests touched by changed snapshots.

**Interfaces:**

- Consumes: `parentThreadId: ThreadId | null` from Task 1.
- Produces: persisted `projection_threads.parent_thread_id`.
- Produces: shell/detail/read-model snapshots carrying `parentThreadId`.
- Consumed by: MCP service, sidebar tree rendering.

- [ ] **Step 1: Write failing migration test**

Create `apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration033 from "./033_ProjectionThreadsParentThreadId.ts";

const layer = Layer.mergeAll(NodeSqliteClient.layerMemory());

describe("Migration033 ProjectionThreadsParentThreadId", () => {
  it.effect("adds nullable parent_thread_id column and index", () =>
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
      expect(columns.some((column) => column.name === "parent_thread_id")).toBe(true);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      expect(indexes.some((index) => index.name === "idx_projection_threads_parent")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
```

- [ ] **Step 2: Run migration test and verify it fails**

Run:

```sh
vp test apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts
```

Expected: FAIL because migration file does not exist.

- [ ] **Step 3: Add migration**

Create `apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.ts`:

```ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent
    ON projection_threads(project_id, parent_thread_id, deleted_at, archived_at, updated_at)
  `;
});
```

Register it in `apps/server/src/persistence/Migrations.ts`:

```ts
import Migration0033 from "./Migrations/033_ProjectionThreadsParentThreadId.ts";
```

Add to the ordered migration list:

```ts
[33, "ProjectionThreadsParentThreadId", Migration0033],
```

- [ ] **Step 4: Run migration test and verify it passes**

Run:

```sh
vp test apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing same-project parent invariant test**

Add a test to `apps/server/src/orchestration/commandInvariants.test.ts`:

```ts
it.effect("rejects a parent thread in a different project", () =>
  Effect.gen(function* () {
    const readModel = {
      snapshotSequence: 0,
      projects: [
        makeProject({ id: ProjectId.make("project-a") }),
        makeProject({ id: ProjectId.make("project-b") }),
      ],
      threads: [
        makeThread({
          id: ThreadId.make("thread-parent"),
          projectId: ProjectId.make("project-a"),
        }),
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const result = yield* Effect.exit(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-cross-project-parent"),
          threadId: ThreadId.make("thread-child"),
          projectId: ProjectId.make("project-b"),
          parentThreadId: ThreadId.make("thread-parent"),
          title: "Child",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    expect(Exit.isFailure(result)).toBe(true);
  }),
);
```

Use the existing project/thread factory helpers already defined in `apps/server/src/orchestration/commandInvariants.test.ts`; keep the command payload exactly as shown.

- [ ] **Step 6: Run invariant test and verify it fails**

Run:

```sh
vp test apps/server/src/orchestration/commandInvariants.test.ts
```

Expected: FAIL until the decider validates parent project membership.

- [ ] **Step 7: Implement decider/projector/projection support**

Update `apps/server/src/orchestration/decider.ts` in the `thread.create` case before emitting `thread.created`:

```ts
if (command.parentThreadId !== null) {
  const parentThread = readModel.threads.find((thread) => thread.id === command.parentThreadId);
  if (!parentThread || parentThread.deletedAt !== null) {
    return (
      yield *
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Parent thread '${command.parentThreadId}' does not exist.`,
      })
    );
  }
  if (parentThread.projectId !== command.projectId) {
    return (
      yield *
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Parent thread '${command.parentThreadId}' belongs to a different project.`,
      })
    );
  }
}
```

Add the payload field:

```ts
parentThreadId: command.parentThreadId,
```

Update `apps/server/src/orchestration/projector.ts` thread creation mapping:

```ts
parentThreadId: payload.parentThreadId,
```

Update `apps/server/src/persistence/Services/ProjectionThreads.ts`:

```ts
parentThreadId: Schema.NullOr(ThreadId),
```

Update insert/select/upsert SQL in `apps/server/src/persistence/Layers/ProjectionThreads.ts` to include:

```sql
parent_thread_id
```

with aliases:

```sql
parent_thread_id AS "parentThreadId"
```

Update `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` thread-created projection row:

```ts
parentThreadId: event.payload.parentThreadId,
```

Update `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` row schemas, SQL selects, and mappers so every `OrchestrationThread` and `OrchestrationThreadShell` includes:

```ts
parentThreadId: row.parentThreadId,
```

- [ ] **Step 8: Extend bootstrap thread creation**

In `apps/server/src/ws.ts`, where `dispatchBootstrapTurnStart` creates a `thread.create` command from `bootstrap.createThread`, pass:

```ts
parentThreadId: bootstrapCreateThread.parentThreadId,
```

This allows `create_thread(message)` to create child threads atomically through the existing bootstrap path.

- [ ] **Step 9: Run focused server tests**

Run:

```sh
vp test apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts apps/server/src/orchestration/commandInvariants.test.ts apps/server/src/orchestration/projector.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts
```

Expected: PASS. Update existing fixtures by adding `parentThreadId: null` where strict equality requires it.

- [ ] **Step 10: Commit**

Run:

```sh
git add apps/server/src/persistence/Migrations.ts apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.ts apps/server/src/persistence/Migrations/033_ProjectionThreadsParentThreadId.test.ts apps/server/src/persistence/Services/ProjectionThreads.ts apps/server/src/persistence/Layers/ProjectionThreads.ts apps/server/src/orchestration/decider.ts apps/server/src/orchestration/projector.ts apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts apps/server/src/ws.ts
git commit -m "feat: persist thread parent relationships"
```

---

### Task 3: Add FTS-Backed Thread Message Search

**Files:**

- Create: `apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.ts`
- Create: `apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts`
- Create: `apps/server/src/persistence/Services/ProjectionThreadMessageSearch.ts`
- Create: `apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.ts`
- Create: `apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.test.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`

**Interfaces:**

- Produces: `ProjectionThreadMessageSearchRepository.searchByProject(input)`
- Produces result shape:

```ts
export interface ProjectionThreadMessageSearchHit {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly role: OrchestrationMessageRole;
  readonly snippet: string;
  readonly rank: number;
  readonly createdAt: string;
}
```

- Consumed by: `McpOrchestrationService.listThreads`.

- [ ] **Step 1: Write failing FTS migration test**

Create `apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration034 from "./034_ProjectionThreadMessagesFts.ts";

const layer = Layer.mergeAll(NodeSqliteClient.layerMemory());

describe("Migration034 ProjectionThreadMessagesFts", () => {
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
      expect(rows).toEqual([{ messageId: "message-1" }]);
    }).pipe(Effect.provide(layer)),
  );
});
```

- [ ] **Step 2: Run migration test and verify it fails**

Run:

```sh
vp test apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts
```

Expected: FAIL because migration file does not exist.

- [ ] **Step 3: Add FTS migration**

Create `apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.ts`:

```ts
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
      content='',
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
```

Register in `apps/server/src/persistence/Migrations.ts`:

```ts
import Migration0034 from "./Migrations/034_ProjectionThreadMessagesFts.ts";
```

Add:

```ts
[34, "ProjectionThreadMessagesFts", Migration0034],
```

- [ ] **Step 4: Run migration test and verify it passes**

Run:

```sh
vp test apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing search repository test**

Create `apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadMessageSearchRepository } from "../Services/ProjectionThreadMessageSearch.ts";
import { ProjectionThreadMessageSearchRepositoryLive } from "./ProjectionThreadMessageSearch.ts";

const layer = ProjectionThreadMessageSearchRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

describe("ProjectionThreadMessageSearchRepository", () => {
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
      yield* sql`
        INSERT INTO projection_thread_messages_fts (
          message_id,
          thread_id,
          role,
          text,
          created_at
        )
        SELECT message_id, thread_id, role, text, created_at
        FROM projection_thread_messages
      `;

      const repo = yield* ProjectionThreadMessageSearchRepository;
      const hits = yield* repo.searchByProject({
        projectId: ProjectId.make("project-1"),
        query: "reconnect",
        archived: "exclude",
        limit: 20,
      });

      expect(hits.map((hit) => hit.threadId)).toEqual(["thread-active"]);
      expect(hits[0]?.snippet).toContain("reconnect");
    }).pipe(Effect.provide(layer)),
  );
});
```

- [ ] **Step 6: Implement search service**

Create `apps/server/src/persistence/Services/ProjectionThreadMessageSearch.ts`:

```ts
import { MessageId, OrchestrationMessageRole, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadArchiveFilter = Schema.Literals("exclude", "include", "only");
export type ProjectionThreadArchiveFilter = typeof ProjectionThreadArchiveFilter.Type;

export const SearchProjectionThreadMessagesInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.String,
  archived: ProjectionThreadArchiveFilter,
  limit: Schema.Int.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(100)),
});
export type SearchProjectionThreadMessagesInput = typeof SearchProjectionThreadMessagesInput.Type;

export const ProjectionThreadMessageSearchHit = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  snippet: Schema.String,
  rank: Schema.Number,
  createdAt: Schema.String,
});
export type ProjectionThreadMessageSearchHit = typeof ProjectionThreadMessageSearchHit.Type;

export interface ProjectionThreadMessageSearchRepositoryShape {
  readonly searchByProject: (
    input: SearchProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessageSearchHit>, ProjectionRepositoryError>;
}

export class ProjectionThreadMessageSearchRepository extends Context.Service<
  ProjectionThreadMessageSearchRepository,
  ProjectionThreadMessageSearchRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadMessageSearch/ProjectionThreadMessageSearchRepository",
) {}
```

Create `apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.ts` using `SqlSchema.findAll`. The query must join `projection_threads` and apply archive filters:

```ts
const archivePredicate = (archived: ProjectionThreadArchiveFilter) => {
  switch (archived) {
    case "exclude":
      return sql`threads.archived_at IS NULL`;
    case "only":
      return sql`threads.archived_at IS NOT NULL`;
    case "include":
      return sql`1 = 1`;
  }
};
```

Use `snippet(projection_thread_messages_fts, 3, '<mark>', '</mark>', '...', 12)` for snippets and `bm25(projection_thread_messages_fts)` for rank. Sanitize user input into a simple FTS query by splitting on whitespace, dropping empty terms, escaping double quotes, and joining quoted terms with spaces:

```ts
function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', '""'))
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(" ");
}
```

If the normalized query is empty, return `Effect.succeed([])`.

- [ ] **Step 7: Wire FTS sync in projection pipeline**

In `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, after message upserts and deletes, mirror changes to `projection_thread_messages_fts` in the same projection transaction. Use explicit helpers:

```ts
const upsertMessageFts = (message: ProjectionThreadMessage) =>
  sql`
    INSERT INTO projection_thread_messages_fts (
      message_id,
      thread_id,
      role,
      text,
      created_at
    )
    VALUES (
      ${message.messageId},
      ${message.threadId},
      ${message.role},
      ${message.text},
      ${message.createdAt}
    )
  `;

const deleteMessageFtsByThread = (threadId: ThreadId) =>
  sql`
    DELETE FROM projection_thread_messages_fts
    WHERE thread_id = ${threadId}
  `;
```

For message replacement, delete the existing FTS row by `message_id` before inserting the new row.

- [ ] **Step 8: Run search tests**

Run:

```sh
vp test apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```sh
git add apps/server/src/persistence/Migrations.ts apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.ts apps/server/src/persistence/Migrations/034_ProjectionThreadMessagesFts.test.ts apps/server/src/persistence/Services/ProjectionThreadMessageSearch.ts apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.ts apps/server/src/persistence/Layers/ProjectionThreadMessageSearch.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts
git commit -m "feat: add thread message search index"
```

---

### Task 4: Add MCP Orchestration Tool Schemas And Capability Wiring

**Files:**

- Modify: `apps/server/src/mcp/McpInvocationContext.ts`
- Modify: `apps/server/src/mcp/McpSessionRegistry.ts`
- Modify: `apps/server/src/mcp/McpHttpServer.ts`
- Create: `apps/server/src/mcp/Services/McpOrchestrationService.ts`
- Create: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Create: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Create: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/McpHttpServer.test.ts`

**Interfaces:**

- Produces MCP capabilities: `"preview" | "orchestration.read" | "orchestration.write"`.
- Produces toolkit tools with names:
  - `list_mcp_models`
  - `list_projects`
  - `list_threads`
  - `get_thread_history`
  - `get_current_thread_settings`
  - `add_project`
  - `create_thread`
  - `send_thread_message`
  - `update_thread_settings`
- Consumed by: `McpOrchestrationService` implementation in Task 5 and Task 6.

- [ ] **Step 1: Write failing MCP capability test**

In `apps/server/src/mcp/McpHttpServer.test.ts`, update the test fixture invocation to include orchestration capabilities:

```ts
capabilities: new Set([
  "preview",
  "orchestration.read",
  "orchestration.write",
] as const),
```

Add a test:

```ts
it.effect("issues provider MCP credentials with orchestration capabilities", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });

    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);

    expect(resolved?.capabilities.has("preview")).toBe(true);
    expect(resolved?.capabilities.has("orchestration.read")).toBe(true);
    expect(resolved?.capabilities.has("orchestration.write")).toBe(true);
  }),
);
```

- [ ] **Step 2: Run MCP tests and verify they fail**

Run:

```sh
vp test apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts
```

Expected: FAIL because capability literals do not exist and issued credentials only include `preview`.

- [ ] **Step 3: Implement capability literals**

In `apps/server/src/mcp/McpInvocationContext.ts`:

```ts
export type McpCapability = "preview" | "orchestration.read" | "orchestration.write";
```

Add named wrappers:

```ts
export const requireMcpOrchestrationRead = Effect.fn("mcp.requireOrchestrationRead")(function* () {
  return yield* requireMcpCapability("orchestration.read");
});

export const requireMcpOrchestrationWrite = Effect.fn("mcp.requireOrchestrationWrite")(
  function* () {
    return yield* requireMcpCapability("orchestration.write");
  },
);
```

In `apps/server/src/mcp/McpSessionRegistry.ts`, issue:

```ts
capabilities: new Set(["preview", "orchestration.read", "orchestration.write"]),
```

- [ ] **Step 4: Create orchestration toolkit schema file**

Create `apps/server/src/mcp/toolkits/orchestration/tools.ts` with Tool definitions using `effect/unstable/ai` like the preview toolkit. Define input schemas with Effect Schema. The exact names must be:

```ts
export const ListMcpModelsTool = Tool.make("list_mcp_models", {
  description: "Return provider instances and MCP-enabled models available to MCP tools.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({}),
});
```

Define the remaining tools with parameter schemas:

```ts
export const ListProjectsTool = Tool.make("list_projects", {
  description: "Return T3Code projects, optionally fuzzy searched by title or path.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    search: Schema.optional(Schema.String),
  }),
});
```

```ts
export const ListThreadsTool = Tool.make("list_threads", {
  description: "Return threads for a project, optionally searched by title and message history.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    projectId: ProjectId,
    search: Schema.optional(Schema.String),
    archived: Schema.optional(Schema.Literals("exclude", "include", "only")),
  }),
});
```

```ts
export const GetThreadHistoryTool = Tool.make("get_thread_history", {
  description: "Return a thread summary or complete projected thread history.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    threadId: ThreadId,
    mode: Schema.Literals("summary", "complete"),
    limit: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
    cursor: Schema.optional(Schema.String),
    maxCharacters: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
  }),
});
```

Define the remaining tools:

```ts
export const GetCurrentThreadSettingsTool = Tool.make("get_current_thread_settings", {
  description: "Return settings for the current MCP credential thread.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({}),
});

export const AddProjectTool = Tool.make("add_project", {
  description:
    "Add a project by source directory path, returning an existing project for duplicate paths.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    path: Schema.String,
  }),
});

export const ThreadPlacement = Schema.Literals("child_of_current", "top_level", "child_of_thread");

export const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Create a T3Code thread, optionally as a child thread and optionally with a first message.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    placement: Schema.optional(ThreadPlacement),
    parentThreadId: Schema.optional(ThreadId),
    title: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    checkoutMode: Schema.optional(Schema.Literals("current_checkout", "new_worktree")),
    branch: Schema.optional(Schema.NullOr(Schema.String)),
    worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
    baseBranch: Schema.optional(Schema.String),
  }),
});

export const SendThreadMessageTool = Tool.make("send_thread_message", {
  description: "Send a user message to an existing idle thread and return after turn acceptance.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    threadId: ThreadId,
    message: Schema.String,
    modelSelection: Schema.optional(ModelSelection),
  }),
});

export const UpdateThreadSettingsTool = Tool.make("update_thread_settings", {
  description: "Update settings for an existing idle thread.",
  success: Schema.Unknown,
  failure: Schema.Never,
  parameters: Schema.Struct({
    threadId: ThreadId,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    checkoutMode: Schema.optional(Schema.Literals("current_checkout", "new_worktree")),
    branch: Schema.optional(Schema.NullOr(Schema.String)),
    worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
    baseBranch: Schema.optional(Schema.String),
  }),
});
```

Export:

```ts
export const OrchestrationToolkit = Toolkit.make(
  ListMcpModelsTool,
  ListProjectsTool,
  ListThreadsTool,
  GetThreadHistoryTool,
  GetCurrentThreadSettingsTool,
  AddProjectTool,
  CreateThreadTool,
  SendThreadMessageTool,
  UpdateThreadSettingsTool,
);
```

- [ ] **Step 5: Create compiling service skeleton**

Create `apps/server/src/mcp/Services/McpOrchestrationService.ts`:

```ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class McpOrchestrationError extends Schema.TaggedErrorClass<McpOrchestrationError>()(
  "McpOrchestrationError",
  {
    code: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export interface McpOrchestrationServiceShape {
  readonly listMcpModels: () => Effect.Effect<unknown, McpOrchestrationError>;
  readonly listProjects: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly listThreads: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly getThreadHistory: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly getCurrentThreadSettings: () => Effect.Effect<unknown, McpOrchestrationError>;
  readonly addProject: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly createThread: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly sendThreadMessage: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly updateThreadSettings: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
}

export class McpOrchestrationService extends Context.Service<
  McpOrchestrationService,
  McpOrchestrationServiceShape
>()("t3/mcp/Services/McpOrchestrationService/McpOrchestrationService") {}
```

Create `apps/server/src/mcp/Layers/McpOrchestrationService.ts`:

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  McpOrchestrationError,
  McpOrchestrationService,
} from "../Services/McpOrchestrationService.ts";

const notImplemented = (tool: string) =>
  new McpOrchestrationError({
    code: "not_implemented",
    message: `MCP orchestration tool '${tool}' is registered but not implemented yet.`,
  });

export const McpOrchestrationServiceLive = Layer.succeed(
  McpOrchestrationService,
  McpOrchestrationService.of({
    listMcpModels: () => Effect.fail(notImplemented("list_mcp_models")),
    listProjects: () => Effect.fail(notImplemented("list_projects")),
    listThreads: () => Effect.fail(notImplemented("list_threads")),
    getThreadHistory: () => Effect.fail(notImplemented("get_thread_history")),
    getCurrentThreadSettings: () => Effect.fail(notImplemented("get_current_thread_settings")),
    addProject: () => Effect.fail(notImplemented("add_project")),
    createThread: () => Effect.fail(notImplemented("create_thread")),
    sendThreadMessage: () => Effect.fail(notImplemented("send_thread_message")),
    updateThreadSettings: () => Effect.fail(notImplemented("update_thread_settings")),
  }),
);
```

- [ ] **Step 6: Create orchestration handlers file**

Create `apps/server/src/mcp/toolkits/orchestration/handlers.ts` with one delegating handler per tool:

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OrchestrationToolkit } from "./tools.ts";
import { McpOrchestrationService } from "../../Services/McpOrchestrationService.ts";

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer({
  list_mcp_models: () =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.listMcpModels();
    }),
  list_projects: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.listProjects(input);
    }),
  list_threads: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.listThreads(input);
    }),
  get_thread_history: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.getThreadHistory(input);
    }),
  get_current_thread_settings: () =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.getCurrentThreadSettings();
    }),
  add_project: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.addProject(input);
    }),
  create_thread: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.createThread(input);
    }),
  send_thread_message: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.sendThreadMessage(input);
    }),
  update_thread_settings: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.updateThreadSettings(input);
    }),
});
```

Use the exact handler registration pattern from `apps/server/src/mcp/toolkits/preview/handlers.ts` if the toolkit API names differ from the snippet.

- [ ] **Step 7: Register toolkit in MCP HTTP server**

In `apps/server/src/mcp/McpHttpServer.ts`, import the toolkit registration and merge it with preview:

```ts
import { OrchestrationToolkitHandlersLive } from "./toolkits/orchestration/handlers.ts";
import { OrchestrationToolkit } from "./toolkits/orchestration/tools.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
```

Add:

```ts
const OrchestrationToolkitRegistrationLive = McpServer.toolkit(OrchestrationToolkit).pipe(
  Layer.provide(OrchestrationToolkitHandlersLive),
);
```

Merge:

```ts
export const McpToolkitRegistrationLive = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  OrchestrationToolkitRegistrationLive,
);
```

Keep `PreviewToolkitRegistrationLive` exported for existing tests. Change the final `layer` to use `McpToolkitRegistrationLive` and provide `McpOrchestrationServiceLive`.

- [ ] **Step 8: Run MCP tests**

Run:

```sh
vp test apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts
```

Expected: PASS. Tool registration succeeds, while direct calls to orchestration tools return structured `not_implemented` errors until Task 5 and Task 7 replace the skeleton methods.

- [ ] **Step 9: Commit**

Run:

```sh
git add apps/server/src/mcp/McpInvocationContext.ts apps/server/src/mcp/McpSessionRegistry.ts apps/server/src/mcp/McpHttpServer.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/Services/McpOrchestrationService.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts
git commit -m "feat: register MCP orchestration toolkit"
```

---

### Task 5: Implement MCP Read Service Methods

**Files:**

- Modify: `apps/server/src/mcp/Services/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Create: `apps/server/src/mcp/McpOrchestrationService.read.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/McpHttpServer.ts`
- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`

**Interfaces:**

- Consumes: provider snapshots from `ProviderRegistry`.
- Consumes: server settings from `ServerSettingsService`.
- Consumes: project/thread snapshots and FTS hits from projection query/search services.
- Produces methods:

```ts
listMcpModels(): Effect.Effect<ListMcpModelsResult, McpOrchestrationError>
listProjects(input: { search?: string }): Effect.Effect<ListProjectsResult, McpOrchestrationError>
listThreads(input: { projectId: ProjectId; search?: string; archived?: "exclude" | "include" | "only" }): Effect.Effect<ListThreadsResult, McpOrchestrationError>
getCurrentThreadSettings(): Effect.Effect<CurrentThreadSettingsResult, McpOrchestrationError>
```

- [ ] **Step 1: Write failing read-service tests**

Create `apps/server/src/mcp/McpOrchestrationService.read.test.ts` with tests for:

```ts
it.effect("listMcpModels excludes models disabled in server settings", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listMcpModels();

    expect(result.providers.codex.models["gpt-5.5"]).toBeDefined();
    expect(result.providers.codex.models["gpt-disabled"]).toBeUndefined();
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        providers: [
          providerSnapshot({
            instanceId: "codex",
            driver: "codex",
            models: [
              { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
              { slug: "gpt-disabled", name: "Disabled", isCustom: false, capabilities: null },
            ],
          }),
        ],
        settings: {
          mcpDisabledModelsByProvider: {
            codex: ["gpt-disabled"],
          },
        },
      }),
    ),
  ),
);
```

```ts
it.effect("listProjects fuzzy searches title and workspace path", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listProjects({ search: "backend api" });

    expect(result.projects.map((project) => project.id)).toEqual(["project-api"]);
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        projects: [
          { id: "project-api", title: "API Server", workspaceRoot: "/work/backend" },
          { id: "project-web", title: "Web App", workspaceRoot: "/work/frontend" },
        ],
      }),
    ),
  ),
);
```

```ts
it.effect("listThreads defaults to excluding archived threads", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listThreads({
      projectId: ProjectId.make("project-1"),
    });

    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-active"]);
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        threads: [
          { id: "thread-active", projectId: "project-1", archivedAt: null },
          { id: "thread-archived", projectId: "project-1", archivedAt: "2026-01-02T00:00:00.000Z" },
        ],
      }),
    ),
  ),
);
```

Implement `makeReadHarnessLayer` in the test with mocked `ProviderRegistry`, `ServerSettingsService`, `ProjectionSnapshotQuery`, `ProjectionThreadMessageSearchRepository`, and `McpInvocationContext`.

- [ ] **Step 2: Run read-service tests and verify they fail**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.read.test.ts
```

Expected: FAIL because the service skeleton returns `not_implemented`.

- [ ] **Step 3: Refine service interface types**

Replace the broad `unknown` input/return types in `apps/server/src/mcp/Services/McpOrchestrationService.ts` with named server-local interfaces:

```ts
import {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface McpOrchestrationServiceShape {
  readonly listMcpModels: () => Effect.Effect<ListMcpModelsResult, McpOrchestrationError>;
  readonly listProjects: (input: {
    readonly search?: string | undefined;
  }) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly listThreads: (input: {
    readonly projectId: ProjectId;
    readonly search?: string | undefined;
    readonly archived?: "exclude" | "include" | "only" | undefined;
  }) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly getCurrentThreadSettings: () => Effect.Effect<unknown, McpOrchestrationError>;
  readonly getThreadHistory: (input: {
    readonly threadId: ThreadId;
    readonly mode: "summary" | "complete";
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
    readonly maxCharacters?: number | undefined;
  }) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly addProject: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly createThread: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly sendThreadMessage: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly updateThreadSettings: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
}

export class McpOrchestrationService extends Context.Service<
  McpOrchestrationService,
  McpOrchestrationServiceShape
>()("t3/mcp/Services/McpOrchestrationService/McpOrchestrationService") {}
```

Keep these result/input interfaces in server code, not `packages/contracts`, because they are MCP server implementation details.

- [ ] **Step 4: Implement model enablement helpers**

In `apps/server/src/mcp/Layers/McpOrchestrationService.ts`, add helpers:

```ts
function isModelMcpEnabled(input: {
  readonly settings: ServerSettings;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}): boolean {
  const disabled = input.settings.mcpDisabledModelsByProvider[input.instanceId] ?? [];
  return !disabled.includes(input.model);
}

function modelOptionDescriptors(
  model: ServerProviderModel,
): ReadonlyArray<ProviderOptionDescriptor> {
  return model.capabilities?.optionDescriptors ?? [];
}
```

Implement `listMcpModels` with `ProviderRegistry.getProviders`, `ServerSettingsService.getSettings`, and `requireMcpOrchestrationRead`.

- [ ] **Step 5: Implement project/thread list helpers**

Add these projection query methods:

```ts
readonly listProjectShells: () => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectionRepositoryError>;
readonly listThreadShellsByProject: (input: {
  readonly projectId: ProjectId;
  readonly archived: "exclude" | "include" | "only";
}) => Effect.Effect<ReadonlyArray<OrchestrationThreadShell>, ProjectionRepositoryError>;
```

In `McpOrchestrationService`, use `normalizeSearchQuery`, `scoreQueryMatch`, and `insertRankedSearchResult` from `@t3tools/shared/searchRanking` for project title/path and thread title fuzzy search. Merge FTS hits from `ProjectionThreadMessageSearchRepository.searchByProject`.

- [ ] **Step 6: Implement current settings**

`getCurrentThreadSettings` reads `McpInvocationContext.threadId`, fetches thread shell/detail, resolves provider/model metadata from `ProviderRegistry`, and returns:

```ts
{
  threadId,
  projectId,
  provider: {
    instanceId,
    driver,
    name,
  },
  model: {
    slug,
    name,
  },
  options: [
    {
      id,
      value,
      label,
      valueLabel,
    },
  ],
  runtimeMode,
  interactionMode,
  checkoutMode,
  branch,
  worktreePath,
  session,
}
```

Resolve option labels by matching `thread.modelSelection.options` to the selected model's descriptors.

- [ ] **Step 7: Run read-service tests**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.read.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```sh
git add apps/server/src/mcp/Services/McpOrchestrationService.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts apps/server/src/mcp/McpHttpServer.ts apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
git commit -m "feat: add MCP orchestration read service"
```

---

### Task 6: Implement Thread History Summary And Complete Modes

**Files:**

- Modify: `apps/server/src/textGeneration/TextGeneration.ts`
- Modify: `apps/server/src/textGeneration/TextGenerationPrompts.ts`
- Modify: text generation provider layers that pattern-match operation names
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Create: `apps/server/src/mcp/McpOrchestrationService.history.test.ts`

**Interfaces:**

- Produces: `TextGeneration.generateThreadSummary(input)`
- Produces: `getThreadHistory({ mode: "summary" | "complete" })`.
- Consumed by: MCP `get_thread_history` handler.

- [ ] **Step 1: Write failing history tests**

Create `apps/server/src/mcp/McpOrchestrationService.history.test.ts`:

```ts
it.effect("complete history returns projected thread detail by default", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadHistory({
      threadId: ThreadId.make("thread-1"),
      mode: "complete",
    });

    expect(result).toMatchObject({
      mode: "complete",
      thread: {
        id: "thread-1",
        messages: [
          {
            role: "user",
            text: "Investigate reconnect failures",
          },
        ],
      },
    });
  }).pipe(Effect.provide(makeHistoryHarnessLayer())),
);
```

```ts
it.effect("summary history uses the configured text generation model", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadHistory({
      threadId: ThreadId.make("thread-1"),
      mode: "summary",
    });

    expect(result).toMatchObject({
      mode: "summary",
      threadId: "thread-1",
      summary: "The thread investigated reconnect failures.",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5-mini",
      },
    });
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        generatedSummary: "The thread investigated reconnect failures.",
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5-mini",
        },
      }),
    ),
  ),
);
```

```ts
it.effect("complete history fails instead of truncating when over budget", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadHistory({
        threadId: ThreadId.make("thread-large"),
        mode: "complete",
        maxCharacters: 20,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        largeMessageText: "x".repeat(10_000),
      }),
    ),
  ),
);
```

- [ ] **Step 2: Run history tests and verify they fail**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.history.test.ts
```

Expected: FAIL because summary operation and history implementation do not exist.

- [ ] **Step 3: Add text generation operation**

In `apps/server/src/textGeneration/TextGeneration.ts`, add:

```ts
export interface GenerateThreadSummaryInput {
  readonly threadTitle: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly maxOutputCharacters: number;
}
```

Add to `TextGenerationShape`:

```ts
readonly generateThreadSummary: (
  input: GenerateThreadSummaryInput,
) => Effect.Effect<string, TextGenerationError>;
```

In `apps/server/src/textGeneration/TextGenerationPrompts.ts`, add:

```ts
export function buildThreadSummaryPrompt(input: GenerateThreadSummaryInput): string {
  const transcript = input.messages
    .map((message) => `[${message.createdAt}] ${message.role}: ${message.text}`)
    .join("\n\n");

  return [
    "Summarize this T3 Code thread for another coding agent.",
    "Focus on user goals, decisions, constraints, files touched or discussed, unresolved work, and current state.",
    `Keep the summary under ${input.maxOutputCharacters} characters.`,
    "",
    `Thread title: ${input.threadTitle}`,
    "",
    transcript,
  ].join("\n");
}
```

Wire provider-specific text generation layers by mirroring `generateCommitMessage` structure and using the configured `ServerSettingsService.getSettings.textGenerationModelSelection`.

- [ ] **Step 4: Implement complete history response**

In `McpOrchestrationService.getThreadHistory`, for complete mode:

```ts
const detail = yield * projectionSnapshotQuery.getThreadDetailById(input.threadId);
if (Option.isNone(detail)) {
  return (
    yield *
    new McpOrchestrationError({
      code: "unknown_thread",
      message: `Thread '${input.threadId}' does not exist.`,
    })
  );
}
const payload = {
  mode: "complete" as const,
  thread: applyHistoryWindow(detail.value.thread, input),
};
const encoded = JSON.stringify(payload);
const budget = input.maxCharacters ?? MCP_STRUCTURED_RESPONSE_MAX_BYTES;
if (encoded.length > budget) {
  return (
    yield *
    new McpOrchestrationError({
      code: "payload_too_large",
      message: `Thread '${input.threadId}' history is too large for one MCP response.`,
      detail: "Retry with limit, cursor, or maxCharacters.",
    })
  );
}
return payload;
```

Add a central constant:

```ts
const MCP_STRUCTURED_RESPONSE_MAX_BYTES = 1_000_000;
```

- [ ] **Step 5: Implement summary mode**

For summary mode:

```ts
const settings = yield * serverSettings.getSettings;
const summary =
  yield *
  textGeneration.generateThreadSummary({
    threadTitle: thread.title,
    messages: thread.messages.map((message) => ({
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    })),
    maxOutputCharacters: 12_000,
  });
return {
  mode: "summary" as const,
  threadId: thread.id,
  summary,
  modelSelection: settings.textGenerationModelSelection,
  generatedAt: new Date().toISOString(),
};
```

Use the project’s clock/test time pattern if tests avoid real time.

- [ ] **Step 6: Run history/text-generation tests**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.history.test.ts apps/server/src/textGeneration/CodexTextGeneration.test.ts apps/server/src/textGeneration/ClaudeTextGeneration.test.ts apps/server/src/textGeneration/CursorTextGeneration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```sh
git add apps/server/src/textGeneration/TextGeneration.ts apps/server/src/textGeneration/TextGenerationPrompts.ts apps/server/src/textGeneration apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/McpOrchestrationService.history.test.ts
git commit -m "feat: add MCP thread history summaries"
```

---

### Task 7: Implement MCP Write Service Methods

**Files:**

- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Create: `apps/server/src/mcp/McpOrchestrationService.write.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Create: `packages/shared/src/addProject.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/client-runtime/src/addProject.ts`

**Interfaces:**

- Consumes: `OrchestrationEngineService.dispatch`.
- Consumes: `ProjectionSnapshotQuery` detail/shell/project lookups.
- Consumes: provider registry snapshots and server settings for model validation.
- Produces MCP write methods:
  - `addProject`
  - `createThread`
  - `sendThreadMessage`
  - `updateThreadSettings`

- [ ] **Step 1: Write failing idle-gating tests**

Create `apps/server/src/mcp/McpOrchestrationService.write.test.ts`:

```ts
it.effect("sendThreadMessage rejects running target threads", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.sendThreadMessage({
        threadId: ThreadId.make("thread-running"),
        message: "Continue",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("non_idle_thread");
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threads: [
          threadShell({
            id: "thread-running",
            session: {
              status: "running",
              activeTurnId: "turn-1",
            },
            latestTurn: {
              state: "running",
            },
          }),
        ],
      }),
    ),
  ),
);
```

Add tests for:

- `addProject` returns `already_exists` for an existing normalized path.
- `createThread` defaults placement to `child_of_current`.
- `createThread` rejects cross-project `child_of_thread`.
- `createThread` rejects MCP-disabled model.
- `sendThreadMessage` dispatches `thread.turn.start` and returns `messageId` plus sequence.
- `updateThreadSettings` rejects invalid option values.
- `updateThreadSettings` dispatches existing meta/runtime/interaction commands for valid idle threads.

- [ ] **Step 2: Run write-service tests and verify they fail**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.write.test.ts
```

Expected: FAIL because write service behavior is not implemented.

- [ ] **Step 3: Implement shared validators**

In `apps/server/src/mcp/Layers/McpOrchestrationService.ts`, add:

```ts
function isThreadIdleReady(thread: OrchestrationThreadShell | OrchestrationThread): boolean {
  const latestRunning = thread.latestTurn?.state === "running";
  const hasActiveTurn =
    thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined;
  const sessionStatus = thread.session?.status ?? "idle";
  const sessionReady =
    thread.session === null || sessionStatus === "idle" || sessionStatus === "ready";
  return !latestRunning && !hasActiveTurn && sessionReady;
}
```

Add `validateMcpModelSelection(input)`:

```ts
const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
if (!provider || provider.enabled !== true || provider.installed === false) {
  return (
    yield *
    new McpOrchestrationError({
      code: "unknown_provider_instance",
      message: `Provider instance '${selection.instanceId}' is not available.`,
    })
  );
}
const model = provider.models.find((candidate) => candidate.slug === selection.model);
if (!model) {
  return (
    yield *
    new McpOrchestrationError({
      code: "unknown_model",
      message: `Model '${selection.model}' is not available on '${selection.instanceId}'.`,
    })
  );
}
if (!isModelMcpEnabled({ settings, instanceId: selection.instanceId, model: selection.model })) {
  return (
    yield *
    new McpOrchestrationError({
      code: "mcp_disabled_model",
      message: `Model '${selection.model}' is disabled for MCP on '${selection.instanceId}'.`,
    })
  );
}
```

Validate descriptor values exactly as defined in Task 5.

- [ ] **Step 4: Move pure add-project helpers to shared and implement addProject**

Move these pure helpers from `packages/client-runtime/src/addProject.ts` into `packages/shared/src/addProject.ts`:

- `resolveAddProjectPath`
- `findExistingAddProject`
- `buildProjectCreateCommand`

Add a subpath export to `packages/shared/package.json`:

```json
"./addProject": {
  "types": "./src/addProject.ts",
  "import": "./src/addProject.ts"
}
```

Update `packages/client-runtime/src/addProject.ts` to import the shared helpers and re-export them for existing web imports:

```ts
export {
  resolveAddProjectPath,
  findExistingAddProject,
  buildProjectCreateCommand,
} from "@t3tools/shared/addProject";
```

Keep UI-only clone-flow helpers in `packages/client-runtime/src/addProject.ts`.

Dispatch:

```ts
yield *
  orchestrationEngine.dispatch(
    buildProjectCreateCommand({
      commandId,
      projectId,
      workspaceRoot,
      createdAt,
    }),
  );
```

Return:

```ts
{
  status: ("created", project);
}
```

or:

```ts
{ status: "already_exists", project: existingProject }
```

- [ ] **Step 5: Implement createThread**

Resolve defaults from current thread:

```ts
const invocation = yield * McpInvocationContext.McpInvocationContext;
const currentThread = yield * requireThreadDetail(invocation.threadId);
const targetProjectId = input.projectId ?? currentThread.projectId;
const inheritedSettings = currentThread.modelSelection;
```

Placement resolution:

```ts
function resolveParentThreadId(input: {
  placement?: "child_of_current" | "top_level" | "child_of_thread";
  explicitParentThreadId?: ThreadId;
  targetProjectId: ProjectId;
  currentThread: OrchestrationThread;
}): ThreadId | null {
  const placement =
    input.placement ??
    (input.targetProjectId === input.currentThread.projectId ? "child_of_current" : "top_level");
  switch (placement) {
    case "top_level":
      return null;
    case "child_of_current":
      return input.currentThread.id;
    case "child_of_thread":
      if (!input.explicitParentThreadId) {
        throw new Error("parentThreadId is required for child_of_thread placement.");
      }
      return input.explicitParentThreadId;
  }
}
```

Use Effect errors instead of throwing in final code.

If `message` is omitted, dispatch `thread.create`. If `message` is supplied, dispatch `thread.turn.start` with `bootstrap.createThread` and optional `bootstrap.prepareWorktree`.

- [ ] **Step 6: Implement sendThreadMessage**

Build a `thread.turn.start` command:

```ts
{
  type: "thread.turn.start",
  commandId,
  threadId,
  message: {
    messageId,
    role: "user",
    text: input.message,
    attachments: [],
  },
  modelSelection,
  titleSeed: thread.title,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  createdAt,
}
```

Before dispatch, call `isThreadIdleReady`. Return:

```ts
{
  status: "accepted",
  threadId,
  messageId,
  sequence: accepted.sequence,
}
```

- [ ] **Step 7: Implement updateThreadSettings**

Compute a desired settings object from current thread plus supplied fields. Dispatch only changed commands:

```ts
if (modelSelectionChanged) {
  yield *
    orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield * newCommandId("thread-meta-model"),
      threadId,
      modelSelection: desiredModelSelection,
    });
}
if (runtimeModeChanged) {
  yield *
    orchestrationEngine.dispatch({
      type: "thread.runtime-mode.set",
      commandId: yield * newCommandId("thread-runtime-mode"),
      threadId,
      runtimeMode: desiredRuntimeMode,
      createdAt,
    });
}
if (interactionModeChanged) {
  yield *
    orchestrationEngine.dispatch({
      type: "thread.interaction-mode.set",
      commandId: yield * newCommandId("thread-interaction-mode"),
      threadId,
      interactionMode: desiredInteractionMode,
      createdAt,
    });
}
if (branchOrWorktreeChanged) {
  yield *
    orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield * newCommandId("thread-meta-workspace"),
      threadId,
      branch: desiredBranch,
      worktreePath: desiredWorktreePath,
    });
}
```

Prevalidate provider switch compatibility by mirroring the existing rules from `ProviderCommandReactor`:

- reject if provider instance changes across incompatible drivers
- reject if either provider requires new thread for model change and the thread has a non-null session
- reject if current and desired continuation identity differs when a session is already bound

- [ ] **Step 8: Run write tests**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```sh
git add apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts packages/shared/src/addProject.ts packages/shared/package.json packages/client-runtime/src/addProject.ts
git commit -m "feat: add MCP orchestration write actions"
```

---

### Task 8: Provider Settings MCP Toggle UI

**Files:**

- Modify: `apps/web/src/modelSelection.ts`
- Modify: `apps/web/src/components/settings/ProviderModelsSection.tsx`
- Modify: settings panel/component tests covering provider model rows.
- Modify: `apps/web/src/hooks/useSettings.ts`

**Interfaces:**

- Consumes: `settings.mcpDisabledModelsByProvider`.
- Produces: provider row toggle that writes `mcpDisabledModelsByProvider`.

- [ ] **Step 1: Write failing UI helper tests**

In `apps/web/src/modelSelection.test.ts`, add:

```ts
describe("MCP model enablement preferences", () => {
  it("treats models as enabled unless explicitly disabled for the provider instance", () => {
    expect(
      isModelEnabledForMcp({
        mcpDisabledModelsByProvider: {},
        instanceId: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(true);

    expect(
      isModelEnabledForMcp({
        mcpDisabledModelsByProvider: {
          codex: ["gpt-5.5"],
        },
        instanceId: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(false);
  });

  it("toggles disabled model slugs without affecting other providers", () => {
    expect(
      toggleModelMcpDisabled({
        mcpDisabledModelsByProvider: {
          codex: ["gpt-5.5"],
          claudeAgent: ["claude-opus-4-6"],
        },
        instanceId: "codex",
        model: "gpt-5.5",
      }),
    ).toEqual({
      claudeAgent: ["claude-opus-4-6"],
    });
  });
});
```

- [ ] **Step 2: Run helper tests and verify they fail**

Run:

```sh
vp test apps/web/src/modelSelection.test.ts
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement helpers**

In `apps/web/src/modelSelection.ts`, export:

```ts
export function isModelEnabledForMcp(input: {
  readonly mcpDisabledModelsByProvider: Record<string, readonly string[]>;
  readonly instanceId: string;
  readonly model: string;
}): boolean {
  return !(input.mcpDisabledModelsByProvider[input.instanceId] ?? []).includes(input.model);
}

export function toggleModelMcpDisabled(input: {
  readonly mcpDisabledModelsByProvider: Record<string, readonly string[]>;
  readonly instanceId: string;
  readonly model: string;
}): Record<string, string[]> {
  const current = input.mcpDisabledModelsByProvider[input.instanceId] ?? [];
  const disabled = current.includes(input.model)
    ? current.filter((model) => model !== input.model)
    : [...current, input.model];
  const next = Object.fromEntries(
    Object.entries(input.mcpDisabledModelsByProvider).map(([key, value]) => [key, [...value]]),
  );
  if (disabled.length === 0) {
    delete next[input.instanceId];
  } else {
    next[input.instanceId] = disabled;
  }
  return next;
}
```

- [ ] **Step 4: Add toggle to provider model rows**

In `apps/web/src/components/settings/ProviderModelsSection.tsx`, read the setting from props supplied by the parent. Add these props:

```ts
mcpDisabledModelsByProvider: Record<string, readonly string[]>;
onMcpDisabledModelsByProviderChange: (next: Record<string, string[]>) => void;
```

For each model:

```ts
const isMcpEnabled = isModelEnabledForMcp({
  mcpDisabledModelsByProvider,
  instanceId,
  model: model.slug,
});
```

Add an icon button beside hide/show:

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <Button
        size="icon-xs"
        variant="ghost"
        className={cn(
          "size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground",
          isMcpEnabled && "text-cyan-500 hover:text-cyan-600",
        )}
        onClick={() =>
          onMcpDisabledModelsByProviderChange(
            toggleModelMcpDisabled({
              mcpDisabledModelsByProvider,
              instanceId,
              model: model.slug,
            }),
          )
        }
        aria-label={
          isMcpEnabled
            ? `Block MCP tools from using ${model.name}`
            : `Allow MCP tools to use ${model.name}`
        }
      />
    }
  >
    <PlugIcon className="size-3" />
  </TooltipTrigger>
  <TooltipPopup side="top">
    {isMcpEnabled ? "Block MCP tools from using this model" : "Allow MCP tools to use this model"}
  </TooltipPopup>
</Tooltip>
```

Import `PlugIcon` from `lucide-react` in `ProviderModelsSection.tsx`.

- [ ] **Step 5: Wire settings patch in parent settings component**

Find the parent that renders `ProviderModelsSection` and pass:

```ts
mcpDisabledModelsByProvider={settings.mcpDisabledModelsByProvider}
onMcpDisabledModelsByProviderChange={(mcpDisabledModelsByProvider) => {
  updateSettings({ mcpDisabledModelsByProvider });
}}
```

- [ ] **Step 6: Run web settings tests**

Run:

```sh
vp test apps/web/src/modelSelection.test.ts apps/web/src/components/settings/SettingsPanels.browser.tsx
```

Expected: PASS. Add `apps/web/src/components/settings/ProviderModelsSection.test.tsx` if no existing settings test covers the model row toggle, then run that test file with `vp test apps/web/src/components/settings/ProviderModelsSection.test.tsx`.

- [ ] **Step 7: Commit**

Run:

```sh
git add apps/web/src/modelSelection.ts apps/web/src/modelSelection.test.ts apps/web/src/components/settings/ProviderModelsSection.tsx apps/web/src/components/settings
git commit -m "feat: add provider model MCP toggle"
```

---

### Task 9: Client Thread Tree State And Sidebar Rendering

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/threadDerivation.ts`
- Modify: `apps/web/src/components/Sidebar.logic.ts`
- Modify: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/uiStateStore.ts`
- Modify: `apps/web/src/uiStateStore.test.ts`
- Modify: relevant browser/sidebar tests.

**Interfaces:**

- Consumes: `parentThreadId` from shell/detail snapshots.
- Produces: nested sidebar rendering and client-local expansion state.

- [ ] **Step 1: Write failing tree logic tests**

In `apps/web/src/components/Sidebar.logic.test.ts`, add:

```ts
describe("buildThreadTreeRows", () => {
  it("nests child threads under their parent and preserves top-level order", () => {
    const rows = buildThreadTreeRows({
      threads: [
        sidebarThread({
          id: "thread-parent",
          parentThreadId: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
        sidebarThread({
          id: "thread-other",
          parentThreadId: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        sidebarThread({
          id: "thread-child",
          parentThreadId: "thread-parent",
          updatedAt: "2026-01-03T00:00:00.000Z",
        }),
      ],
      expandedThreadIds: new Set(["thread-parent"]),
      activeThreadId: undefined,
      sortOrder: "updated_at",
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["thread-parent", 0],
      ["thread-child", 1],
      ["thread-other", 0],
    ]);
  });

  it("rolls descendant status onto collapsed parent rows", () => {
    const rows = buildThreadTreeRows({
      threads: [
        sidebarThread({ id: "thread-parent", parentThreadId: null }),
        sidebarThread({
          id: "thread-child",
          parentThreadId: "thread-parent",
          session: {
            status: "running",
            activeTurnId: "turn-1",
          },
        }),
      ],
      expandedThreadIds: new Set(),
      activeThreadId: undefined,
      sortOrder: "updated_at",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.descendantStatus?.kind).toBe("running");
  });
});
```

- [ ] **Step 2: Run sidebar logic tests and verify they fail**

Run:

```sh
vp test apps/web/src/components/Sidebar.logic.test.ts
```

Expected: FAIL because tree helpers and `parentThreadId` are not present.

- [ ] **Step 3: Add client types and store mapping**

In `apps/web/src/types.ts`, add `parentThreadId: ThreadId | null` to `ThreadShell`, `Thread`, and `SidebarThreadSummary`.

In `apps/web/src/store.ts`, map `thread.parentThreadId` in:

```ts
function mapShellThread(...)
function toSidebarThreadSummary(...)
function mergeThreadShell(...)
```

Use:

```ts
parentThreadId: thread.parentThreadId ?? null,
```

- [ ] **Step 4: Implement tree helpers**

In `apps/web/src/components/Sidebar.logic.ts`, add:

```ts
export interface SidebarThreadTreeRow<TThread> {
  readonly thread: TThread;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly descendantStatus: ThreadStatusPill | null;
}
```

Implement:

```ts
export function buildThreadTreeRows<
  TThread extends {
    id: string;
    parentThreadId: string | null;
  },
>(input: {
  readonly threads: readonly TThread[];
  readonly expandedThreadIds: ReadonlySet<string>;
  readonly activeThreadId: string | undefined;
  readonly sortOrder: "updated_at" | "created_at";
}): SidebarThreadTreeRow<TThread>[] {
  const byParent = new Map<string | null, TThread[]>();
  for (const thread of input.threads) {
    const key = input.threads.some((candidate) => candidate.id === thread.parentThreadId)
      ? thread.parentThreadId
      : null;
    byParent.set(key, [...(byParent.get(key) ?? []), thread]);
  }

  const rows: SidebarThreadTreeRow<TThread>[] = [];
  const visit = (thread: TThread, depth: number) => {
    const children = byParent.get(thread.id) ?? [];
    const expanded =
      input.expandedThreadIds.has(thread.id) ||
      children.some((child) => child.id === input.activeThreadId);
    rows.push({
      thread,
      depth,
      hasChildren: children.length > 0,
      expanded,
      descendantStatus: expanded ? null : resolveDescendantThreadStatus(children),
    });
    if (expanded) {
      for (const child of children) visit(child, depth + 1);
    }
  };

  for (const thread of byParent.get(null) ?? []) {
    visit(thread, 0);
  }
  return rows;
}
```

Adapt sorting and status functions to existing local helper names. The final implementation must use the existing `resolveThreadStatusPill` priority behavior for descendant roll-up.

- [ ] **Step 5: Add UI expansion state**

In `apps/web/src/uiStateStore.ts`, add:

```ts
expandedThreadTreeIdsByProject: Record<string, string[]>;
```

Add actions/helpers matching existing pure-function style:

```ts
export function setThreadTreeExpanded(
  state: UiState,
  projectKey: string,
  threadId: string,
  expanded: boolean,
): UiState {
  const current = new Set(state.expandedThreadTreeIdsByProject[projectKey] ?? []);
  if (expanded) current.add(threadId);
  else current.delete(threadId);
  return {
    ...state,
    expandedThreadTreeIdsByProject: {
      ...state.expandedThreadTreeIdsByProject,
      [projectKey]: [...current],
    },
  };
}
```

Add tests in `apps/web/src/uiStateStore.test.ts` for expand/collapse and cleanup.

- [ ] **Step 6: Render nested rows**

In `apps/web/src/components/Sidebar.tsx`, change `SidebarProjectThreadList` to receive flattened tree rows instead of raw threads. Pass `depth`, `hasChildren`, `expanded`, and `descendantStatus` to `SidebarThreadRow`.

In `SidebarThreadRow`, add:

```tsx
style={{ paddingInlineStart: `${Math.min(depth, 4) * 12}px` }}
```

or a Tailwind class map for depths `0..4`. Add a chevron button when `hasChildren`:

```tsx
<button
  type="button"
  aria-label={expanded ? "Collapse child threads" : "Expand child threads"}
  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
  onClick={(event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleThreadExpanded(thread.id);
  }}
>
  <ChevronRightIcon className={cn("size-3", expanded && "rotate-90")} />
</button>
```

When collapsed and `descendantStatus` exists, show the existing `ThreadStatusLabel` or dot in the same location the project collapsed status uses.

- [ ] **Step 7: Auto-expand active and newly created child paths**

Add a selector/effect in `Sidebar.tsx`:

```ts
useEffect(() => {
  if (!routeThreadKey || !activeRouteProjectKey) return;
  const activeThread = threadByKey.get(routeThreadKey);
  if (!activeThread) return;
  for (const ancestorId of resolveThreadAncestorIds(activeThread, threadById)) {
    setThreadTreeExpanded(activeRouteProjectKey, ancestorId, true);
  }
}, [activeRouteProjectKey, routeThreadKey, threadByKey, threadById, setThreadTreeExpanded]);
```

Also expand the parent path when a shell event inserts a child thread. Use previous thread ids in a ref to detect new child rows.

- [ ] **Step 8: Run UI tests**

Run:

```sh
vp test apps/web/src/components/Sidebar.logic.test.ts apps/web/src/uiStateStore.test.ts apps/web/src/store.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```sh
git add apps/web/src/types.ts apps/web/src/store.ts apps/web/src/threadDerivation.ts apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/uiStateStore.ts apps/web/src/uiStateStore.test.ts
git commit -m "feat: render nested orchestration threads"
```

---

### Task 10: End-To-End MCP Toolkit Tests And Final Verification

**Files:**

- Modify: `apps/server/src/mcp/McpHttpServer.test.ts`
- Create: `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`
- Update any fixtures affected by parent thread snapshots.

**Interfaces:**

- Consumes all prior tasks.
- Produces final verified MCP toolkit registration and execution behavior.

- [ ] **Step 1: Write integration tests for MCP tool calls**

Create `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts` with HTTP-level MCP calls mirroring `McpHttpServer.test.ts`. Cover:

```ts
it.effect("lists MCP-enabled models through the MCP transport", () =>
  Effect.gen(function* () {
    const initialize = yield* initializeMcpSession();
    const response = yield* callMcpTool(initialize.sessionId, "list_mcp_models", {});

    expect(response.structuredContent.providers.codex.models["gpt-5.5"]).toBeDefined();
  }),
);
```

```ts
it.effect("creates a child thread through the MCP transport", () =>
  Effect.gen(function* () {
    const initialize = yield* initializeMcpSession();
    const response = yield* callMcpTool(initialize.sessionId, "create_thread", {
      placement: "child_of_current",
      title: "Investigate failing tests",
    });

    expect(response.structuredContent.thread.parentThreadId).toBe("thread-mcp-test");
  }),
);
```

Use helper functions in the test file:

```ts
function initializeMcpSession() {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const initializeResponse = yield* httpClient.post("/mcp", {
      headers: {
        authorization: `Bearer ${issuedToken}`,
        "content-type": "application/json",
      },
      body: HttpBody.text(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mcp-orchestration-test", version: "1.0.0" },
          },
        }),
      ),
    });
    return {
      sessionId: initializeResponse.headers["mcp-session-id"]!,
    };
  });
}
```

Mirror the exact HTTP body utilities from the existing MCP test file.

- [ ] **Step 2: Run MCP integration tests and verify failures**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
```

Expected: FAIL for any missing toolkit registration, layer dependency, or response-shape issues.

- [ ] **Step 3: Fix integration layer wiring**

Ensure `apps/server/src/mcp/McpHttpServer.ts` final `layer` provides:

```ts
Layer.provide(McpOrchestrationServiceLive);
```

and the `McpOrchestrationServiceLive` layer itself is provided with:

- `ProviderRegistry`
- `ServerSettingsService`
- `ProjectionSnapshotQuery`
- `ProjectionThreadMessageSearchRepository`
- `OrchestrationEngineService`
- `TextGeneration`
- `Crypto.Crypto`
- any path/workspace services required by `addProject`

Use `Layer.provideMerge` in the same style as the existing server runtime layer. Avoid creating a parallel runtime.

- [ ] **Step 4: Run focused test suite**

Run:

```sh
vp test packages/contracts/src/settings.test.ts packages/contracts/src/orchestration.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.history.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts apps/web/src/modelSelection.test.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/uiStateStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run required project checks**

Run:

```sh
vp check
```

Expected: PASS.

Run:

```sh
vp run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review git diff**

Run:

```sh
git status --short
git diff --stat
```

Expected:

- only files related to this plan are modified
- `apps/mobile/app.config.ts` remains untouched unless the user explicitly asked to edit it
- no files under `.repos/` are modified

- [ ] **Step 7: Commit final integration fixes**

Run:

```sh
git add packages/contracts apps/server/src apps/web/src packages/shared packages/client-runtime
git commit -m "feat: add MCP orchestration tools"
```

If all prior tasks already committed every changed file, skip this commit and report that the branch is clean except for the pre-existing unrelated mobile config change.
