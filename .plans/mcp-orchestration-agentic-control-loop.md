# Plan: MCP Orchestration — Closing the Agentic Control & Results Loop

## Summary

The MCP orchestration surface can **spawn** and **observe** sub-threads but cannot **unblock**, **steer**, or **collect results** from them. Worse, an MCP-spawned thread set to `approval-required` **deadlocks** — it blocks on an approval gate that no MCP caller can answer. This plan exposes the missing control surface (answer approvals/user-input, interrupt), adds result retrieval (code diff + verbatim final answer), bounds runaway/abandoned turns, and replaces today's unsafe spawn defaults — turning multi-agent orchestration into a closed, deadlock-free loop.

Most of this is **plumbing over capabilities that already exist**: the decider commands (`thread.approval.respond`, `thread.user-input.respond`, `thread.turn.interrupt`) and the diff RPCs (`getTurnDiff` / `getFullThreadDiff`) are implemented and tested; they are simply not exposed through MCP. The genuinely new behavior is the per-turn timeouts, `wait_for_response`, and the MCP-layer spawn defaults.

## Motivation

- **Deadlock.** `create_thread` accepts `runtime_mode: approval-required`, but when the child hits a gate the provider blocks on `Deferred.await` (`GrokAdapter.ts:510`); only a human dispatching `thread.approval.respond` from the UI can answer. The orchestrator can't answer, can't interrupt, can't even re-message (the thread isn't idle). An option is shipped with no completion path.
- **No steering.** No way to stop a runaway/misdirected child (`thread.turn.interrupt` exists, unexposed).
- **No results.** The point of a worktree sub-thread is the change it produces; the diff engine exists but isn't reachable. And research/review sub-agents need their **final answer text**, which no tool returns cleanly today.
- **Unsafe defaults.** `DEFAULT_RUNTIME_MODE = "full-access"` (`orchestration.ts:123`) + omitted checkout = an MCP child runs **arbitrary commands, unsupervised, in the shared working tree**.

## Governing principles

1. **No blocking state without a completion path.** Every state a child can enter (awaiting approval, awaiting user-input, running too long) must be resolvable through MCP (answer, or interrupt, or a bounded timeout).
2. **Automatic resolution is only ever _cancel_, never _approve_.** Timeouts cancel; they never grant.
3. **Consequential defaults are obvious in the tool/parameter/response descriptions** so the agent decides deliberately — never silently defaulted.

## Scope

- **Phase 1.0 — MCP thread provenance & ownership (foundation) — ✅ IMPLEMENTED:** records each thread's creator/origin (`createdVia` + `createdByThreadId`, migration 036); `requireThreadManageableByMcp` scopes **all** MCP thread management (`send_thread_message`, `update_thread_settings`, `create_thread` parent) to the credential's own creation-subtree with a self-exception, firewalling user-created threads, via cycle-safe creator-chain walk + diagnosable `forbidden`; `McpIcon` badge in the sidebar tree. Reads remain under `orchestration.read` (unscoped) per Decision 11. Verified: typecheck + lint green; MCP write tests (incl. 2 new ownership cases) + web/client suites pass. The control tools *and* cleanup (Phase 1) reuse `requireThreadManageableByMcp`.
- **Phase 1 — control + collect loop:** answer/interrupt control tools, unified pending-request discovery, result retrieval (diff + messages), per-turn timeouts, `wait_for_response`, safe MCP spawn defaults, tool renames. Now **includes thread cleanup** (`delete_thread` / `archive_thread` / `unarchive_thread`), made safe by Phase 1.0 ownership.
- **Phase 2 — retry + extras (follow-up):** `revert_thread_checkpoint`, `stop_thread_session`, `delete_project`, per-turn **token cap**.
- **Deferred (own work):** a capability **privilege tier** separating "observe / plan-only" from "can cause unsupervised execution" (see Decision 1) — orthogonal to Phase 1.0 (capability = *which ops you hold*; ownership = *which threads you may touch*).

## Design decisions

### 1. Trust boundary: single `orchestration.write` capability — no new scope
All control tools sit under the existing `orchestration.write` capability (`McpInvocationContext.ts:6`). Rationale: a credential with `orchestration.write` can already spawn a `full-access` child that runs arbitrary commands with zero gates, so a *separate, stricter* gate for the strictly-less-dangerous approval response would lock a window while the door stands open. Today every provider-spawned credential gets all capabilities anyway (`McpSessionRegistry.ts:58-62`). A genuine privilege **tier** (gating unsupervised-execution as a class — `full-access` spawn + `auto-accept` spawn + approve — behind a higher capability, with a grant mechanism) is the correct lever and is **deferred** to its own work.

### 2. Discovery: fold pending requests into `get_thread_settings`
The open request set is already tracked server-side (`ProjectionPipeline.ts:136,155,160` `openRequestIds`; surfaced as a count via `ProjectionSnapshotQuery.ts:268`). Exposing the ids is plumbing. `get_thread_settings` (already polled for run-state) gains:
- `hasPendingApprovals`, `hasPendingUserInput` (booleans)
- `pendingRequests`: tagged union —
  - `{ kind: "approval", requestId, requestKind, requestType, detail }`
  - `{ kind: "user-input", requestId, prompt, fields }`
- `detail` bounding: full command verbatim (commands are short; truncating one is a footgun); large file-change patches capped with `truncated: true` + a pointer to `get_thread_diff` (mirrors the `payload_too_large` pattern).

One cheap call yields "is it blocked?" **and** "here's the id to unblock it."

### 3. Completion path: interrupt + auto-cancel-only timeout
- Expose **`interrupt_thread_turn`** (`thread.turn.interrupt`). It already settles pending approvals as `cancel` and frees the session (`GrokAdapter.ts:887-895`); interrupted thread returns to idle (`ProviderCommandReactor.ts:304,478,969`) and is re-messageable → valid **interrupt → send corrective message** steer loop.
- **`response_timeout_ms`** (per-turn, agent-set, default OFF): max wait on any single pending request (approval **or** user-input). Breach → **cancel** the turn (never approve), leaving a clear "timed out awaiting response" activity. Abandonment (orchestrator dies / credential expires at 30 min idle, 8 h max) is the agent's responsibility to bound via this knob or `interrupt`.

### 4. Safe MCP spawn defaults (when omitted)
Mode semantics (`CodexSessionRuntime.ts:271-288`): `full-access` removes the sandbox (a worktree does **not** contain it); `auto-accept-edits` keeps a `workspace-write` sandbox and gates only escalations.
- Runtime mode omitted → **`auto-accept-edits`** (not `full-access`).
- Checkout omitted → **`new_worktree` for `top_level`**, **inherit parent** for `child_of_thread`.
- **Default-only-when-omitted**; explicit `full-access` / `current_checkout` respected (agent is trusted, Decision 1).
- **Scoped to the MCP service layer.** Do **not** change the global `DEFAULT_RUNTIME_MODE` (`orchestration.ts:123`) — the human UI keeps its behavior. Document as a deliberate behavior change for orchestrators that relied on the implicit `full-access`.

### 5. `respond_to_user_input` — symmetric to approvals
Built in this phase. `answers` is free-form `Record<String, Unknown>` (`ProviderUserInputAnswers`, `orchestration.ts:138`) → `thread.user-input.respond`. Discovery (Decision 2) surfaces the `prompt` + `fields` so the agent can construct keys. `response_timeout_ms` covers it too. User-input fires independent of sandbox/runtime mode, so without this tool a child that asks a question hangs — same deadlock class.

### 6. `respond_to_approval` decision values
`ProviderApprovalDecision = [accept, acceptForSession, decline, cancel]` (`orchestration.ts:131`). Expose **`accept` / `decline` / `acceptForSession`**; **exclude `cancel`** (system-reserved — `GrokAdapter.ts:152` types the respond path `Exclude<…,"cancel">`; cancellation goes through `interrupt`/timeout). `acceptForSession` is surgical (suppresses that one permission-kind for the session) and useful for autonomous loops, but its description must state plainly it **suppresses future same-kind gates for the session and can't be individually revoked**.

### 7. `get_thread_diff` — collect the code result
One tool: `get_thread_diff(threadId, fromTurnCount?, toTurnCount?, ignoreWhitespace?, maxCharacters?)`.
- Omit the range → **full diff to latest** (resolve latest server-side from checkpoints) — single-arg "give me everything this child changed."
- Range → turn-range diff (`getTurnDiff`); else `getFullThreadDiff`. `ThreadTurnDiff = { threadId, fromTurnCount, toTurnCount, diff: string }` (`orchestration.ts:1148`).
- `maxCharacters` → `payload_too_large` (mirror `get_thread_messages`).
- Returns the unified `diff` string + resolved range + a **structured file summary** (paths + added/removed counts, from the checkpoint `files` array) so the agent can triage without parsing — and still useful when the diff is truncated.

### 8. Runaway protection
- **`turn_timeout_ms`** (per-turn, agent-set, default OFF): total wall-clock for the turn; breach → `interrupt`. Composes with `response_timeout_ms` (that bounds *awaiting a response*; this bounds *total work*) — whichever fires first cancels.
- **Drop `max_turns`** — the orchestrator is the turn loop (it decides each `send_thread_message`).
- **Defer the token cap** to Phase 2 (continuous threshold monitoring + interrupt is real new machinery; `turn_timeout_ms` bounds the worst case).

### 9. Result retrieval: rename `get_thread_history` → `get_thread_messages`
The tool now spans targeted reads, not just history. **Key enabling fact:** an assistant `OrchestrationMessage.text` is built **only** from `assistant_text` deltas — the ingestion gate `ProviderRuntimeIngestion.ts:1361-1364` drops `reasoning_text` / `reasoning_summary_text` / `plan_text`, and reasoning becomes no activity either. So `message.text` is **already** the clean answer; returning "the response without reasoning" is lossless plumbing. Turn↔message pointers exist (`assistantMessageId` on `latestTurn`/checkpoints, `orchestration.ts:339,300,975`).

`mode` values:

| `mode` | input | returns |
|---|---|---|
| `summary` | — | LLM-distilled summary (existing) |
| `complete` | `limit`/`cursor`/`maxCharacters` | full paged history (existing) |
| `latest_response` | — | last assistant message of the latest **completed** turn, **verbatim** (reasoning/tools/preamble excluded). `inProgress: true` + previous completed answer if a turn is running. |
| `turn` | `turnCount` | that turn's user message + assistant response + turn `state` |
| `message` | `messageId` | a single message |

- **Honest limit:** we exclude reasoning, tool calls, and everything before the final message, but **cannot strip in-prose narration** the model wrote as `assistant_text` — that distillation is exactly what `summary` mode is for.
- **Impl detail:** if a turn yields multiple assistant messages (text → tool → text), define `latest_response` as the turn's **last** assistant message (confirm vs `getOrCreateAssistantMessageId`).

### 10. `wait_for_response` — one-call send-and-collect
Boolean `wait_for_response` + `timeout_ms` on `send_thread_message` / `create_thread`. When true, the call blocks until the turn reaches a terminal state (`completed` / `interrupted` / `error`) or `timeout_ms` elapses, then returns **`state` + the verbatim final answer inline** (same extraction as `latest_response`, `maxCharacters`-bounded with `truncated` + pointer). Makes "send task → get answer" a single call for research/review sub-agents.
- On `timeout_ms`: **stop waiting, do not cancel** the turn (distinct from `turn_timeout_ms`, which cancels).
- `error` / `interrupted` / edits-only turns return `state` + **null** answer (use `get_thread_diff` for the code result).

### 11. Thread provenance & ownership (authorization foundation — underpins all MCP management)
Today threads record no creator (`ThreadCreateCommand` has no origin field), but the MCP layer already knows it at create time via `invocation.threadId` (`McpOrchestrationService.ts:1484`). Add two **immutable** fields, stamped at creation:
- `createdVia: "user" | "mcp"`
- `createdByThreadId: ThreadId | null` — the orchestrator thread (from `invocation.threadId`); `null` for user-created.

> **Encoding (impl, step 1 done):** on the event payload + read models these are **optional** fields; **absence is interpreted as `user` / unowned** — the fail-safe default (MCP can't manage what isn't provably its own). Production paths set real values (MCP service stamps `mcp`+creator at `McpOrchestrationService` create sites; the WS `Normalizer` forces `user` to block spoofing); the SQL projection row keeps them required via a `created_via TEXT NOT NULL DEFAULT 'user'` column (migration 036). The security property lives in the production write-path + the ownership check, not in construction-time required types — which also avoided churning ~70 read-model/event test fixtures.

**Authorization rule** for a credential bound to thread **T** managing target **X** (one sentence): *an MCP credential may manage any thread in its own **creation-subtree** — the threads T spawned and everything they spawned, recursively — and nothing else; user-created threads are never MCP-manageable.*

- **Firewall (hard):** `X.createdVia === "mcp"` required. MCP can never manage a `user` thread. Protects human-owned work.
- **Ownership (scope):** walk `X.createdByThreadId` upward via a **provenance-only lookup** (`getThreadCreatorById` — no active/archive filter, so an archived/deleted intermediate ancestor doesn't strand owned descendants); T must appear in the chain (transitive subtree — handles supervisor-over-sub-orchestrator hierarchies). Termination is guaranteed by a visited-set; a dedicated `MAX_MCP_CREATOR_CHAIN_DEPTH` (64) caps the work. (Not `MAX_THREAD_TREE_DEPTH`, which is `1` and bounds the *display* tree, not creator chains.)
- **No sibling cross-modify.** A child can't reach its siblings (it didn't spawn them); the **parent** owns and coordinates its children. Removes peer-nuking as a failure mode.
- **Applies to all MCP management** — `interrupt`, `respond_*`, `send_thread_message`, `update_thread_settings`, and cleanup — not just destructive ops. Reads stay under the existing `orchestration.read` capability (scope later if desired).
- This is the resource-level half of Decision 1's deferred boundary: capability = *which ops*; ownership = *which threads*.
- **UI:** render `McpIcon` (`Icons.tsx:700`) beside the thread title in the sidebar tree, mirroring the remote `CloudIcon` pattern (`ThreadStatusIndicators.tsx:251-261`), driven by `createdVia === "mcp"`.

## Invariants & implementation notes

- **MCP management is ownership-scoped (Decision 11)** before any other check. Blocks return a **diagnosable** `forbidden` error stating the cause — user-thread firewall vs. out-of-subtree — so workflow friction during testing is obvious, not mysterious.
- **Control tools are exempt from the idle gate.** `respond_to_approval`, `respond_to_user_input`, `interrupt_thread_turn` act on *running/blocked* threads by definition. `send_thread_message`/settings writes keep the idle precondition (`McpOrchestrationService.ts:558` `non_idle_thread`). `respond_*` additionally require the `requestId` to still be open → stale-request error (cf. `ProjectionPipeline.ts:167` stale pending user-input handling).
- **Shared answer extraction.** `latest_response` and `wait_for_response` use one code path (verbatim `assistant_text`, reasoning/tools excluded, `maxCharacters`-bounded). DRY per AGENTS.md.
- **Reasoning needs no stripping** — excluded by construction at ingestion.
- **Existing commands/RPCs reused:** `thread.approval.respond`, `thread.user-input.respond`, `thread.turn.interrupt`, `getTurnDiff`, `getFullThreadDiff`. New code is the timeouts, `wait_for_response`, MCP-layer defaults, and the `get_thread_settings` / `get_thread_messages` response shapes.
- **Descriptions** for every new/changed tool, parameter, and response spell out behavior and consequence (Principle 3): the omitted-runtime default (`auto-accept-edits` = sandboxed) and checkout default (`new_worktree` = isolated); `acceptForSession`'s session-wide suppression; `response_timeout_ms`/`turn_timeout_ms` = cancel vs `wait_for_response` timeout = stop-waiting; each `get_thread_messages` mode's return shape.

## Proposed changes (tool surface)

**Phase 1.0 — provenance & ownership foundation**
0a. Thread model: add immutable `createdVia` + `createdByThreadId` (command → event → projector → snapshot); stamp in MCP `create_thread` from `invocation.threadId`.
0b. Ownership-authorization helper (creator-chain walk, depth-bounded) applied across all MCP management ops; diagnosable `forbidden` errors.
0c. UI: `McpIcon` beside the thread title in the sidebar tree (mirror `CloudIcon` in `ThreadStatusIndicators.tsx`).

**New tools**
1. `interrupt_thread_turn(threadId)` → `thread.turn.interrupt`
2. `respond_to_approval(threadId, requestId, decision: accept|decline|acceptForSession)` → `thread.approval.respond`
3. `respond_to_user_input(threadId, requestId, answers)` → `thread.user-input.respond`
4. `get_thread_diff(threadId, fromTurnCount?, toTurnCount?, ignoreWhitespace?, maxCharacters?)` → diff RPCs
5. `delete_thread(threadId)` / `archive_thread(threadId)` / `unarchive_thread(threadId)` → `thread.delete` / `thread.archive` / `thread.unarchive` (ownership-scoped per Phase 1.0)

**Changed tools**
6. `get_thread_settings` → add `hasPendingApprovals`, `hasPendingUserInput`, `pendingRequests[]`
7. `get_thread_history` → **rename `get_thread_messages`**; add modes `latest_response` | `turn` | `message`
8. `create_thread` / `send_thread_message` → add `response_timeout_ms`, `turn_timeout_ms`, `wait_for_response` + `timeout_ms`; apply MCP-layer safe defaults (`auto-accept-edits`, `new_worktree`/inherit) when omitted

## Testing

- Unit: each new tool's schema/handler; default-injection (omitted → safe; explicit → respected); decision-value mapping (incl. `cancel` exclusion); pending-request projection → `pendingRequests`.
- Integration: spawn `approval-required` child → discover via `get_thread_settings` → `respond_to_approval(accept)` → turn proceeds (no deadlock). Spawn → `interrupt` → idle → re-message. `response_timeout_ms`/`turn_timeout_ms` → cancel + activity. `wait_for_response` → state + inline answer; timeout → stop-waiting, turn still running. `latest_response` excludes reasoning; `get_thread_diff` round-trips a worktree change.
- Invariants: control tools bypass idle gate; stale `requestId` → error.

## Follow-ups (Phase 2 / deferred)

- `revert_thread_checkpoint` (retry/undo; worktree implications).
- `stop_thread_session`; `delete_project` (destructive cascade).
- Per-turn **token cap** (interrupt on threshold).
- Capability **privilege tier** for unsupervised-execution as a class (Decision 1) — complements Phase 1.0 ownership.
- Possible: scope MCP **reads** by ownership too (currently only management is scoped).
- Validate in real use that subtree-ownership doesn't over-constrain legitimate workflows (owner's note).
