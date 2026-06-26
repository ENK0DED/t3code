# T3Code MCP Orchestration Tools Design

Date: 2026-06-25
Last updated: 2026-06-26
Status: Approved detailed contract design, awaiting implementation plan

## Context

T3 Code already exposes a provider-scoped integrated MCP server for preview automation. The current MCP credential is scoped to the issuing environment/thread/provider instance and grants the `preview` capability. The requested feature expands this server into an orchestration surface so a running agent can discover models, inspect projects and threads, create threads, delegate work, send messages, configure project Actions, and adjust thread/project settings while the T3 UI visualizes the resulting state.

The implementation should preserve the existing orchestration/event/projection architecture. MCP handlers should be thin wrappers around shared server services so validation, dispatch, search, and settings behavior can be tested independently and reused by future non-MCP server entry points.

This design intentionally treats the MCP surface as a product contract for agents, not as a direct mirror of internal projection types. Several existing projection objects contain more data than agents should receive ambiently, especially project Actions/scripts with hidden shell commands and repository identity data that may include remote URLs. The MCP tools therefore expose smaller, purpose-specific response shapes.

## Goals

- Add MCP tools for model discovery, project/thread discovery, project details/settings, project Action CRUD, thread history, thread settings, project creation, thread creation, message sending, and thread/project settings updates.
- Add server-side model MCP enablement, defaulting every available built-in and custom model to enabled.
- Add a real parent/child thread relationship and sidebar visualization for sub-threads.
- Limit thread nesting to one child level: project -> top-level thread -> sub-thread.
- Add fast full-history thread search with SQLite FTS5.
- Reuse existing orchestration commands and UI-equivalent bootstrap flows wherever possible.
- Keep write tools predictable: validate up front, reject archived/deleted/active targets, and return after command acceptance rather than waiting for model completion.
- Keep read tools resilient: stale saved model selections should not break settings reads.
- Keep tool schemas agent-readable and provider-safe by using explicit object-shaped parameter schemas for every orchestration MCP tool.

## Non-Goals

- No concurrent message queueing into running threads. Write tools must error unless the target thread is idle/ready.
- No destructive MCP tools for deleting projects or threads in this pass.
- No archive/unarchive MCP lifecycle tools in this pass.
- No project Action execution tool in this pass.
- No project Action command leakage through read/list/mutation responses.
- No project Action keybinding management in this pass.
- No sidebar project grouping settings in project settings. Grouping is a UI/user settings concern, not project metadata.
- No per-provider or per-tool policy UI beyond model MCP enablement in this first pass.
- No physical worktree creation for empty new-worktree threads until the first message is sent.
- No internal domain rename from `ProjectScript` to `ProjectAction` in this pass. The MCP interface uses the user-facing word "Action"; internal contracts can continue using `ProjectScript`.

## Contract Principles

### Reads May Default To Current Context

Read-oriented tools may omit an id and resolve from the current MCP credential context:

- `get_thread_settings({})` resolves the credential thread.
- `get_project_details({})` resolves the credential thread's project.
- `get_project_settings({})` resolves the credential thread's project.
- `list_project_actions({})` resolves the credential thread's project.

Every response from a defaulting read tool must include the resolved `threadId` or `projectId`.

### Writes Require Explicit Targets

Write tools require explicit ids:

- `update_thread_settings` requires `threadId`.
- `update_project_settings` requires `projectId`.
- `create_project_action`, `update_project_action`, and `delete_project_action` require `projectId`.
- `update_project_action` and `delete_project_action` require `actionId`.

This keeps mutating tool calls visibly targeted in the transcript.

### Explicit Object Schemas Everywhere

Every orchestration MCP tool uses an explicit object parameter schema, including tools with no logical inputs. For example:

```ts
list_mcp_models({});
get_thread_settings({});
```

The schema should be `Schema.Struct({})` or a struct with optional fields, not a no-parameter/empty-params sentinel. This keeps the generated JSON Schema rooted at `type: "object"` and avoids provider-specific failures like a tool schema serializing as `type: None`.

### List Tools Are For Selection

List tools should return enough information for an agent to choose the right item, but should not become full settings/detail dumps.

- `list_projects` is a lightweight project selector.
- `list_threads` is a thread selector plus operational status list.
- `list_project_actions` is an Action metadata list, with commands intentionally hidden.

Detailed inspection uses dedicated get tools.

### Settings Tools Contain Mutable Settings

Settings read tools should correspond to fields that can be changed by the matching update tool, plus resolved display helpers where useful.

- `get_project_settings` returns mutable project settings: title and default model.
- `update_project_settings` updates only title and default model.
- `get_thread_settings` returns thread settings plus thread bookkeeping/status because there is no separate thread details tool.
- `update_thread_settings` updates title/model/runtime/interaction/checkout metadata.

### Reads Are Tolerant, Writes Are Strict

Settings reads should tolerate stale provider/model configuration. They return the raw saved model selection and a null resolved model with a warning. Writes validate strictly against current MCP-enabled models and option descriptors.

### Archived Is Read-Only, Deleted Is Inaccessible

Archived threads are readable but not writable. Deleted projects/threads are outside the normal MCP read surface. If a write path can distinguish a deleted/archived state from a missing record, it should return a state-specific error.

## Architecture

Add an orchestration MCP toolkit beside the existing preview toolkit. Toolkit handlers delegate to a shared server-side module named `McpOrchestrationService` that owns:

- MCP capability checks.
- Provider/model discovery and MCP model enablement filtering.
- Project and thread list/search queries.
- Project details/settings extraction.
- Project Action list and CRUD operations.
- Thread settings extraction and validation.
- Thread creation, first-turn bootstrap, and message dispatch.
- Thread/project settings update dispatch.
- Thread history complete/summary responses.

The MCP HTTP layer continues to authenticate every request with the provider-scoped bearer credential. Expand the credential capability set from only `preview` to:

- `preview`
- `orchestration.read`
- `orchestration.write`

Read tools require `orchestration.read`. Write tools require `orchestration.write`. The credential remains bound to the issuing environment and current thread so tools can safely default read targets to the current thread/project.

## Data Model

### MCP Model Enablement

Add a server setting:

```ts
mcpDisabledModelsByProvider: Record<ProviderInstanceId, string[]>;
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

Thread nesting is intentionally shallow. The maximum thread depth is 1:

- top-level thread: `parentThreadId: null`
- sub-thread: `parentThreadId` points to a top-level thread

Creating a child below a sub-thread is rejected by orchestration command invariants and by MCP write validation.

Add shared helpers in `@t3tools/shared/threadTree`:

```ts
MAX_THREAD_TREE_DEPTH = 1;
getThreadTreeDepth(thread);
canThreadCreateChild(thread);
```

These helpers are used by MCP responses, server invariants, and UI tree rendering so the depth rule is described once.

### Project Actions

The UI calls these "Actions". The existing internal contract calls them `ProjectScript`. Keep the internal type name for this pass.

Project Actions remain stored as `scripts` on the project projection and updated through the existing `project.meta.update` command. MCP must not expose raw `ProjectScript` objects through list/read responses because they contain `command`.

Move or add shared Action helper behavior to `@t3tools/shared/projectScripts` so UI and MCP use the same construction and list invariants:

```ts
DEFAULT_PROJECT_SCRIPT_ICON = "play"

nextProjectScriptId(name, existingIds)

createProjectScript({
  name,
  command,
  existingIds,
  icon?,
  runOnWorktreeCreate?,
  previewUrl?,
  autoOpenPreview?
}) => ProjectScript

upsertProjectScript(scripts, script) =>
  | { action: "created"; scripts; script }
  | { action: "updated"; scripts; previousScript; script }

removeProjectScript(scripts, scriptId) =>
  | { removed: true; scripts; script }
  | { removed: false; scripts }
```

The single-action constructor owns defaults:

- `icon` defaults to `"play"`.
- `runOnWorktreeCreate` defaults to `false`.
- `previewUrl` is omitted when null/empty.
- `autoOpenPreview` is only allowed/effective when a preview URL is present.

The list helper owns the list-level invariant:

- at most one Action in a project may have `runOnWorktreeCreate: true`
- if an upserted Action has `runOnWorktreeCreate: true`, all other Actions are rewritten to `false`
- stored order is preserved
- created Actions append to the end
- updated Actions keep their position
- removed Actions close the gap without sorting

### Thread Search Index

Add a SQLite FTS5 virtual table for `projection_thread_messages.text`. Keep it synchronized from projection message upserts, deletes, and checkpoint/revert retention paths. Search joins FTS hits back to `projection_threads` so archived/deleted filters are enforced by thread metadata.

If FTS5 is unavailable, the service may fall back to a bounded `LIKE`/scan and include a warning field in the result. It must not silently run an unbounded slow scan.

## MCP Tool Catalog

### `list_mcp_models`

Input:

```text
{}
```

Returns provider instances keyed by provider instance id. Only MCP-enabled models are included.

Each provider entry includes:

- `instanceId`
- `driver`
- `name`
- `models`, keyed by model slug

Each model entry includes:

- `slug`
- `name`
- `isCustom`
- `optionDescriptors` from model capabilities

Keep this output complete rather than making it a lightweight selector. Agents need option descriptors to construct valid `modelSelection` writes.

Provider instance id is the canonical key because thread/project model selections store `instanceId`.

### `list_projects`

Input:

```text
{
  search?: string
}
```

Returns active, non-deleted projects as lightweight selector rows:

```text
{
  projects: [
    {
      id,
      title,
      workspaceRoot
    }
  ]
}
```

Search uses the shared fuzzy ranking helpers to match title and workspace path. If `search` is omitted, return all active projects.

Do not include:

- project Actions/scripts
- Action commands
- `defaultModelSelection`
- timestamps
- raw `repositoryIdentity`
- repository remote URLs

Rationale: `list_projects` should help an agent choose a project without making unrelated settings, repository locator data, or Action commands ambiently visible.

### `get_project_details`

Input:

```text
{
  projectId?: ProjectId
}
```

Omit `projectId` to use the current MCP credential thread's project.

Returns read-only/descriptive project details:

```text
{
  projectId,
  title,
  workspaceRoot,
  createdAt,
  updatedAt,
  repositorySummary: null | {
    displayName?: string,
    provider?: string,
    owner?: string,
    name?: string
  }
}
```

Do not include:

- raw `repositoryIdentity`
- `canonicalKey`
- raw `locator`
- remote name
- remote URL
- Action/scripts
- `defaultModelSelection`

Rationale: details are for identification, bookkeeping, and safe repository display. Settings live in `get_project_settings`.

### `get_project_settings`

Input:

```text
{
  projectId?: ProjectId
}
```

Omit `projectId` to use the current MCP credential thread's project.

Returns mutable project settings and resolved display metadata:

```text
{
  projectId,
  title,
  defaultModelSelection: null | ModelSelection,
  resolvedDefaultModel: null | {
    provider: {
      instanceId,
      driver,
      name
    },
    model: {
      slug,
      name
    },
    options: [
      {
        id,
        value,
        label,
        valueLabel?
      }
    ]
  },
  defaultModelResolutionWarning?: string
}
```

`resolvedDefaultModel` is null when `defaultModelSelection` is null. It is also null when a stale saved selection cannot be resolved. In the stale case, include `defaultModelResolutionWarning` and still return the raw `defaultModelSelection`.

Do not include `workspaceRoot`; MCP treats it as read-only for now.

### `update_project_settings`

Input:

```text
{
  projectId: ProjectId,
  title?: string,
  defaultModelSelection?: null | ModelSelection
}
```

Semantics:

- `title` is trimmed/non-empty.
- omitted `defaultModelSelection` leaves the default unchanged.
- `defaultModelSelection: null` clears the project default model.
- non-null `defaultModelSelection` must reference an MCP-enabled provider/model/options combination from `list_mcp_models`.
- reject the call if neither `title` nor `defaultModelSelection` is provided.
- reject deleted projects with a state-specific error.
- allow updates when the project only has archived threads; archived threads do not freeze project metadata.

Do not include `workspaceRoot`, project grouping, or Actions/scripts in this tool.

### `list_threads`

Input:

```text
{
  projectId: ProjectId,
  search?: string,
  archived?: "exclude" | "include" | "only"
}
```

`archived` defaults to `"exclude"`.

Returns selector/status rows for threads in the project:

```text
{
  threads: [
    {
      id,
      projectId,
      parentThreadId,
      title,
      branch,
      worktreePath,
      threadDepth,
      maxThreadDepth,
      canCreateChildThread,
      createdAt,
      updatedAt,
      archivedAt,
      latestUserMessageAt,
      latestTurn,
      session,
      hasPendingApprovals,
      hasPendingUserInput,
      hasActionableProposedPlan
    }
  ]
}
```

Do not include:

- `modelSelection`
- `runtimeMode`
- `interactionMode`

Those live in `get_thread_settings`.

Search combines fuzzy title matching with FTS message-history search. Results include compact hit metadata and snippets, not full message histories. If `search` is omitted, return all matching threads for the archive filter.

Rationale: thread lists need enough live status for agents to choose a thread or a valid parent without probing every thread, but full settings inspection should be explicit.

### `get_thread_settings`

Input:

```text
{
  threadId?: ThreadId
}
```

Omit `threadId` to use the current MCP credential thread.

This replaces `get_current_thread_settings`. Because orchestration MCP is unpublished, do not keep a separate `*_current_*` tool. The optional id is more learnable for agents and avoids duplicate surfaces.

Returns:

```text
{
  threadId,
  projectId,
  title,
  parentThreadId,
  createdAt,
  updatedAt,
  archivedAt,
  modelSelection: ModelSelection,
  resolvedModel: null | {
    provider: {
      instanceId,
      driver,
      name
    },
    model: {
      slug,
      name
    },
    options: [
      {
        id,
        value,
        label,
        valueLabel?
      }
    ]
  },
  modelResolutionWarning?: string,
  runtimeMode,
  interactionMode,
  checkoutMode: "current_checkout" | "new_worktree",
  branch,
  worktreePath,
  threadDepth,
  maxThreadDepth,
  canCreateChildThread,
  session
}
```

`modelSelection` is always non-null. If it is stale or cannot be resolved, return it raw, set `resolvedModel: null`, and include `modelResolutionWarning`.

Do not include project metadata beyond `projectId`. Project details/settings live in project tools.

Archived threads remain readable through this tool and include `archivedAt`.

### `get_thread_history`

Input:

```text
{
  threadId: ThreadId,
  mode: "summary" | "complete",
  limit?: number,
  cursor?: string,
  maxCharacters?: number
}
```

Returns one thread's history in either summarized or complete form.

Summary mode uses the configured server "Text generation model" and a dedicated prompt for thread summarization. It should allow substantially more output than git commit message generation.

Complete mode returns the projected thread detail shape used by the UI: messages, attachment metadata, proposed plans, activities, checkpoints, session, settings, and thread attributes. It returns the full thread by default. If the payload would exceed a central server constant such as `MCP_STRUCTURED_RESPONSE_MAX_BYTES`, it fails with a clear "too large" error instructing the caller to retry with pagination or `maxCharacters`. The implementation should start with a conservative budget and cover it in tests. It must not silently truncate.

Archived threads remain readable through this tool. Deleted threads remain inaccessible.

### `list_project_actions`

Input:

```text
{
  projectId?: ProjectId
}
```

Omit `projectId` to use the current MCP credential thread's project.

Returns sanitized Action metadata in stored order:

```text
{
  projectId,
  actions: [
    {
      id,
      name,
      icon,
      runOnWorktreeCreate,
      previewUrl?,
      autoOpenPreview?
    }
  ]
}
```

The tool description must explicitly state that project Actions are called "Actions" in the UI and that command strings are intentionally not returned.

Never return:

- `command`
- keybindings

Rationale: the command string is executable shell content. Even if this is not a complete security boundary when an agent has other shell tools, MCP should not make Action commands ambiently discoverable or easy to execute outside future Action execution semantics.

### `create_project_action`

Input:

```text
{
  projectId: ProjectId,
  name: string,
  command: string,
  icon?: "play" | "test" | "lint" | "configure" | "build" | "debug",
  runOnWorktreeCreate?: boolean,
  previewUrl?: string,
  autoOpenPreview?: boolean
}
```

Semantics:

- `projectId` is required.
- `name` is trimmed/non-empty.
- `command` is trimmed/non-empty and may be multi-line.
- `command` is required on create.
- `icon` defaults to `"play"` through shared domain helper logic.
- `runOnWorktreeCreate` defaults to `false`.
- Action id is generated by the service with the same `nextProjectScriptId(name, existingIds)` logic used by the UI.
- Action names do not need to be unique; ids are unique.
- created Actions append to the end of the stored list.
- if `runOnWorktreeCreate: true`, all other Actions in the project are rewritten to `false`.
- reject `autoOpenPreview: true` when `previewUrl` is omitted.
- `previewUrl` is accepted as any trimmed/non-empty string; do not add URL validation unless the shared contract/UI also adopt it.
- reject deleted projects with a state-specific error.

Returns:

```text
{
  createdAction,
  actionsAfterChange
}
```

Both `createdAction` and `actionsAfterChange` are sanitized Action objects and never include `command`.

### `update_project_action`

Input:

```text
{
  projectId: ProjectId,
  actionId: string,
  name?: string,
  command?: string,
  icon?: "play" | "test" | "lint" | "configure" | "build" | "debug",
  runOnWorktreeCreate?: boolean,
  previewUrl?: string | null,
  autoOpenPreview?: boolean
}
```

Semantics:

- `projectId` and `actionId` are required.
- reject missing `actionId` with `project_action_not_found`.
- reject empty updates where no editable field is provided.
- omitted fields preserve existing values.
- `command`, when provided, fully replaces the existing command.
- the old command is preserved internally when `command` is omitted, but is never returned.
- `name` and `command` are trimmed/non-empty when provided.
- if `runOnWorktreeCreate: true`, all other Actions in the project are rewritten to `false`.
- if `previewUrl` is omitted, preserve existing preview URL.
- if `previewUrl: null`, clear `previewUrl` and force `autoOpenPreview` off.
- if `previewUrl` is non-null, set it as a trimmed/non-empty string without URL validation.
- `autoOpenPreview: true` is valid only if the resulting Action has a preview URL.
- validate preview/auto-open against the resulting Action state, not only the raw input.
- preserve stored position.
- reject deleted projects with a state-specific error.

Returns:

```text
{
  updatedAction,
  actionsAfterChange
}
```

Do not return `previousAction`; callers that need before/after visible metadata can call `list_project_actions` before updating.

### `delete_project_action`

Input:

```text
{
  projectId: ProjectId,
  actionId: string
}
```

Semantics:

- `projectId` and `actionId` are required.
- reject missing `actionId` with `project_action_not_found`.
- delete closes the stored-list gap without sorting other Actions.
- reject deleted projects with a state-specific error.

Returns:

```text
{
  deletedAction,
  actionsAfterChange
}
```

`deletedAction` is sanitized and does not include `command`.

### `add_project`

Input:

```text
{
  path: string
}
```

Adds a project by source directory path. It should reuse the same normalization, title inference, create-directory behavior, and duplicate detection semantics as the current Add Project flow.

If the normalized path already belongs to an active project, return the existing project with `status: "already_exists"` and do not create a duplicate. Otherwise dispatch `project.create` and return `status: "created"`.

### `create_thread`

Input:

```text
{
  projectId?: ProjectId,
  placement?: "top_level" | "child_of_thread",
  parentThreadId?: ThreadId,
  title?: string,
  message?: string,
  modelSelection?: ModelSelection,
  runtimeMode?: RuntimeMode,
  interactionMode?: ProviderInteractionMode,
  checkoutMode?: "current_checkout" | "new_worktree",
  branch?: string,
  baseBranch?: string
}
```

Defaults:

- `projectId`: current MCP credential thread's project.
- `placement`: `top_level`.
- `runtimeMode`: current MCP credential thread's runtime mode unless a better project-level default is added later.
- `interactionMode`: current MCP credential thread's interaction mode unless a better project-level default is added later.
- `checkoutMode`: omitted means current checkout/default behavior.

Model resolution:

1. explicit `modelSelection` from the tool input
2. target project `defaultModelSelection`, if non-null
3. current MCP credential thread `modelSelection`
4. app/server default model selection

The final resolved model selection must be non-null and MCP-enabled.

Placement:

- `top_level` creates a top-level thread.
- `child_of_thread` requires `parentThreadId`.
- parent must exist, be active, be in the target project, be top-level, and not be archived.
- child below child is rejected because max thread depth is 1.
- the schema does not expose implicit `child_of_current`.

Checkout/worktree input:

- `worktreePath` is not accepted on `create_thread`.
- `branch` is optional and string-only; omit it to let worktree creation derive a branch.
- `branch: null` is not accepted on create.
- `baseBranch` is only valid when a first message will prepare a new worktree.
- `branch` or `baseBranch` without `checkoutMode: "new_worktree"` is rejected.
- do not infer `checkoutMode` from branch/baseBranch.
- `checkoutMode: "current_checkout"` is allowed explicitly.

No-message behavior:

- creates an empty persisted thread.
- `checkoutMode: "new_worktree"` may record new-worktree intent/branch metadata.
- no physical worktree is created.
- `baseBranch` is rejected because there is nowhere durable to store it.

Message behavior:

- if `message` is supplied, the tool uses the existing first-turn bootstrap path.
- `checkoutMode: "new_worktree"` plus `message` requires `baseBranch`.
- thread creation, optional worktree preparation, setup Action execution, and `thread.turn.start` are handled atomically by the server bootstrap flow.
- the tool returns after the turn is accepted, not after provider completion.

### `send_thread_message`

Input:

```text
{
  threadId: ThreadId,
  message: string,
  modelSelection?: ModelSelection,
  checkoutMode?: "current_checkout" | "new_worktree",
  branch?: string,
  baseBranch?: string
}
```

Semantics:

- `threadId` is required.
- target thread must exist, be active, not archived, not deleted, and idle/ready.
- `modelSelection`, when provided, is a persistent thread setting change before the turn, not a one-off override.
- requested model selection must be MCP-enabled.
- no `runtimeMode` or `interactionMode` overrides in this tool; use `update_thread_settings`.

Checkout/worktree bootstrap:

- only allowed for an empty thread (`messages.length === 0`) with no existing `worktreePath`.
- `checkoutMode: "new_worktree"` follows the same UI first-message path: `bootstrap.prepareWorktree`, setup Action execution, and persisted worktree metadata through the bootstrap flow.
- `checkoutMode: "new_worktree"` on first-turn bootstrap requires `baseBranch`.
- `branch` is optional and string-only.
- `branch: null` is not accepted on send.
- `baseBranch` without `checkoutMode: "new_worktree"` is rejected.
- `branch` without `checkoutMode: "new_worktree"` is rejected.
- no checkout inference from `branch` or `baseBranch`.
- checkout bootstrap fields on non-empty threads or threads with an existing `worktreePath` are rejected with a message telling the agent to use `update_thread_settings` for explicit metadata repair.

Idle/ready requirement:

- no active turn
- no running latest turn
- session is `null`, `idle`, or `ready`

If the thread is active, starting, running, interrupted, stopped, or erroring in a way that makes dispatch unsafe, return a conflict error. Do not queue.

### `update_thread_settings`

Input:

```text
{
  threadId: ThreadId,
  title?: string,
  modelSelection?: ModelSelection,
  runtimeMode?: RuntimeMode,
  interactionMode?: ProviderInteractionMode,
  checkoutMode?: "current_checkout" | "new_worktree",
  branch?: string | null,
  worktreePath?: string | null
}
```

Semantics:

- `threadId` is required.
- reject empty updates where no editable field is provided.
- target thread must exist, be active, not archived, not deleted, and idle/ready.
- archived threads are read-only; even rename is rejected.
- `title` is trimmed/non-empty.
- `modelSelection`, when provided, must be non-null and MCP-enabled.
- thread model cannot be cleared to null.
- this tool does not accept `baseBranch` and never prepares a physical worktree.
- `worktreePath` is advanced metadata repair, not normal worktree creation.

Checkout metadata rules:

- `checkoutMode: "current_checkout"` clears `branch` and `worktreePath`.
- `checkoutMode: "current_checkout"` plus non-null `branch` is rejected.
- `checkoutMode: "current_checkout"` plus `branch: null` is allowed as redundant clear.
- `checkoutMode: "current_checkout"` plus non-null `worktreePath` is rejected.
- `checkoutMode: "current_checkout"` plus `worktreePath: null` is allowed as redundant clear.
- `checkoutMode: "new_worktree"` may preserve existing compatible branch/worktree metadata unless explicitly changed.
- empty/no-message thread may switch to `new_worktree` without a concrete `worktreePath`; the first turn can prepare one later.
- non-empty thread switching to `new_worktree` requires an existing or provided `worktreePath`.
- `branch` may be changed on a non-empty new-worktree thread as metadata repair.
- `worktreePath: null` clears the path only when the resulting checkout state is valid.

Physical worktree creation is owned by first-turn bootstrap through `create_thread(message)` or eligible `send_thread_message` calls.

## Validation Rules

### Model Selection

All MCP-entered model selections must validate against MCP-enabled providers/models:

- `create_thread.modelSelection`
- resolved target project default used by `create_thread`
- `send_thread_message.modelSelection`
- `update_thread_settings.modelSelection`
- `update_project_settings.defaultModelSelection` when non-null

Validation rules:

- provider instance must exist and be enabled/usable
- provider instance must be installed when installation state is tracked
- model must exist in the provider snapshot
- model must be MCP-enabled
- option ids must exist on the model's `optionDescriptors`
- select option values must be one of the descriptor's choices
- boolean option values must be boolean

Thread model selections are always non-null. Project default model selection may be null to clear the default.

### Project State

Active project:

- readable
- writable
- Actions CRUD allowed

Deleted project:

- inaccessible for normal reads
- write paths that can detect deleted state return `project_deleted`

Suggested message:

```text
Tool did not execute because project '<projectId>' is deleted.
```

Archived threads inside an active project do not block project settings or project Action writes.

### Thread State

Active thread:

- readable
- writable when idle/ready

Archived thread:

- readable through `list_threads`, `get_thread_settings`, and `get_thread_history`
- not writable
- cannot receive messages
- cannot be renamed
- cannot be used as a child-thread parent

Deleted thread:

- inaccessible for normal reads
- write paths that can detect deleted state return `thread_deleted`

Suggested errors:

```text
thread_archived: Tool did not execute because thread '<threadId>' is archived.
thread_deleted: Tool did not execute because thread '<threadId>' is deleted.
parent_thread_archived: Tool did not execute because parent thread '<threadId>' is archived.
```

Future lifecycle tools may explicitly archive/unarchive threads. Until those exist, archived threads are read-only for MCP.

### Thread Write State

Write tools require idle/ready target state:

- no active turn
- no running latest turn
- session is `null`, `idle`, or `ready`

This applies to:

- `send_thread_message`
- `update_thread_settings`
- any future non-read thread mutation

### Parent/Child Threads

Parent validation:

- parent thread id must exist
- parent must be in the target project
- parent must not be archived
- parent must not be deleted
- parent must be top-level (`parentThreadId: null`)
- max thread depth is 1

Creating a top-level thread in a project that only has archived threads is allowed.

### Empty Updates

Reject no-op mutation inputs before dispatch:

- `update_project_settings` with neither `title` nor `defaultModelSelection`
- `update_thread_settings` with no editable fields
- `update_project_action` with no editable fields

Use clear errors such as:

```text
project_settings_empty_update: Provide at least one project setting to update.
thread_settings_empty_update: Provide at least one thread setting to update.
project_action_empty_update: Provide at least one project Action field to update.
```

### Project Actions

Action read/list responses are sanitized and must never include `command`.

Action command validation:

- required on create
- optional full replacement on update
- trimmed/non-empty when provided
- may be multi-line
- never returned

Action name validation:

- trimmed/non-empty
- no MCP-only single-line rule
- duplicate names are allowed

Preview validation:

- create rejects `autoOpenPreview: true` when `previewUrl` is omitted
- update validates against resulting Action state
- `previewUrl: null` clears URL and disables auto-open
- non-null preview URL is trimmed/non-empty, not URL-validated

Missing action errors:

```text
project_action_not_found: Project Action '<actionId>' was not found in project '<projectId>'.
```

## UI Behavior

### Provider Model Toggle

Add an icon toggle beside the existing model row actions in Providers settings. The toggle controls whether MCP tools may use that model. It is enabled by default for every built-in and custom model.

Suggested labels:

- enabled tooltip/aria-label: "Allow MCP tools to use this model"
- disabled tooltip/aria-label: "Block MCP tools from using this model"

The UI writes disabled slugs to `mcpDisabledModelsByProvider[instanceId]`.

### Sidebar Thread Tree

Render threads as a tree within each project:

- top-level threads preserve existing project thread sort order
- children sort within each parent using the same thread sort setting
- max depth is 1, so a sub-thread never has children
- parent rows with children get a chevron
- expanded/collapsed child state is client-local, like project expansion
- creating a child via MCP expands its ancestor path in connected clients
- routing to a descendant expands its ancestor path
- collapsed ancestors roll up the highest-priority descendant status dot for running, approval/input, and unread states

Manual collapse remains respected unless the descendant becomes the active route.

### Project Actions

The visible UI term is "Action":

- Add action
- Edit Action
- Save action
- Delete action
- Run automatically on worktree creation

MCP descriptions should use "project Action" and may mention "called Actions in the UI". Internal implementation may continue to use `ProjectScript`.

The UI should adopt the shared project script helpers while this work is in flight:

- Action id generation should come from shared `nextProjectScriptId`.
- new Action construction should use shared defaults.
- list mutation should use shared upsert/remove helpers.
- UI keybinding behavior remains UI/local desktop behavior and is not part of MCP.

## Error Handling

MCP tool errors should be structured and stable. Expected categories include:

- unknown project
- project deleted
- unknown thread
- thread archived
- thread deleted
- parent thread archived
- unknown provider instance
- unavailable provider
- unknown model
- MCP-disabled model
- invalid model option
- cross-project parent
- thread depth exceeded
- non-idle thread
- incompatible model/session switch
- invalid checkout field combination
- missing base branch/ref for first-turn new-worktree bootstrap
- base branch supplied outside first-turn new-worktree bootstrap
- branch supplied without explicit new-worktree checkout intent
- project Action not found
- project Action empty update
- project Action invalid preview auto-open
- payload too large
- FTS unavailable or fallback used

Error messages should include the relevant project/thread/provider/model/action ids and a concise recovery hint where possible.

Important state-specific messages:

```text
Tool did not execute because project '<projectId>' is deleted.
Tool did not execute because thread '<threadId>' is archived.
Tool did not execute because thread '<threadId>' is deleted.
Tool did not execute because parent thread '<threadId>' is archived.
```

## Runtime And Concurrency

`create_thread(message)` and `send_thread_message` return after orchestration command acceptance. They include enough identifiers for polling:

- `threadId`
- `messageId`
- accepted command sequence
- shell/session status if available

Agents that need completion should call `list_threads` or `get_thread_history`. Long blocking MCP calls are avoided because coding turns may run for a long time and may require user approvals.

## Future Work

### Thread Lifecycle Tools

Add dedicated lifecycle tools after authorization/approval design is clear:

- `archive_thread`
- `unarchive_thread`

Potentially add delete/remove later, but only after the authorization system can distinguish safe user intent from accidental/destructive agent behavior.

### Project Lifecycle Tools

Project delete/remove already exists in lower-level orchestration/CLI code, but MCP should not expose it yet. Future project lifecycle state should block all project writes except explicit lifecycle restore/delete tools.

### Project Action Execution

Do not add `run_project_action` now. Running Actions crosses into terminal/process execution and needs a separate design for:

- target thread/worktree
- current working directory
- environment variables
- terminal ownership
- output capture
- preview behavior
- user approval/authorization
- how to prevent bypassing Action semantics through other tools

### Project Action Keybindings

Do not include keybindings in MCP Action CRUD now. UI keybindings are persisted through local desktop APIs, not orchestration events, and are a user-local settings concern.

### UI/User Settings Tooling

Sidebar project grouping is stored as UI/user settings, not project metadata. If MCP needs to manage that later, add a separate settings-oriented tool rather than expanding `update_project_settings`.

## Testing

Required coverage:

- contract schema tests for server settings, parent thread fields, and MCP tool input/output schemas
- schema tests that every orchestration MCP tool has top-level object parameters, including no-input tools
- schema tests that orchestration tools do not expose `child_of_current`
- schema tests that project Action read/list/mutation responses do not include `command`
- server tests for MCP model enablement filtering and model/options validation
- server tests for tolerant settings reads with stale model selections
- server tests for project idempotency and path normalization
- server tests for lightweight `list_projects`
- server tests for `get_project_details` repository summary sanitization
- server tests for `get_project_settings` and `update_project_settings`
- server tests for project Action list/create/update/delete sanitization and invariants
- shared helper tests for project Action id generation, construction defaults, upsert, setup-action uniqueness, and remove results
- server tests for thread placement, same-project parent validation, archived parent rejection, and max-depth rejection
- server tests for `list_threads` excluding settings fields and including depth/status fields
- server tests for `get_thread_settings`, including title, created/updated/archive timestamps, depth metadata, and resolved model metadata
- server tests for archived thread read behavior
- server tests for archived/deleted thread write rejection
- server tests for idle/ready gating on `send_thread_message` and `update_thread_settings`
- server tests for create-thread model resolution using target project default before current thread fallback
- server tests for create-thread with and without message, including new-worktree intent and bootstrap behavior
- server tests for first-message `send_thread_message` new-worktree bootstrap behavior
- server tests for strict checkout/baseBranch/branch validation combinations
- summary/complete history tests, including archived read behavior and payload-too-large handling
- migration/projection tests for `parent_thread_id`
- migration/projection tests for FTS indexing, delete/revert synchronization, archived filters, and fallback behavior
- web tests for provider toggle persistence
- web tests for shared project Action helper adoption
- web tests for nested sidebar rendering, expansion, active-route expansion, and descendant status roll-up

Before the implementation is considered complete, run:

```sh
vp check
vp run typecheck
```

Use `vp test` for targeted Vite+ tests as implementation risk requires.
