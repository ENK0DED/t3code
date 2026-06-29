# MCP Child Turn Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved child-turn liveness design so parent agents stop treating transcript silence or `waitForResponse` timeout as stale work, while still keeping explicit stale cleanup available through a guarded cancellation tool.

**Architecture:** Add a turn-scoped provider-signal event and coalesced projection fields on `projection_turns`, keep the non-coalesced latest signal in a service-lifetime tracker, compute liveness in one `ThreadTurnLivenessQuery` service, and expose MCP tools as thin calls into that service. Ship `wait_for_thread_update` and `cancel_stale_thread_turn` together so the new stale status cannot push callers toward the existing unguarded `interrupt_thread_turn`.

**Tech Stack:** TypeScript, Effect services/layers, Effect Schema contracts, Effect SQL SQLite migrations/projections, `effect/unstable/ai` MCP tools, Vite+ tests.

## Global Constraints

- `vp check` and `vp run typecheck` must pass before completion.
- Use `vp test` for targeted Vite+ tests during implementation.
- Do not edit files under `.repos/`.
- Before writing Effect code, read `.repos/effect-smol/LLMS.md` and follow existing `Effect.gen`, named `Effect.fn`, service, and layer patterns.
- Keep `packages/contracts` schema-only.
- Keep liveness calculation out of MCP handlers; handlers only call service methods.
- Do not expose private reasoning text. Provider-signal persistence stores timestamps and broad signal kinds only.
- A running child thread may be transcript-silent indefinitely. Only server-observed lack of runtime/provider progress can make it stale.
- `waitForResponse.timeoutMs` must keep meaning "stop waiting without cancelling".
- `turnTimeoutMs` and `responseTimeoutMs` keep their existing cancellation semantics.
- Terminal turn states are never stale and are never safe to interrupt.

---

## Claude Second Opinion Adjustments

Claude reviewed `docs/superpowers/specs/2026-06-29-mcp-child-turn-liveness-design.md` read-only before this plan. Incorporate these changes during implementation:

- Specify and implement the write path: `ProviderRuntimeIngestion` must record liveness signals for reasoning, task, tool, token-usage, request, assistant text, and lifecycle runtime events.
- Avoid false stale classifications caused by persisted signal coalescing: staleness uses `max(projectedLastSignalAt, ThreadTurnSignalTracker.latestSignalAt)`, not only the coalesced DB timestamp.
- Ship `wait_for_thread_update` and `cancel_stale_thread_turn` atomically.
- Add optional `turnId` to `wait_for_thread_update` and `get_thread_turn_status`; provided `turnId` scopes the result to that exact turn.
- Define `idle`: thread exists, has no pending start, and no active turn in the requested scope. It is not equivalent to `completed`.
- Explicitly guard terminal states: `stale: false`, `safeToInterrupt: false`.
- Return the actual threshold used in `staleAfterMs`.
- Set a concrete `wait_for_thread_update.timeoutMs` bound.

## File Structure

Create or modify these focused units:

- `packages/contracts/src/orchestration.ts`: add provider-signal command/event schemas and payload exports.
- `packages/contracts/src/orchestration.test.ts`: command/event schema coverage for provider-signal payloads.
- `apps/server/src/orchestration/Schemas.ts`: re-export provider-signal payload schema.
- `apps/server/src/orchestration/decider.ts`: emit `thread.turn-provider-signaled`.
- `apps/server/src/orchestration/projector.ts`: accept the new event without changing transcript/read-model output.
- `apps/server/src/orchestration/Services/ThreadTurnSignalTracker.ts`: service contract for non-coalesced live provider signal timestamps.
- `apps/server/src/orchestration/Layers/ThreadTurnSignalTracker.ts`: in-memory tracker implementation with coalescing decisions.
- `apps/server/src/orchestration/Services/ThreadTurnLivenessQuery.ts`: service contract for liveness reads and waits.
- `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.ts`: liveness calculation, cursor handling, event wait loop, stale timer.
- `apps/server/src/orchestration/threadTurnLiveness.ts`: pure types/helpers for liveness state, thresholds, cursor encoding, signal kind mapping.
- `apps/server/src/orchestration/pendingRequests.ts`: extract pending approval/user-input derivation from MCP service for reuse.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`: record runtime provider signals and dispatch coalesced provider-signal commands.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`: reasoning-only and coalescing liveness signal coverage.
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`: project `thread.turn-provider-signaled` into `projection_turns`.
- `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`: provider-signal projection and terminal-state regression coverage.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`: expose turn liveness row reads by exact `{threadId, turnId}`.
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`: add the liveness row query interface.
- `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts`: focused liveness and wait-loop tests.
- `apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.ts`: add liveness columns to `projection_turns`.
- `apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts`: idempotent migration test.
- `apps/server/src/persistence/Migrations.ts`: register migration 037.
- `apps/server/src/persistence/Services/ProjectionTurns.ts`: add liveness fields and repository method.
- `apps/server/src/persistence/Layers/ProjectionTurns.ts`: read/write liveness columns and implement `recordProviderSignal`.
- `apps/server/src/server.ts`: provide new tracker/query layers.
- `apps/server/src/mcp/Services/McpOrchestrationService.ts`: add MCP result/input types and service methods.
- `apps/server/src/mcp/Layers/McpOrchestrationService.ts`: delegate status/wait/cancel operations, update pending-request imports, record force overrides.
- `apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts`: stale wait/cancel and existing timeout regression tests.
- `apps/server/src/mcp/toolkits/orchestration/tools.ts`: add `get_thread_turn_status`, `wait_for_thread_update`, `cancel_stale_thread_turn`; update descriptions.
- `apps/server/src/mcp/toolkits/orchestration/handlers.ts`: wire new tools.
- `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`: schema/name/description coverage.
- `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`: transport-level dispatch coverage for new tools.

---

### Task 1: Contracts And Turn Projection Fields

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/orchestration.test.ts`
- Modify: `apps/server/src/orchestration/Schemas.ts`
- Modify: `apps/server/src/orchestration/decider.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Create: `apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.ts`
- Create: `apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionTurns.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectionTurns.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`

**Interfaces:**

- Produces command: `thread.turn.provider-signal`
- Produces event: `thread.turn-provider-signaled`
- Produces liveness columns on `projection_turns`:
  - `last_provider_signal_at TEXT`
  - `last_observable_progress_at TEXT`
  - `last_signal_kind TEXT`
- Produces repository method:

```ts
recordProviderSignal(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly signalKind: ProjectionTurnProviderSignalKind;
  readonly signaledAt: string;
}): Effect.Effect<void, ProjectionRepositoryError>;
```

- [ ] **Step 1: Add failing contract tests**

Add coverage to `packages/contracts/src/orchestration.test.ts` for decoding a `thread.turn.provider-signal` command and a `thread.turn-provider-signaled` event.

Expected command shape:

```ts
{
  type: "thread.turn.provider-signal",
  commandId: "cmd-provider-signal",
  threadId: "thread-1",
  turnId: "turn-1",
  signalKind: "reasoning",
  signaledAt: "2026-06-29T00:00:05.000Z",
  createdAt: "2026-06-29T00:00:05.000Z"
}
```

Expected event payload:

```ts
{
  threadId: "thread-1",
  turnId: "turn-1",
  signalKind: "reasoning",
  signaledAt: "2026-06-29T00:00:05.000Z"
}
```

Run:

```sh
vp test packages/contracts/src/orchestration.test.ts
```

Expected: FAIL until the schemas are added.

- [ ] **Step 2: Add provider-signal contract schemas**

In `packages/contracts/src/orchestration.ts`, add broad signal kinds:

```ts
export const ThreadTurnProviderSignalKind = Schema.Literals([
  "assistant_text",
  "reasoning",
  "tool",
  "task",
  "token_usage",
  "request",
  "lifecycle",
]);
export type ThreadTurnProviderSignalKind = typeof ThreadTurnProviderSignalKind.Type;
```

Add internal command and payload schemas:

```ts
const ThreadTurnProviderSignalCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.provider-signal"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  signalKind: ThreadTurnProviderSignalKind,
  signaledAt: IsoDateTime,
  createdAt: IsoDateTime,
});

export const ThreadTurnProviderSignaledPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  signalKind: ThreadTurnProviderSignalKind,
  signaledAt: IsoDateTime,
});
export type ThreadTurnProviderSignaledPayload = typeof ThreadTurnProviderSignaledPayload.Type;
```

Add command/event entries to the existing unions and `OrchestrationEventType` literals. Keep payload content-free: no reasoning text, summaries, tool args, or provider raw payloads.

- [ ] **Step 3: Wire decider and server schema alias**

In `apps/server/src/orchestration/Schemas.ts`, re-export the payload schema from contracts.

In `apps/server/src/orchestration/decider.ts`, add:

```ts
case "thread.turn.provider-signal": {
  yield* requireThread({
    readModel,
    command,
    threadId: command.threadId,
  });
  return {
    ...(yield* withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.signaledAt,
      commandId: command.commandId,
    })),
    type: "thread.turn-provider-signaled",
    payload: {
      threadId: command.threadId,
      turnId: command.turnId,
      signalKind: command.signalKind,
      signaledAt: command.signaledAt,
    },
  };
}
```

Do not update the in-memory transcript read model for this event. If `projector.ts` needs an explicit case for exhaustiveness, return the read model unchanged.

- [ ] **Step 4: Add migration 037**

Create `apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.ts` using the idempotent `PRAGMA table_info` pattern from migration 033:

```ts
const addColumnIfMissing = (table: string, column: string, ddl: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(${sql(table)})
  `;
    if (!columns.some((entry) => entry.name === column)) {
      yield* sql.unsafe(ddl);
    }
  });
```

Add nullable columns:

```sql
ALTER TABLE projection_turns ADD COLUMN last_provider_signal_at TEXT
ALTER TABLE projection_turns ADD COLUMN last_observable_progress_at TEXT
ALTER TABLE projection_turns ADD COLUMN last_signal_kind TEXT
```

If `sql(table)` is not valid for identifiers in this codebase, use direct `PRAGMA table_info(projection_turns)` as migration 033 does.

- [ ] **Step 5: Test migration 037**

Create `apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts`:

- Build an old `projection_turns` table without the three new columns.
- Insert an existing row.
- Run migration 037 twice.
- Assert columns exist, row remains, and new columns read as `null`.

Register migration 037 in `apps/server/src/persistence/Migrations.ts`.

Run:

```sh
vp test apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts
```

Expected: PASS.

- [ ] **Step 6: Extend `ProjectionTurns` schema and repository**

In `apps/server/src/persistence/Services/ProjectionTurns.ts`, add optional nullable fields to `ProjectionTurn` and `ProjectionTurnById`:

```ts
lastProviderSignalAt: Schema.optional(Schema.NullOr(IsoDateTime)),
lastObservableProgressAt: Schema.optional(Schema.NullOr(IsoDateTime)),
lastSignalKind: Schema.optional(Schema.NullOr(ThreadTurnProviderSignalKind)),
```

In `apps/server/src/persistence/Layers/ProjectionTurns.ts`:

- Select the three new columns in all turn queries.
- Insert nullable values with `row.lastProviderSignalAt ?? null`.
- Preserve existing liveness values on normal lifecycle upserts:

```sql
last_provider_signal_at = COALESCE(
  excluded.last_provider_signal_at,
  projection_turns.last_provider_signal_at
),
last_observable_progress_at = COALESCE(
  excluded.last_observable_progress_at,
  projection_turns.last_observable_progress_at
),
last_signal_kind = COALESCE(
  excluded.last_signal_kind,
  projection_turns.last_signal_kind
)
```

- Implement `recordProviderSignal` as an update against the exact row:

```sql
UPDATE projection_turns
SET
  last_provider_signal_at =
    CASE
      WHEN last_provider_signal_at IS NULL OR last_provider_signal_at < ${signaledAt}
      THEN ${signaledAt}
      ELSE last_provider_signal_at
    END,
  last_observable_progress_at =
    CASE
      WHEN last_observable_progress_at IS NULL OR last_observable_progress_at < ${signaledAt}
      THEN ${signaledAt}
      ELSE last_observable_progress_at
    END,
  last_signal_kind =
    CASE
      WHEN last_provider_signal_at IS NULL OR last_provider_signal_at <= ${signaledAt}
      THEN ${signalKind}
      ELSE last_signal_kind
    END
WHERE thread_id = ${threadId}
  AND turn_id = ${turnId}
```

The method is a no-op if the turn row does not exist yet; the next coalesced signal or visible lifecycle event will catch up after `thread.session-set` creates the row.

- [ ] **Step 7: Project provider-signal events**

In `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, add a case in `applyThreadTurnsProjection`:

```ts
case "thread.turn-provider-signaled": {
  yield* projectionTurnRepository.recordProviderSignal({
    threadId: event.payload.threadId,
    turnId: event.payload.turnId,
    signalKind: event.payload.signalKind,
    signaledAt: event.payload.signaledAt,
  });
  return;
}
```

Add projection tests:

- A provider-signal event updates only the exact turn row.
- A provider-signal after a terminal turn does not change state back to running.
- Normal lifecycle upserts preserve liveness columns.

Run:

```sh
vp test apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit task 1**

Run:

```sh
vp test packages/contracts/src/orchestration.test.ts apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
git status --short
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts apps/server/src/orchestration/Schemas.ts apps/server/src/orchestration/decider.ts apps/server/src/orchestration/projector.ts apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.ts apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/Services/ProjectionTurns.ts apps/server/src/persistence/Layers/ProjectionTurns.ts apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
git commit -m "Add turn provider-signal projection"
```

Expected: targeted tests pass and commit succeeds.

---

### Task 2: Runtime Signal Tracking And Ingestion Write Path

**Files:**

- Create: `apps/server/src/orchestration/Services/ThreadTurnSignalTracker.ts`
- Create: `apps/server/src/orchestration/Layers/ThreadTurnSignalTracker.ts`
- Create: `apps/server/src/orchestration/threadTurnLiveness.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Produces constants:

```ts
export const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
export const CLAUDE_HIGH_REASONING_STALE_AFTER_MS = 20 * 60_000;
export const PROVIDER_SIGNAL_COALESCE_MS = 30_000;
export const DEFAULT_THREAD_UPDATE_WAIT_TIMEOUT_MS = 30_000;
export const MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS = 120_000;
```

- Produces tracker service:

```ts
export interface ThreadTurnSignalTrackerShape {
  readonly record: (
    input: ThreadTurnProviderSignal,
  ) => Effect.Effect<{ readonly shouldPersist: boolean }, never>;
  readonly getLatest: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<Option.Option<ThreadTurnProviderSignal>, never>;
  readonly clear: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<void, never>;
}
```

- [ ] **Step 1: Add pure liveness helper types**

Create `apps/server/src/orchestration/threadTurnLiveness.ts` with:

```ts
export type ThreadTurnLivenessState =
  | "pending_start"
  | "running"
  | "completed"
  | "interrupted"
  | "error"
  | "idle";

export type ThreadTurnStaleReason = "no_provider_signal" | "no_observable_progress" | "none";

export interface ThreadTurnProviderSignal {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly signalKind: ThreadTurnProviderSignalKind;
  readonly signaledAt: string;
}
```

Also add `runtimeEventSignalKind(event: ProviderRuntimeEvent)` in this file or beside ingestion. It must return `null` when no `turnId` is present.

Signal kind mapping:

- `content.delta` with `assistant_text`: `assistant_text`
- `content.delta` with `reasoning_text` or `reasoning_summary_text`: `reasoning`
- `task.started`, `task.progress`, `task.completed`, `turn.plan.updated`, `turn.proposed.delta`, `turn.proposed.completed`, `turn.diff.updated`: `task`
- `item.started`, `item.updated`, `item.completed`, `tool.progress`, `tool.summary`: `tool`
- `thread.token-usage.updated`: `token_usage`
- `request.opened`, `request.resolved`, `user-input.requested`, `user-input.resolved`: `request`
- `turn.started`, `turn.completed`, `turn.aborted`, `session.state.changed`, `session.exited`, `runtime.warning`, `runtime.error`: `lifecycle`

- [ ] **Step 2: Implement `ThreadTurnSignalTracker`**

Create the service and layer. Use an in-memory `Map<string, { latest: ThreadTurnProviderSignal; lastPersistedAt: string | null }>` keyed by `${threadId}:${turnId}`.

`record` must always update `latest`, but return `shouldPersist: true` only when:

- there is no `lastPersistedAt`, or
- `signaledAt - lastPersistedAt >= PROVIDER_SIGNAL_COALESCE_MS`, or
- `signalKind` is `lifecycle` and the event is turn-start/turn-end adjacent.

Keep coalescing out of stale math: the liveness query will read `getLatest` and use the non-coalesced timestamp.

- [ ] **Step 3: Dispatch provider-signal commands from ingestion**

In `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`:

- Inject `ThreadTurnSignalTracker`.
- After `eventTurnId` has been resolved and before/near existing assistant/activity dispatches, call the signal-kind helper.
- If the runtime event has a turn id and a signal kind, call tracker `record`.
- When `shouldPersist` is true, dispatch:

```ts
yield *
  orchestrationEngine.dispatch({
    type: "thread.turn.provider-signal",
    commandId: yield * providerCommandId(event, "thread-turn-provider-signal"),
    threadId: thread.id,
    turnId,
    signalKind,
    signaledAt: event.createdAt,
    createdAt: event.createdAt,
  });
```

Use `event.createdAt` as `signaledAt`; do not use local processing time for the signal timestamp. Use local time only for commands that already do so for domain lifecycle state.

On terminal events (`turn.completed`, `turn.aborted`, `runtime.error` with matching turn), leave the latest signal in the tracker until liveness observes terminal state. Terminal state itself prevents stale and interrupt safety.

- [ ] **Step 4: Add ingestion tests**

In `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`, add tests:

- `content.delta` with `reasoning_text` dispatches `thread.turn.provider-signal` with `signalKind: "reasoning"` and does not append reasoning text to messages.
- Repeated reasoning deltas inside 30 seconds update the tracker but dispatch only one domain provider-signal event.
- A later reasoning delta after 30 seconds dispatches another provider-signal event.
- `task.progress` and `thread.token-usage.updated` produce `task` and `token_usage` signal kinds.
- Runtime events without `turnId` do not create turn liveness signals.

Run:

```sh
vp test apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Provide the tracker layer**

In `apps/server/src/server.ts`, add `ThreadTurnSignalTrackerLive` so both `ProviderRuntimeIngestionLive` and `ThreadTurnLivenessQueryLive` receive the same service instance.

If tests assemble layers manually, update their test harness layers with `Layer.provideMerge(ThreadTurnSignalTrackerLive)`.

- [ ] **Step 6: Commit task 2**

Run:

```sh
vp test apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
git status --short
git add apps/server/src/orchestration/Services/ThreadTurnSignalTracker.ts apps/server/src/orchestration/Layers/ThreadTurnSignalTracker.ts apps/server/src/orchestration/threadTurnLiveness.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/server.ts
git commit -m "Track provider signals for turn liveness"
```

Expected: targeted tests pass and commit succeeds.

---

### Task 3: Shared Pending Requests And Liveness Query Service

**Files:**

- Create: `apps/server/src/orchestration/pendingRequests.ts`
- Create: `apps/server/src/orchestration/Services/ThreadTurnLivenessQuery.ts`
- Create: `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.ts`
- Create: `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts`
- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

```ts
export interface ThreadTurnLiveness {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly state: "pending_start" | "running" | "completed" | "interrupted" | "error" | "idle";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly runningForMs: number | null;
  readonly lastMessageAt: string | null;
  readonly lastActivityAt: string | null;
  readonly lastProviderSignalAt: string | null;
  readonly lastObservableProgressAt: string | null;
  readonly pendingRequests: ReadonlyArray<PendingTurnRequest>;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly stale: boolean;
  readonly staleReason: "no_provider_signal" | "no_observable_progress" | "none";
  readonly staleAfterMs: number;
  readonly safeToInterrupt: boolean;
}

export interface WaitForThreadUpdateInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly since?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly includeStatus?: boolean | undefined;
}
```

- [ ] **Step 1: Extract pending-request derivation**

Move the following helper logic out of `apps/server/src/mcp/Layers/McpOrchestrationService.ts` into `apps/server/src/orchestration/pendingRequests.ts`:

- `activityRequestId`
- `activityDetailLower`
- `isStaleApprovalFailure`
- `isStaleUserInputFailure`
- `userInputFieldsFromPayload`
- `derivePendingRequestsFromActivities`
- `derivePendingRequestsForTurn`

Export:

```ts
export type PendingTurnRequest =
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly requestKind?: "command" | "file-read" | "file-change" | undefined;
      readonly requestType?: string | undefined;
      readonly detail?: string | undefined;
    }
  | {
      readonly kind: "user-input";
      readonly requestId: string;
      readonly prompt?: string | undefined;
      readonly fields: PendingUserInputFields;
    };

export function derivePendingRequestsFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingTurnRequest>;

export function derivePendingRequestsForTurn(
  thread: OrchestrationThread,
  turnId: string,
): ReadonlyArray<PendingTurnRequest>;
```

In `apps/server/src/mcp/Services/McpOrchestrationService.ts`, import and alias:

```ts
export type { PendingTurnRequest as PendingRequest } from "../../orchestration/pendingRequests.ts";
```

Run existing MCP service tests:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts
```

Expected: PASS with no behavior change.

- [ ] **Step 2: Add turn liveness row query**

In `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`, add:

```ts
export interface ProjectionThreadTurnLivenessRow {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly pendingMessageId: MessageId | null;
  readonly state: "running" | "interrupted" | "completed" | "error";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastProviderSignalAt: string | null;
  readonly lastObservableProgressAt: string | null;
  readonly lastSignalKind: ThreadTurnProviderSignalKind | null;
}

readonly getThreadTurnLivenessRowById: (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}) => Effect.Effect<Option.Option<ProjectionThreadTurnLivenessRow>, ProjectionRepositoryError>;
```

Implement it in `ProjectionSnapshotQuery.ts` by selecting directly from `projection_turns`.

Do not overload `OrchestrationLatestTurn`; the liveness query needs pending message and provider-signal fields that are not part of the public read model.

- [ ] **Step 3: Implement liveness calculation**

Create `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.ts`.

Inputs:

- `ProjectionSnapshotQuery`
- `OrchestrationEngineService`
- `ThreadTurnSignalTracker`
- `ProviderRegistry`
- `Clock`

State resolution:

- If `turnId` is provided, read that exact turn row. Unknown scoped turn returns `McpOrchestrationError` later at the MCP layer as `unknown_turn`; internally use a tagged service error such as `ThreadTurnLivenessQueryError`.
- If `turnId` is omitted and `thread.pendingTurnStart` exists with no active turn, return `state: "pending_start"`, `turnId: null`.
- If `turnId` is omitted and `thread.session?.activeTurnId` exists, use that exact row.
- Else if `thread.latestTurn?.turnId` exists, use that row.
- Else return `state: "idle"`, `turnId: null`.

Timestamp resolution:

- `lastMessageAt`: latest message timestamp for the turn, including the pending user message by matching `pendingMessageId` because user messages have `turnId: null`.
- `lastActivityAt`: latest activity timestamp for the scoped turn.
- `lastProviderSignalAt`: max of `projection_turns.last_provider_signal_at` and `ThreadTurnSignalTracker.getLatest`.
- `lastObservableProgressAt`: max of `lastMessageAt`, `lastActivityAt`, `lastProviderSignalAt`, and `startedAt`.

Stale rules:

- If state is `idle`, `pending_start`, `completed`, `interrupted`, or `error`: `stale: false`, `safeToInterrupt: false`.
- If pending requests are open: `stale: false`, `safeToInterrupt: false`.
- If state is `running` and no observable progress exists, compare `startedAt ?? requestedAt` to threshold and use `staleReason: "no_observable_progress"`.
- If state is `running` and `lastProviderSignalAt` is null after the threshold, use `staleReason: "no_provider_signal"`.
- Otherwise, `stale` only when `now - lastObservableProgressAt > staleAfterMs`.
- `safeToInterrupt` is true only when `state === "running" && stale && pendingRequests.length === 0`.

Threshold:

- Use `CLAUDE_HIGH_REASONING_STALE_AFTER_MS` when provider resolution says the driver is `claude` or resolved options indicate high reasoning/thinking.
- Otherwise use `DEFAULT_STALE_AFTER_MS`.
- If the tracker has no live timestamp for this turn and the projected provider signal may be coalesced, add `PROVIDER_SIGNAL_COALESCE_MS` as a restart grace and return that effective threshold in `staleAfterMs`.

- [ ] **Step 4: Implement opaque wait cursors**

In `threadTurnLiveness.ts`, encode/decode cursors as versioned base64url JSON:

```ts
interface ThreadUpdateCursorV1 {
  readonly v: 1;
  readonly sequence: number;
  readonly observedAt: string | null;
}
```

Rules:

- Omitted `since` means current `ProjectionSnapshotQuery.getSnapshotSequence()` and no observed timestamp.
- Invalid base64/JSON/version/sequence fails with `invalid_cursor`.
- Treat cursors as opaque everywhere in tool descriptions.

- [ ] **Step 5: Implement `waitForThreadUpdate`**

`waitForThreadUpdate` behavior:

- Validate `timeoutMs`:
  - default: `DEFAULT_THREAD_UPDATE_WAIT_TIMEOUT_MS`
  - min: `1`
  - max: `MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS`
- Subscribe to `orchestrationEngine.streamDomainEvents` before the initial probe.
- Scope events by `aggregateId === threadId`.
- If `turnId` is provided, do not return terminal/progress for another turn.
- Initial and event probes use this precedence:
  - `terminal`: scoped turn state is `completed`, `interrupted`, or `error`
  - `pending_request`: a pending approval/user-input opened after `since`
  - `progress`: `lastObservableProgressAt` is newer than cursor or event sequence advanced due to provider signal/message/activity for the scoped turn
  - `stale`: liveness says stale
- Race the event stream against:
  - caller timeout
  - the next computed stale deadline for a running turn
- On timeout, return `reason: "timeout"` without interrupting.
- Always return a fresh cursor. Include `liveness` only when `includeStatus === true`.

- [ ] **Step 6: Add focused liveness tests**

Create `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts`:

- Running turn with no transcript output but recent in-memory reasoning provider signal is not stale.
- Running turn with a projected signal older than threshold but an in-memory newer signal is not stale.
- Claude/high-reasoning turn returns the longer `staleAfterMs`.
- Running turn with old provider signal and no pending requests is stale and safe to interrupt.
- Pending approval/user-input makes the turn blocked, not stale.
- Completed/interrupted/error states are never stale and never safe to interrupt.
- `idle` means no pending start and no active/scoped turn; it is not terminal.
- `waitForThreadUpdate` returns `progress` for a reasoning-only provider-signal event.
- `waitForThreadUpdate` returns `timeout` without dispatching interrupts.
- Scoped wait ignores updates for a newer/different turn.

Run:

```sh
vp test apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Provide the liveness query layer**

In `apps/server/src/server.ts`, add `ThreadTurnLivenessQueryLive` after its dependencies are available.

Update test harness layers that construct `McpOrchestrationServiceLive` or server layers manually.

- [ ] **Step 8: Commit task 3**

Run:

```sh
vp test apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts
git status --short
git add apps/server/src/orchestration/pendingRequests.ts apps/server/src/orchestration/Services/ThreadTurnLivenessQuery.ts apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.ts apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/server.ts
git commit -m "Add shared thread turn liveness query"
```

Expected: targeted tests pass and commit succeeds.

---

### Task 4: MCP Tools For Status, Wait, And Guarded Stale Cancel

**Files:**

- Modify: `apps/server/src/mcp/Services/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`

**Interfaces:**

```ts
get_thread_turn_status({
  threadId: ThreadId,
  turnId?: TurnId
}) => {
  threadId,
  cursor,
  liveness
}

wait_for_thread_update({
  threadId: ThreadId,
  turnId?: TurnId,
  since?: string,
  timeoutMs?: number,
  includeStatus?: boolean
}) => {
  threadId,
  turnId: TurnId | null,
  reason: "terminal" | "progress" | "pending_request" | "stale" | "timeout",
  cursor,
  liveness?
}

cancel_stale_thread_turn({
  threadId: ThreadId,
  turnId: TurnId,
  ifNoProgressSince: string,
  force?: boolean
}) => {
  status: "interrupt_requested",
  threadId,
  turnId,
  sequence,
  forced
}
```

- [ ] **Step 1: Extend MCP service interface**

In `apps/server/src/mcp/Services/McpOrchestrationService.ts`, add types for:

- `ThreadTurnStatusInput`
- `ThreadTurnStatusResult`
- `WaitForThreadUpdateInput`
- `WaitForThreadUpdateResult`
- `CancelStaleThreadTurnInput`
- `CancelStaleThreadTurnResult`

Add service methods:

```ts
readonly getThreadTurnStatus: (
  input: ThreadTurnStatusInput,
) => Effect.Effect<
  ThreadTurnStatusResult,
  McpOrchestrationError,
  McpInvocationContext.McpInvocationContext
>;

readonly waitForThreadUpdate: (
  input: WaitForThreadUpdateInput,
) => Effect.Effect<
  WaitForThreadUpdateResult,
  McpOrchestrationError,
  McpInvocationContext.McpInvocationContext
>;

readonly cancelStaleThreadTurn: (
  input: CancelStaleThreadTurnInput,
) => Effect.Effect<
  CancelStaleThreadTurnResult,
  McpOrchestrationError,
  McpInvocationContext.McpInvocationContext
>;
```

- [ ] **Step 2: Implement MCP service methods**

In `apps/server/src/mcp/Layers/McpOrchestrationService.ts`:

- Inject `ThreadTurnLivenessQuery`.
- `getThreadTurnStatus` requires read capability, checks thread visibility with `requireThreadDetail`, then returns liveness and cursor.
- `waitForThreadUpdate` requires read capability, checks thread visibility once before waiting, then delegates to `ThreadTurnLivenessQuery.waitForThreadUpdate`.
- `cancelStaleThreadTurn` requires write capability and MCP ownership via existing `requireThreadManageableByMcp`.

`cancelStaleThreadTurn` validation:

- Decode `ifNoProgressSince` as the same opaque cursor used by `wait_for_thread_update`.
- Query liveness scoped to `turnId`.
- Reject `turn_not_active` unless the scoped liveness is `state: "running"` and the current active/session turn matches `turnId`.
- Reject `progress_observed` when the current liveness cursor is newer than `ifNoProgressSince`.
- Reject `not_stale` unless `liveness.safeToInterrupt` is true.
- Allow `force: true` to bypass `not_stale` and `progress_observed`, but not `turn_not_active`.
- Before dispatching the interrupt, record an activity:

```ts
{
  id: EventId.make(`stale-cancel:${randomHex}`),
  tone: input.force === true ? "error" : "info",
  kind: "thread.turn.stale-cancel.requested",
  summary: input.force === true
    ? "Forced stale turn cancellation requested"
    : "Stale turn cancellation requested",
  payload: {
    turnId: input.turnId,
    ifNoProgressSince: input.ifNoProgressSince,
    forced: input.force === true,
    lastObservableProgressAt: liveness.lastObservableProgressAt,
    staleReason: liveness.staleReason,
  },
  turnId: input.turnId,
  createdAt,
}
```

Then dispatch `thread.turn.interrupt` with the exact `turnId`.

- [ ] **Step 3: Add MCP tool schemas**

In `apps/server/src/mcp/toolkits/orchestration/tools.ts`, add:

- `TurnIdInput` branded input.
- `CursorInput` described as an opaque cursor from `get_thread_turn_status` or `wait_for_thread_update`.
- `GetThreadTurnStatusTool` as read-only.
- `WaitForThreadUpdateTool` as read-only.
- `CancelStaleThreadTurnTool` as destructive.

Descriptions must include:

- `wait_for_thread_update` never interrupts.
- `timeout` means no relevant update arrived before `timeoutMs`; the child may still be running.
- `waitForResponse.timeoutMs` is not stale.
- For high-reasoning or Claude children, prefer `wait_for_thread_update` loops over fixed transcript-output deadlines.
- Use `cancel_stale_thread_turn`, not `interrupt_thread_turn`, for stale cleanup.

Update `InterruptThreadTurnTool` description to say it is a manual stop tool, not a stale detector.

Add the new tools to `OrchestrationToolkit` next to the existing turn-control tools:

```ts
GetThreadTurnStatusTool,
WaitForThreadUpdateTool,
CancelStaleThreadTurnTool,
InterruptThreadTurnTool,
```

- [ ] **Step 4: Wire handlers**

In `apps/server/src/mcp/toolkits/orchestration/handlers.ts`, add:

```ts
get_thread_turn_status: (input) =>
  invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getThreadTurnStatus(input)))),
wait_for_thread_update: (input) =>
  invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.waitForThreadUpdate(input)))),
cancel_stale_thread_turn: (input) =>
  invokeWrite(McpOrchestrationService.pipe(Effect.flatMap((s) => s.cancelStaleThreadTurn(input)))),
```

- [ ] **Step 5: Add tool schema tests**

In `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`:

- Add the three tool names to `expectedToolNames`.
- Assert all new inputs have field descriptions.
- Assert `wait_for_thread_update` description contains `never interrupts`.
- Assert `cancel_stale_thread_turn` has `threadId`, `turnId`, and `ifNoProgressSince`.
- Assert `interrupt_thread_turn` description points stale cleanup to `cancel_stale_thread_turn`.

Run:

```sh
vp test apps/server/src/mcp/toolkits/orchestration/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add MCP service turn-control tests**

In `apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts`, add:

- `getThreadTurnStatus` returns running liveness for an active turn.
- `waitForThreadUpdate` returns `progress` for reasoning-only provider signal and exposes no reasoning content.
- `waitForThreadUpdate` returns `pending_request` when an approval/user-input opens.
- `waitForThreadUpdate` returns `timeout` and dispatches no interrupts.
- `cancelStaleThreadTurn` rejects a non-stale active turn with `not_stale`.
- `cancelStaleThreadTurn` rejects when progress occurred after `ifNoProgressSince` with `progress_observed`.
- `cancelStaleThreadTurn` interrupts the exact stale active turn.
- `cancelStaleThreadTurn` cannot interrupt a newer turn after the requested `turnId` completed.
- `force: true` records an override activity and still targets the exact active turn.

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add toolkit integration tests**

In `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`, verify:

- New tools are exposed over the transport.
- Handler dispatch reaches the service for status/wait/cancel.
- Read/write capability checks apply: status/wait require read, cancel requires write.

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit task 4**

Run:

```sh
vp test apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
git status --short
git add apps/server/src/mcp/Services/McpOrchestrationService.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
git commit -m "Expose MCP turn liveness wait and stale cancel tools"
```

Expected: targeted tests pass and commit succeeds.

---

### Task 5: End-To-End Regressions And Guidance

**Files:**

- Modify: `apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Modify: `apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-mcp-child-turn-liveness-design.md` only if the spec should be updated to match the implemented `turnId` and cursor decisions.

**Regression invariants:**

- Parent-visible transcript silence is not stale when provider signals continue.
- `waitForResponse` timeout does not cancel.
- `turnTimeoutMs` still cancels a running turn even if provider signals continue.
- `responseTimeoutMs` still cancels a turn blocked on a pending request.
- `wait_for_thread_update` and `cancel_stale_thread_turn` are the preferred stale-cleanup loop.

- [ ] **Step 1: Add full parent-agent idiom regression**

Add a test that executes the intended parent flow:

1. Send a child turn with `waitForResponse: true` and a short `timeoutMs`.
2. Simulate no assistant text but a reasoning provider signal.
3. Assert wait result is running/timed out and no interrupt was dispatched.
4. Call `waitForThreadUpdate` and assert `reason: "progress"`.
5. Advance beyond stale threshold without signals.
6. Call `waitForThreadUpdate` and assert `reason: "stale"`.
7. Call `cancelStaleThreadTurn` with the returned cursor.
8. Assert the interrupt carries the exact stale `turnId`.

- [ ] **Step 2: Preserve existing hard budgets**

Add or update tests:

- `turnTimeoutMs` cancels even while provider signals are arriving.
- `responseTimeoutMs` cancels a still-open pending request.
- Neither watcher cancels a newer turn after the armed turn ended.

- [ ] **Step 3: Update spec if desired**

If the project treats the spec as living documentation, update `docs/superpowers/specs/2026-06-29-mcp-child-turn-liveness-design.md` with:

- Optional `turnId` on `get_thread_turn_status` and `wait_for_thread_update`.
- `cursor` on `get_thread_turn_status`.
- Opaque cursor use for `cancel_stale_thread_turn.ifNoProgressSince`.
- `idle` definition.
- Terminal states never stale.
- Atomic rollout of wait plus stale cancel.
- `MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS = 120_000`.

Do not change the core invariant.

- [ ] **Step 4: Run regression target set**

Run:

```sh
vp test apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit task 5**

Run:

```sh
git status --short
git add apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts docs/superpowers/specs/2026-06-29-mcp-child-turn-liveness-design.md
git commit -m "Harden child turn liveness regressions"
```

If the spec was not modified, omit it from `git add`.

---

### Task 6: Final Verification And PR Update

**Files:**

- No new files expected.

- [ ] **Step 1: Run full required verification**

Run:

```sh
vp check
vp run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run focused liveness suite**

Run:

```sh
vp test packages/contracts/src/orchestration.test.ts apps/server/src/persistence/Migrations/037_ProjectionTurnLiveness.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/ThreadTurnLivenessQuery.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.turnControl.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```sh
git status --short
git diff --stat origin/main...HEAD
```

Expected: only planned files changed.

- [ ] **Step 4: Final commit if needed**

If verification required small follow-up fixes, rerun the targeted tests for the task that owns those files, then reuse that task's explicit staging command and commit message pattern. Do not stage unrelated files.

Expected: any final commit contains only files from this liveness plan.

- [ ] **Step 5: Push and update PR**

Only after verification passes:

```sh
git push origin t3code/mcp-orchestration
```

Update PR #2 with a summary:

- Provider-signal liveness projection.
- Status and non-cancelling wait tools.
- Guarded stale cancellation path.
- Regression coverage proving transcript silence and wait timeout do not cancel child work.

## Self-Review Checklist

- Spec goals covered: yes. The plan prevents silence-based interruption, keeps bounded waits, preserves explicit hard budgets, and avoids private reasoning exposure.
- Claude review covered: yes. Write path, coalescing math, atomic wait/cancel rollout, scoped `turnId`, terminal guard, idle definition, timeout max, and cursor opacity are all included.
- Testability: yes. The central seam is `ThreadTurnLivenessQuery`, with ingestion/projection/MCP tests around it.
- Type consistency: yes. Contracts contain only schemas; server runtime types and Effect services live under `apps/server/src/orchestration`.
- Risk notes: the only deliberate contract expansion beyond the spec is optional `turnId` and opaque cursor use for cancellation, both added to close races identified in review.
