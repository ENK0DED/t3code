# MCP Child Turn Liveness Design

Date: 2026-06-29
Status: Draft for user review

## Context

MCP orchestration lets a parent agent create child threads, send turns, wait for
answers, inspect messages, and interrupt work. High-reasoning child turns can be
silent from the transcript's perspective for a long time, especially Claude
turns where private reasoning is not exposed as assistant output. Parent agents
then often treat missing output or a `waitForResponse` timeout as staleness and
interrupt the child.

That behavior wastes tokens and loses valid work. The existing server semantics
are already safer than the parent behavior: `waitForResponse` timeout stops
waiting but does not cancel, while `turnTimeoutMs` and `responseTimeoutMs` are
the explicit cancellation controls. The missing piece is a first-class liveness
contract that gives parent agents a cheap way to distinguish "still running but
silent" from "actually stuck".

This design prefers preserving long-running reasoning over aggressively capping
token spend. Silence alone must never mean stale.

## Goals

- Prevent parent agents from interrupting child turns solely because no final
  answer or transcript output arrived quickly.
- Give parent agents a small, explicit status surface for running child turns.
- Let parents wait for terminal state, progress, blocked requests, or a bounded
  non-cancelling timeout without inventing their own polling heuristics.
- Keep hard spend bounds available through explicit `turnTimeoutMs`.
- Keep blocked-gate cleanup available through explicit `responseTimeoutMs`.
- Avoid exposing hidden reasoning text or provider-private chain of thought.
- Make cancellation harder to misuse by allowing stale-aware cancellation paths.

## Non-Goals

- No indefinite MCP tool call by default. Every wait remains bounded.
- No exposure of private reasoning content.
- No automatic approval of pending requests.
- No replacement of `turnTimeoutMs` as the hard explicit work budget.
- No attempt to infer semantic task quality or correctness from provider
  liveness.
- No deep thread nesting changes.

## Core Invariant

```text
A running child thread may be silent indefinitely from the transcript's perspective.
Only server-observed lack of provider/runtime progress can make it stale.
```

The transcript is a product output, not a liveness signal. A model can be
reasoning, waiting on a provider stream, processing tools, compacting context, or
building a diff without appending assistant text.

## Current Behavior To Preserve

`waitForResponse` remains a convenience wait. Its timeout means:

```text
The MCP call stopped waiting; the turn may still be running.
```

It must not cancel the turn.

`turnTimeoutMs` remains a hard wall-clock work budget. Its timeout means:

```text
Cancel this exact turn if it is still running.
```

`responseTimeoutMs` remains a blocked-request budget. Its timeout means:

```text
Cancel this exact turn if a pending approval/user-input request stayed open too long.
```

## Liveness Model

Add a projected liveness summary for the currently active or most recent turn.
The external interface should be intentionally small and stable:

```ts
interface ThreadTurnLiveness {
  threadId: ThreadId;
  turnId: TurnId | null;
  state: "pending_start" | "running" | "completed" | "interrupted" | "error" | "idle";
  startedAt: string | null;
  completedAt: string | null;
  runningForMs: number | null;

  lastMessageAt: string | null;
  lastActivityAt: string | null;
  lastProviderSignalAt: string | null;
  lastObservableProgressAt: string | null;

  pendingRequests: ReadonlyArray<PendingRequest>;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;

  stale: boolean;
  staleReason: "no_provider_signal" | "no_observable_progress" | "none";
  staleAfterMs: number;
  safeToInterrupt: boolean;
}
```

Field meanings:

- `lastMessageAt`: last user or assistant message projection timestamp.
- `lastActivityAt`: last projected activity timestamp.
- `lastProviderSignalAt`: last runtime signal from the provider for this turn,
  including hidden reasoning deltas, task progress, tool lifecycle updates, token
  usage updates, and assistant text deltas.
- `lastObservableProgressAt`: max of message, activity, and provider-signal
  timestamps.
- `stale`: server-derived classification using provider-aware thresholds.
- `safeToInterrupt`: true only when the server believes interruption is
  reasonable without an explicit force override.

`lastProviderSignalAt` must be based on actual runtime/provider events, not a
timer tied only to an open socket. An open but silent connection is not progress.

## Staleness Policy

The default policy should be conservative:

- A running turn is not stale while any pending approval/user-input request is
  open; it is blocked, not stale. Use `responseTimeoutMs` for this case.
- A running turn is not stale while `lastProviderSignalAt` is recent.
- A running turn is not stale merely because `lastMessageAt` is old.
- A running turn may become stale only after `lastObservableProgressAt` is older
  than the configured stale threshold.

Initial thresholds:

```ts
defaultStaleAfterMs = 10 * 60_000;
claudeHighReasoningStaleAfterMs = 20 * 60_000;
providerSignalCoalesceMs = 30_000;
```

The implementation may start with constants. A later settings UI can expose
these values if real usage shows they need tuning.

`providerSignalCoalesceMs` is not a synthetic heartbeat. It is the minimum
interval for persisting repeated provider-signal updates while a turn is already
known running, so reasoning-token streams cannot flood the projection.

Claude/high-reasoning turns get the longer threshold because hidden reasoning can
legitimately run without transcript output. The check should key off resolved
provider/model/options where available, falling back to the default threshold
when resolution is stale or unknown.

## MCP Tool Changes

### `get_thread_turn_status`

Add a read-only tool:

```ts
get_thread_turn_status({
  threadId: ThreadId
}) => {
  threadId,
  liveness: ThreadTurnLiveness
}
```

This is the cheap status query parents use after any non-cancelling wait timeout.
It avoids forcing agents to fetch full settings, messages, or diffs just to know
whether a child is still alive.

### `wait_for_thread_update`

Add a read-only, non-cancelling wait tool:

```ts
wait_for_thread_update({
  threadId: ThreadId,
  since?: string,
  timeoutMs?: number,
  includeStatus?: boolean
}) => {
  threadId,
  reason:
    | "terminal"
    | "progress"
    | "pending_request"
    | "stale"
    | "timeout",
  cursor: string,
  liveness?: ThreadTurnLiveness
}
```

Behavior:

- Subscribes before probing, like `waitForResponse`, so terminal/progress events
  are not missed.
- Returns `terminal` when the active turn completes, errors, or is interrupted.
- Returns `progress` when a new message, activity, or provider signal occurs
  after `since`.
- Returns `pending_request` when an approval or user-input request opens.
- Returns `stale` only when server-derived liveness says stale.
- Returns `timeout` when no relevant update occurs before `timeoutMs`.
- Never interrupts the child turn.
- Always returns a new cursor that can be fed back as `since`.

The cursor may initially be the latest relevant timestamp plus a tie-breaker.
It must be opaque to callers so the server can later replace it with a sequence
or event id without changing the tool contract.

### Stale-Aware Cancellation

Add one of these two cancellation paths:

1. Preferred: add `cancel_stale_thread_turn`.

```ts
cancel_stale_thread_turn({
  threadId: ThreadId,
  turnId: TurnId,
  ifNoProgressSince: string,
  force?: boolean
})
```

2. Alternative: extend `interrupt_thread_turn`.

```ts
interrupt_thread_turn({
  threadId: ThreadId,
  expectedTurnId?: TurnId,
  ifNoProgressSince?: string,
  force?: boolean
})
```

The preferred new tool has a better interface because its name tells agents this
is the stale-cleanup path, not a normal control operation.

Default behavior:

- Reject if the target turn is no longer active.
- Reject if `ifNoProgressSince` is older than the current
  `lastObservableProgressAt`.
- Reject unless `safeToInterrupt` is true.
- Allow `force: true` only as an explicit override and record that override in
  the resulting activity.

## Parent Agent Idiom

Parent agents should stop using missing output as a child health signal.

Recommended loop:

```text
send child turn with waitForResponse true and a short timeoutMs
if terminal, consume answer/diff and continue
if timed out, call wait_for_thread_update in a loop
if progress, continue waiting
if pending_request, answer or escalate it
if stale, call cancel_stale_thread_turn
if timeout, call get_thread_turn_status before making any decision
```

Tool descriptions should say this explicitly. In particular:

- `waitForResponse.timeoutMs` is not a stale signal.
- Do not interrupt a child because `answer` is null while `state` is running.
- For Claude/high-reasoning children, prefer `wait_for_thread_update` over fixed
  transcript-output deadlines.

## Architecture

The liveness module should sit behind a small interface:

```ts
interface ThreadTurnLivenessQuery {
  getThreadTurnLiveness(threadId: ThreadId): Effect<ThreadTurnLiveness, Error>;
  watchThreadUpdate(input): Effect<ThreadUpdateWaitResult, Error>;
}
```

This interface is the test seam. MCP handlers call it directly. The
implementation can compose:

- projection thread detail/shell reads
- projection turn reads
- domain event stream subscription
- provider runtime ingestion liveness markers
- model/provider option resolution for threshold selection

Do not spread stale calculations into MCP handlers. The calculation belongs in
one module so the UI, MCP, and future cleanup automation can share it.

## Projection And Runtime Signals

Provider runtime ingestion already sees more than transcript text:

- `content.delta` with `assistant_text`
- `content.delta` with `reasoning_text` or `reasoning_summary_text`
- `task.progress`
- `item.started`, `item.updated`, `item.completed`
- `thread.token-usage.updated`
- approval/user-input request events
- turn lifecycle events

The projection should record turn-scoped liveness without storing private
reasoning text. A minimal persistence shape is enough:

```ts
projection_turn_liveness(
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  last_provider_signal_at TEXT,
  last_observable_progress_at TEXT,
  last_signal_kind TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, turn_id)
)
```

`last_signal_kind` should be broad (`assistant_text`, `reasoning`, `tool`,
`task`, `token_usage`, `request`, `lifecycle`) and must not contain private
content.

## Error Handling

`get_thread_turn_status`:

- `unknown_thread`: thread does not exist or is not visible to the credential.
- `forbidden`: credential lacks orchestration read capability.

`wait_for_thread_update`:

- `unknown_thread`: thread does not exist or is not visible to the credential.
- `invalid_cursor`: `since` cannot be decoded.
- `invalid_input`: timeout is non-positive or too large.
- On timeout, return a structured `reason: "timeout"` result rather than an
  error.

`cancel_stale_thread_turn`:

- `unknown_thread`: thread does not exist or is not visible to the credential.
- `turn_not_active`: target turn is no longer active.
- `not_stale`: server liveness does not consider the turn stale.
- `progress_observed`: progress was observed after `ifNoProgressSince`.
- `forbidden`: credential lacks orchestration write capability or ownership.

## Testing

Add tests at the liveness module seam first:

- Running turn with no transcript output but recent provider signal is not stale.
- Running Claude/high-reasoning turn uses the longer stale threshold.
- Running turn with old `lastProviderSignalAt` and no pending requests becomes
  stale.
- Pending approval/user-input makes the turn blocked, not stale.
- `safeToInterrupt` is false when progress occurred after the caller's
  `ifNoProgressSince`.

MCP service tests:

- `get_thread_turn_status` returns liveness for a running child thread.
- `wait_for_thread_update` returns `progress` for reasoning-only provider
  signals without exposing reasoning text.
- `wait_for_thread_update` returns `timeout` without interrupting.
- `wait_for_thread_update` returns `pending_request` when a request opens.
- `cancel_stale_thread_turn` rejects a non-stale active turn.
- `cancel_stale_thread_turn` rejects when progress occurred after the supplied
  stale cursor.
- `cancel_stale_thread_turn` interrupts the exact stale active turn.

Regression tests:

- `waitForResponse` timeout still returns `running` and does not cancel.
- `turnTimeoutMs` still cancels even while provider signals are arriving.
- A late stale-cancel attempt cannot interrupt a newer turn.
- A terminal event racing a progress event returns terminal or observes terminal
  on the next status read, never stale.

## Rollout

1. Add liveness projection and query module.
2. Add `get_thread_turn_status`.
3. Add `wait_for_thread_update`.
4. Update tool descriptions and MCP guidance to discourage silence-based
   interruption.
5. Add stale-aware cancellation.
6. Optionally surface liveness in the UI tree as a child-thread status detail.

Steps 1-4 provide the core safety improvement without changing existing
cancellation behavior. Step 5 hardens cleanup workflows after the status surface
is available.
