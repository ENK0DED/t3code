# T3Code MCP Orchestration Tools Design

Date: 2026-06-25
Status: Approved design, awaiting implementation plan

## Context

T3 Code already exposes a provider-scoped integrated MCP server for preview automation. The current MCP credential is scoped to the issuing environment/thread/provider instance and only grants the `preview` capability. The requested feature expands this server into an orchestration surface so a running agent can discover models, inspect projects and threads, create child threads, delegate work, send messages, and adjust thread settings while the T3 UI visualizes the resulting structure.

The implementation should preserve the existing orchestration/event/projection architecture. MCP handlers should be thin wrappers around shared server services so validation, dispatch, search, and settings behavior can be tested independently and reused by future non-MCP server entry points.

## Goals

- Add MCP tools for model discovery, project/thread discovery, thread history, current settings, project creation, thread creation, message sending, and thread settings updates.
- Add server-side model MCP enablement, defaulting every available built-in and custom model to enabled.
- Add a real parent/child thread relationship and sidebar visualization for sub-threads.
- Add fast full-history thread search with SQLite FTS5.
- Reuse existing orchestration commands and bootstrap flows wherever possible.
- Keep write tools predictable: validate up front, error on active threads, and return after command acceptance rather than waiting for model completion.

## Non-Goals

- No concurrent message queueing into running threads. Write tools must error unless the target thread is idle/ready.
- No new destructive MCP tools for deleting or archiving projects/threads.
- No per-provider or per-tool policy UI in this first pass. MCP orchestration credentials use a fixed first-party capability set.
- No physical worktree creation for empty new-worktree threads until the first message is sent.

## Architecture

Add an orchestration MCP toolkit beside the existing preview toolkit. The toolkit handlers should delegate to a shared server-side service named `McpOrchestrationService` that owns:

- MCP capability checks.
- Provider/model discovery and MCP model enablement filtering.
- Project and thread list/search queries.
- Thread settings extraction and validation.
- Thread creation, first-turn bootstrap, and message dispatch.
- Thread settings update dispatch.
- Thread history complete/summary responses.

The MCP HTTP layer continues to authenticate every request with the provider-scoped bearer credential. Expand the credential capability set from only `preview` to:

- `preview`
- `orchestration.read`
- `orchestration.write`

Read tools require `orchestration.read`. Write tools require `orchestration.write`. The credential remains bound to the issuing environment and current thread so tools can safely default to "current thread" and "current project" semantics.

## Data Model

### MCP Model Enablement

Add a server setting:

```ts
mcpDisabledModelsByProvider: Record<ProviderInstanceId, string[]>
```

A model is MCP-enabled unless its slug appears in the disabled list for that provider instance. This is stored in server settings, not SQLite, because it is server-wide provider policy rather than per-project/thread state. The setting covers built-in and custom models. Newly discovered models are enabled by default because only disabled overrides are stored.

Provider settings UI writes this setting through `server.updateSettings`.

### Thread Parent Relationship

Add `parentThreadId: ThreadId | null` to:

- `ThreadCreateCommand`.
- thread-created event payloads.
- `OrchestrationThread` and `OrchestrationThreadShell`.
- projection tables and projection mappers.
- shell/detail snapshot query results.

Existing persisted rows decode as `parentThreadId: null`. Parent links must be same-project. Cross-project parent links are rejected.

### Thread Search Index

Add a SQLite FTS5 virtual table for `projection_thread_messages.text`. Keep it synchronized from projection message upserts, deletes, and checkpoint/revert retention paths. Search joins FTS hits back to `projection_threads` so archived/deleted filters are enforced by thread metadata.

If FTS5 is unavailable, the service may fall back to a bounded `LIKE`/scan and include a warning field in the result. It must not silently run an unbounded slow scan.

## MCP Tools

### `list_mcp_models`

Returns provider instances keyed by provider instance id. Only MCP-enabled models are included.

Each provider entry includes:

- `instanceId`
- `driver`
- display name/status/auth metadata where available
- `enabled`
- `models`, keyed by model slug

Each model entry includes:

- `slug`
- `name`
- `shortName` if available
- `subProvider` if available
- `isCustom`
- `mcpEnabled: true`
- `optionDescriptors` from model capabilities

Provider instance id is the canonical key because thread `modelSelection` already stores `instanceId`.

### `list_projects`

Returns non-deleted projects with all project attributes currently available in the projection.

Input:

- optional `search`

Search uses the shared fuzzy ranking helpers to match title and workspace path. If `search` is omitted, return all projects.

### `list_threads`

Returns projected thread attributes for an existing project.

Input:

- `projectId`
- optional `search`
- optional `archived: "exclude" | "include" | "only"`; default `"exclude"`

Search combines fuzzy title matching with FTS message-history search. Results include compact hit metadata and snippets, not full message histories. If `search` is omitted, return all matching threads for the archive filter.

### `get_thread_history`

Returns one thread's history in either summarized or complete form.

Input:

- `threadId`
- `mode: "summary" | "complete"`
- optional `limit`, `cursor`, and `maxCharacters` for complete mode

Summary mode uses the configured server "Text generation model" and a dedicated prompt for thread summarization. It should allow substantially more output than git commit message generation.

Complete mode returns the projected thread detail shape used by the UI: messages, attachment metadata, proposed plans, activities, checkpoints, session, settings, and thread attributes. It returns the full thread by default. If the payload would exceed a central server constant such as `MCP_STRUCTURED_RESPONSE_MAX_BYTES`, it fails with a clear "too large" error instructing the caller to retry with pagination or `maxCharacters`. The implementation should start with a conservative budget and cover it in tests. It must not silently truncate.

### `get_current_thread_settings`

Returns settings for the credential's current thread:

- selected provider instance and model
- provider driver and display metadata
- model option selections and resolved labels, including reasoning/service tier when present
- runtime/access mode
- interaction mode
- checkout mode: current checkout or new/existing worktree
- branch/ref
- worktree path
- session status and active turn information

### `add_project`

Adds a project by source directory path. It should reuse the same normalization, title inference, create-directory behavior, and duplicate detection semantics as the current Add Project flow.

If the normalized path already belongs to an active project, return the existing project with `status: "already_exists"` and do not create a duplicate. Otherwise dispatch `project.create` and return `status: "created"`.

### `create_thread`

Creates a new persisted thread.

Defaults:

- `projectId`: current thread's project
- model/options/runtime/interaction/branch/checkout settings: current thread's settings
- placement: `child_of_current` when creating in the current project; `top_level` when an explicit different project is supplied

Placement input:

- `placement: "child_of_current"`
- `placement: "top_level"`
- `placement: "child_of_thread"` plus `parentThreadId`

Parent/child links must be same-project.

If `message` is omitted, the tool creates an empty persisted thread. If `checkoutMode` is `new_worktree`, this empty thread stores worktree intent and base ref but does not create a physical worktree.

If `message` is supplied, the tool uses the existing first-turn bootstrap path. Thread creation, optional worktree preparation, setup script execution, and `thread.turn.start` are handled atomically by the server bootstrap flow. The tool returns after the turn is accepted, not after provider completion.

### `send_thread_message`

Sends a user message to an existing thread and returns after turn acceptance.

The target thread must be idle/ready:

- no active turn
- no running latest turn
- session is `null`, `idle`, or `ready`

If the thread is active, starting, running, interrupted, stopped, or erroring in a way that makes dispatch unsafe, return a conflict error. Do not queue.

### `update_thread_settings`

Updates an existing thread's settings using existing orchestration commands:

- provider instance/model/options
- runtime/access mode
- interaction mode
- checkout mode
- branch/ref
- worktree path

The target thread must be idle/ready. Model/provider changes are prevalidated against provider availability, MCP model enablement, option descriptors, provider `requiresNewThreadForModelChange`, and current provider session compatibility. Runtime/access and interaction mode changes also require idle/ready state.

## Validation Rules

Model selection validation:

- provider instance must exist and be enabled/usable
- model must exist in the provider snapshot
- model must be MCP-enabled
- option ids must exist on the model's `optionDescriptors`
- select option values must be one of the descriptor's choices
- boolean option values must be boolean

Thread write validation:

- project/thread ids must exist and not be deleted
- archive behavior follows the individual tool contract
- parent links must be same-project
- write tools require idle/ready target state
- model/provider/session transitions must match existing provider reactor invariants
- new-worktree first sends require a base branch/ref

## UI Behavior

### Provider Model Toggle

Add an icon toggle beside the existing model row actions in Providers settings. The toggle controls whether MCP tools may use that model. It is enabled by default for every built-in and custom model.

Suggested labels:

- enabled tooltip/aria-label: "Allow MCP tools to use this model"
- disabled tooltip/aria-label: "Block MCP tools from using this model"

The UI writes disabled slugs to `mcpDisabledModelsByProvider[instanceId]`.

### Sidebar Thread Tree

Render threads as a recursive tree within each project:

- top-level threads preserve existing project thread sort order
- children sort within each parent using the same thread sort setting
- parent rows with children get a chevron
- expanded/collapsed child state is client-local, like project expansion
- creating a child via MCP expands its ancestor path in connected clients
- routing to a descendant expands its ancestor path
- collapsed ancestors roll up the highest-priority descendant status dot for running, approval/input, and unread states

Manual collapse remains respected unless the descendant becomes the active route.

## Error Handling

MCP tool errors should be structured and stable. Expected categories include:

- unknown project
- unknown thread
- unknown provider instance
- unavailable provider
- unknown model
- MCP-disabled model
- invalid model option
- cross-project parent
- non-idle thread
- incompatible model/session switch
- missing base branch/ref for new worktree
- payload too large
- FTS unavailable or fallback used

Error messages should include the relevant project/thread/provider/model ids and a concise recovery hint where possible.

## Runtime And Concurrency

`create_thread(message)` and `send_thread_message` return after orchestration command acceptance. They include enough identifiers for polling:

- `threadId`
- `messageId`
- accepted command sequence
- shell/session status if available

Agents that need completion should call `list_threads` or `get_thread_history`. Long blocking MCP calls are avoided because coding turns may run for a long time and may require user approvals.

## Testing

Required coverage:

- contract schema tests for server settings, parent thread fields, and MCP tool input/output schemas
- server tests for MCP model enablement filtering and model/options validation
- server tests for project idempotency and path normalization
- server tests for thread placement and same-project parent validation
- server tests for idle/ready gating on `send_thread_message` and `update_thread_settings`
- server tests for create-thread with and without message, including new-worktree intent and bootstrap behavior
- summary/complete history tests, including payload-too-large handling
- migration/projection tests for `parent_thread_id`
- migration/projection tests for FTS indexing, delete/revert synchronization, archived filters, and fallback behavior
- web tests for provider toggle persistence
- web tests for nested sidebar rendering, expansion, active-route expansion, and descendant status roll-up

Before the implementation is considered complete, run:

```sh
vp check
vp run typecheck
```

Use `vp test` for targeted Vite+ tests as implementation risk requires.
