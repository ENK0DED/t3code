import {
  NonNegativeInt,
  PositiveInt,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectScriptIcon,
  ProviderInstanceId,
  ProviderOptionSelections,
  ProviderInteractionMode,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  McpOrchestrationError,
  McpOrchestrationService,
} from "../../Services/McpOrchestrationService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, McpOrchestrationService];
const EmptyObjectInput = Schema.Record(Schema.String, Schema.Never).annotate({
  description: "No parameters.",
});

const ProjectIdInput = Schema.String.annotate({
  description: "Project id returned by list_projects.",
})
  .check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .pipe(Schema.brand("ProjectId"));

const optionalInput = <S extends Schema.Top>(schema: S, description: string) =>
  Schema.optionalKey(schema.annotate({ description })).annotate({ description });

const OptionalProviderOptionSelectionsInput = optionalInput(
  ProviderOptionSelections,
  "Model option selections for the selected provider model.",
);

const McpModelSelectionInput = Schema.Struct({
  instanceId: ProviderInstanceId.annotate({
    description: "Provider instance id returned by list_mcp_models.",
  }),
  model: TrimmedNonEmptyString.annotate({
    description: "Model slug returned under the selected provider instance by list_mcp_models.",
  }),
  options: OptionalProviderOptionSelectionsInput,
}).annotate({
  description:
    "Provider instance, model slug, and model option selections. Use list_mcp_models to discover MCP-enabled choices.",
});

const THREAD_MESSAGE_DESCRIPTION = `User message text. Leading/trailing whitespace is trimmed; empty messages are rejected. Maximum ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`;

const ThreadMessageInput = Schema.String.annotate({
  description: THREAD_MESSAGE_DESCRIPTION,
}).pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
    ).annotate({
      description: THREAD_MESSAGE_DESCRIPTION,
    }),
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

const OptionalProjectIdInput = optionalInput(
  ProjectIdInput,
  "Project id for the new thread. Omit to use the current MCP credential thread's project.",
);

const OptionalCurrentProjectIdInput = optionalInput(
  ProjectIdInput,
  "Project id. Omit to use the current MCP credential thread's project.",
);

const ProjectActionIconInput = ProjectScriptIcon.annotate({
  description: "Action icon. Use one of: play, test, lint, configure, build, or debug.",
});

const ThreadIdInput = Schema.String.annotate({
  description: "Thread id returned by list_threads or create_thread.",
})
  .check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .pipe(Schema.brand("ThreadId"));

const OptionalThreadIdInput = optionalInput(
  ThreadIdInput,
  "Thread id returned by list_threads or create_thread. Omit to use the current MCP credential thread.",
);

const OptionalListParentThreadIdInput = optionalInput(
  ThreadIdInput,
  "Parent thread id returned by list_threads or get_thread_settings. When provided, list_threads returns only direct child threads whose parentThreadId matches this value. Use the current thread id to enumerate sub-threads for cleanup or review.",
);

const OptionalParentThreadIdInput = optionalInput(
  ThreadIdInput,
  "Existing top-level thread id to use as the parent when placement is child_of_thread. Prefer the current thread, or another directly relevant top-level thread, for related follow-up work. The parent must be in the target project and must not already be a sub-thread. When parentThreadId is present and placement is omitted, placement is inferred as child_of_thread.",
);

const OptionalModelSelectionInput = optionalInput(
  McpModelSelectionInput,
  "Provider instance, model slug, and model option selections. Use list_mcp_models to discover MCP-enabled choices.",
);

const OptionalNullableModelSelectionInput = optionalInput(
  Schema.NullOr(
    McpModelSelectionInput.annotate({
      description:
        "Provider instance, model slug, and model option selections. Use null to clear the project's default model.",
    }),
  ),
  "Provider instance, model slug, and model option selections. Use list_mcp_models to discover MCP-enabled choices, or null to clear the project's default model.",
);

const OptionalTitleInput = optionalInput(
  Schema.String.annotate({
    description: "Human-readable project title.",
  }),
  "Human-readable project title.",
);

const OptionalRuntimeModeInput = optionalInput(
  RuntimeMode.annotate({
    description:
      "Runtime permission mode for the thread: approval-required, auto-accept-edits, or full-access.",
  }),
  "Runtime permission mode for the thread: approval-required, auto-accept-edits, or full-access.",
);

const CreateThreadRuntimeModeInput = optionalInput(
  RuntimeMode.annotate({
    description:
      "Runtime permission mode for the new thread: approval-required, auto-accept-edits, or full-access. Omitted default (this field only): auto-accept-edits (workspace-write sandbox — commands run sandboxed and escalations are gated). Pass an explicit value to override; full-access removes the sandbox.",
  }),
  "Runtime permission mode for the new thread: approval-required, auto-accept-edits, or full-access. Omitted default (this field only): auto-accept-edits (workspace-write sandbox — commands run sandboxed and escalations are gated). Pass an explicit value to override; full-access removes the sandbox.",
);

const OptionalInteractionModeInput = optionalInput(
  ProviderInteractionMode.annotate({
    description: "Provider interaction mode. Use plan for planning-only turns.",
  }),
  "Provider interaction mode. Use plan for planning-only turns.",
);

const OptionalCheckoutModeInput = optionalInput(
  Schema.Literals(["current_checkout", "new_worktree"]).annotate({
    description:
      "Checkout handling for the thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation.",
  }),
  "Checkout handling for the thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation.",
);

const CreateThreadCheckoutModeInput = optionalInput(
  Schema.Literals(["current_checkout", "new_worktree"]).annotate({
    description:
      "Checkout handling for the new thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation. Omitted default (this field only): top_level threads default to new_worktree (isolated checkout); child_of_thread threads inherit the parent thread's checkout. Pass an explicit value to override.",
  }),
  "Checkout handling for the new thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation. Omitted default (this field only): top_level threads default to new_worktree (isolated checkout); child_of_thread threads inherit the parent thread's checkout. Pass an explicit value to override.",
);

const OptionalBootstrapBranchInput = optionalInput(
  Schema.String.annotate({
    description:
      "Optional branch name for first-turn new_worktree bootstrap. Omit to let T3 Code derive a branch. Null is not accepted.",
  }),
  "Optional branch name for first-turn new_worktree bootstrap. Omit to let T3 Code derive a branch. Null is not accepted.",
);

const OptionalThreadMetadataBranchInput = optionalInput(
  Schema.NullOr(
    Schema.String.annotate({
      description: "Git branch name associated with a new_worktree checkout, or null to clear it.",
    }),
  ),
  "Git branch name associated with a new_worktree checkout, or null to clear it.",
);

const OptionalWorktreePathInput = optionalInput(
  Schema.NullOr(
    Schema.String.annotate({
      description:
        "Filesystem path for a new_worktree checkout, or null to clear it. Omit to inherit the current compatible checkout metadata.",
    }),
  ),
  "Filesystem path for a new_worktree checkout, or null to clear it. Omit to inherit the current compatible checkout metadata.",
);

const OptionalBaseBranchInput = optionalInput(
  Schema.String.annotate({
    description: "Base git branch used when preparing a new worktree during a first turn.",
  }),
  "Base git branch used when preparing a new worktree during a first turn.",
);

// --- Per-turn control options (default OFF; omitted = fire-and-forget) ---
// These three knobs are independent and COMPOSE; whichever condition fires first wins.
// CRITICAL distinction the agent must not confuse:
//   - waitForResponse timeout (timeoutMs) => STOP WAITING and return; the turn KEEPS RUNNING.
//   - turnTimeoutMs / responseTimeoutMs  => CANCEL (interrupt) the turn on breach.
const WAIT_FOR_RESPONSE_DESCRIPTION =
  'When true, block after dispatching the turn until it reaches a terminal state (completed/interrupted/error) or timeoutMs elapses, then return a `wait` object containing the terminal `state` and the verbatim final assistant answer inline (reasoning/tool calls excluded; maxCharacters-bounded with a `truncated` flag). On the timeoutMs deadline this STOPS WAITING and returns (state: "running", answer: null, timedOut: true) WITHOUT cancelling — the turn keeps running (use interrupt_thread_turn or turnTimeoutMs to cancel). error/interrupted/edits-only turns return their state with a null answer (use get_thread_diff for code changes). Default OFF (fire-and-forget; no `wait` object).';

const OptionalWaitForResponseInput = optionalInput(
  Schema.Boolean.annotate({ description: WAIT_FOR_RESPONSE_DESCRIPTION }),
  WAIT_FOR_RESPONSE_DESCRIPTION,
);

const WAIT_TIMEOUT_MS_DESCRIPTION =
  'Milliseconds to wait when waitForResponse is true before giving up. On expiry the call STOPS WAITING and returns (state: "running", answer: null, timedOut: true); the turn is NOT cancelled (distinct from turnTimeoutMs). Ignored unless waitForResponse is true. If omitted while waiting, falls back to turnTimeoutMs, then to a default ceiling so the call always returns.';

const OptionalWaitTimeoutMsInput = optionalInput(
  PositiveInt.annotate({ description: WAIT_TIMEOUT_MS_DESCRIPTION }),
  WAIT_TIMEOUT_MS_DESCRIPTION,
);

const TURN_TIMEOUT_MS_DESCRIPTION =
  "Total wall-clock budget (milliseconds) for the dispatched turn. On breach the turn is CANCELLED (interrupt dispatched) — never auto-approved — leaving a timed-out activity. Bounds total work; composes with responseTimeoutMs (whichever fires first cancels). This CANCELS, unlike a waitForResponse timeout which only stops waiting. Default OFF.";

const OptionalTurnTimeoutMsInput = optionalInput(
  PositiveInt.annotate({ description: TURN_TIMEOUT_MS_DESCRIPTION }),
  TURN_TIMEOUT_MS_DESCRIPTION,
);

const RESPONSE_TIMEOUT_MS_DESCRIPTION =
  "Maximum time (milliseconds) the turn may sit blocked on a pending approval/user-input request. On breach the turn is CANCELLED (interrupt dispatched) — NEVER auto-approved. Bounds an abandoned/blocked gate; composes with turnTimeoutMs (whichever fires first cancels). This CANCELS, unlike a waitForResponse timeout which only stops waiting. Default OFF.";

const OptionalResponseTimeoutMsInput = optionalInput(
  PositiveInt.annotate({ description: RESPONSE_TIMEOUT_MS_DESCRIPTION }),
  RESPONSE_TIMEOUT_MS_DESCRIPTION,
);

const WAIT_MAX_CHARACTERS_DESCRIPTION =
  "When waitForResponse is true, the maximum number of characters of the inline answer text returned in the `wait` object; longer answers are truncated with truncated: true (fetch the full text via get_thread_messages). Ignored unless waitForResponse is true.";

const OptionalWaitMaxCharactersInput = optionalInput(
  Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: WAIT_MAX_CHARACTERS_DESCRIPTION,
  }),
  WAIT_MAX_CHARACTERS_DESCRIPTION,
);

const readTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

const writeTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false) as T;

const destructiveTool = <T extends Tool.Any>(tool: T): T =>
  writeTool(tool).annotate(Tool.Destructive, true) as T;

export const ListMcpModelsTool = readTool(
  Tool.make("list_mcp_models", {
    description: "Return provider instances and MCP-enabled models available to MCP tools.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: EmptyObjectInput,
    dependencies,
  }),
);

export const ListProjectsTool = readTool(
  Tool.make("list_projects", {
    description: "Return T3Code projects, optionally fuzzy searched by title or path.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      search: optionalInput(
        Schema.String.annotate({
          description: "Optional fuzzy search text matched against project title and path.",
        }),
        "Optional fuzzy search text matched against project title and path.",
      ),
    }),
    dependencies,
  }),
);

export const ListThreadsTool = readTool(
  Tool.make("list_threads", {
    description:
      "Return threads for a project, optionally searched by title/message history or filtered to direct child threads with parentThreadId.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: ProjectIdInput,
      search: optionalInput(
        Schema.String.annotate({
          description:
            "Optional fuzzy search text matched against thread title and message history.",
        }),
        "Optional fuzzy search text matched against thread title and message history.",
      ),
      archived: optionalInput(
        Schema.Literals(["exclude", "include", "only"]).annotate({
          description:
            "Archive filter. Defaults to exclude; use include to search active and archived threads or only for archived threads.",
        }),
        "Archive filter. Defaults to exclude; use include to search active and archived threads or only for archived threads.",
      ),
      parentThreadId: OptionalListParentThreadIdInput,
    }),
    dependencies,
  }),
);

export const GetThreadMessagesTool = readTool(
  Tool.make("get_thread_messages", {
    description:
      "Read a thread's messages in one of five modes. summary: an LLM-distilled summary of the whole thread. complete: the full projected message history (pageable via limit/cursor). latest_response: the verbatim text of the last assistant message of the latest COMPLETED turn (reasoning/tool calls already excluded), plus that turn's id and state; if a turn is currently running it returns the previous completed answer with inProgress: true (or a null answer when nothing has completed yet). turn: the user message and assistant response of one turn identified by turnCount, plus that turn's state. message: a single message identified by messageId.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
      mode: Schema.Literals(["summary", "complete", "latest_response", "turn", "message"]).annotate(
        {
          description:
            "Message read mode. summary = a compact generated summary of the whole thread. complete = raw projected message history (use limit/cursor/maxCharacters). latest_response = the latest completed turn's final assistant message text verbatim, with the turn id/state and an inProgress flag. turn = one turn's user message + assistant response + state (requires turnCount). message = a single message (requires messageId).",
        },
      ),
      limit: optionalInput(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description: "Maximum number of messages to include when mode is complete.",
        }),
        "Maximum number of messages to include when mode is complete.",
      ),
      cursor: optionalInput(
        Schema.String.annotate({
          description:
            "Zero-based message offset cursor returned by the caller. Use with limit to page complete history.",
        }),
        "Zero-based message offset cursor returned by the caller. Use with limit to page complete history.",
      ),
      turnCount: optionalInput(
        NonNegativeInt.annotate({
          description:
            "Required when mode is turn: the checkpointTurnCount ordinal of the turn to read (reported by checkpoints and get_thread_diff). Returns that turn's user message and assistant response.",
        }),
        "Required when mode is turn: the checkpointTurnCount ordinal of the turn to read (reported by checkpoints and get_thread_diff). Returns that turn's user message and assistant response.",
      ),
      messageId: optionalInput(
        Schema.String.annotate({
          description:
            "Required when mode is message: the id of the single message to return (from list_threads, complete history, or another get_thread_messages response).",
        })
          .check(Schema.isTrimmed())
          .check(Schema.isNonEmpty())
          .pipe(Schema.brand("MessageId")),
        "Required when mode is message: the id of the single message to return (from list_threads, complete history, or another get_thread_messages response).",
      ),
      maxCharacters: optionalInput(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description:
            "Maximum serialized response size in bytes allowed for complete history before returning payload_too_large.",
        }),
        "Maximum serialized response size in bytes allowed for complete history before returning payload_too_large.",
      ),
    }),
    dependencies,
  }),
);

export const GetThreadDiffTool = readTool(
  Tool.make("get_thread_diff", {
    description:
      "Return the code changes an MCP-managed sub-thread produced, as a unified git diff plus a structured per-file summary (path, change kind, added/removed line counts) so you can triage what changed without parsing the patch. Omit BOTH fromTurnCount and toTurnCount to get the full diff from the thread's first checkpoint to its latest completed turn (resolved server-side) — the single-call way to collect everything a child changed. Provide a turn range for a narrower diff. Turn counts are the checkpointTurnCount ordinals reported by checkpoints and get_thread_messages (mode=turn). If the unified diff exceeds maxCharacters bytes, the response still returns the per-file summary with truncated: true and an empty diff (re-request a narrower range for the full patch).",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
      fromTurnCount: optionalInput(
        NonNegativeInt.annotate({
          description:
            "Start of the turn range (exclusive lower checkpoint), as a checkpointTurnCount. Use 0 for the initial baseline or an existing checkpoint count. Omit together with toTurnCount to diff the whole thread to its latest completed turn. If provided, toTurnCount must also be provided and be greater than fromTurnCount.",
        }),
        "Start of the turn range (exclusive lower checkpoint), as a checkpointTurnCount. Use 0 for the initial baseline or an existing checkpoint count. Omit together with toTurnCount to diff the whole thread to its latest completed turn. If provided, toTurnCount must also be provided and be greater than fromTurnCount.",
      ),
      toTurnCount: optionalInput(
        NonNegativeInt.annotate({
          description:
            "End of the turn range (inclusive upper checkpoint), as an existing checkpointTurnCount. Omit together with fromTurnCount to diff the whole thread to its latest completed turn. If provided, fromTurnCount must also be provided and be less than toTurnCount.",
        }),
        "End of the turn range (inclusive upper checkpoint), as an existing checkpointTurnCount. Omit together with fromTurnCount to diff the whole thread to its latest completed turn. If provided, fromTurnCount must also be provided and be less than toTurnCount.",
      ),
      ignoreWhitespace: optionalInput(
        Schema.Boolean.annotate({
          description:
            "Whether to ignore whitespace-only changes when computing the diff. Defaults to true.",
        }),
        "Whether to ignore whitespace-only changes when computing the diff. Defaults to true.",
      ),
      maxCharacters: optionalInput(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description:
            "Maximum serialized response size in bytes. When the unified diff would exceed it, the diff is omitted (returned empty) and the response is flagged truncated: true while keeping the per-file summary; payload_too_large is only returned if even that summary cannot fit.",
        }),
        "Maximum serialized response size in bytes allowed before returning payload_too_large. Use to bound a large diff; the per-file summary still tells you what changed when the patch is too big.",
      ),
    }),
    dependencies,
  }),
);

export const GetThreadSettingsTool = readTool(
  Tool.make("get_thread_settings", {
    description:
      "Return thread settings and resolved model details. Omit threadId to inspect the current MCP credential thread.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: OptionalThreadIdInput,
    }),
    dependencies,
  }),
);

export const GetProjectDetailsTool = readTool(
  Tool.make("get_project_details", {
    description:
      "Return safe read-only project details. Omits repository remote URLs and project Actions.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: OptionalCurrentProjectIdInput,
    }),
    dependencies,
  }),
);

export const GetProjectSettingsTool = readTool(
  Tool.make("get_project_settings", {
    description:
      "Return mutable project settings. Omit projectId to inspect the current MCP thread's project.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: OptionalCurrentProjectIdInput,
    }),
    dependencies,
  }),
);

export const UpdateProjectSettingsTool = writeTool(
  Tool.make("update_project_settings", {
    description:
      "Update project settings such as title and default MCP model. Requires explicit projectId.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: ProjectIdInput,
      title: OptionalTitleInput,
      defaultModelSelection: OptionalNullableModelSelectionInput,
    }),
    dependencies,
  }),
);

export const ListProjectActionsTool = readTool(
  Tool.make("list_project_actions", {
    description:
      "Return project Actions for a project. Commands are intentionally omitted from the response. Omit projectId to inspect the current MCP thread's project.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: OptionalCurrentProjectIdInput,
    }),
    dependencies,
  }),
);

export const CreateProjectActionTool = writeTool(
  Tool.make("create_project_action", {
    description:
      "Create a project Action. Requires explicit projectId. The stored command is accepted as input but intentionally not returned by MCP responses.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: ProjectIdInput,
      name: Schema.String.annotate({
        description: "Human-readable Action name shown in the UI.",
      }),
      command: Schema.String.annotate({
        description: "Shell command to store for this Action.",
      }),
      icon: optionalInput(ProjectActionIconInput, "Optional Action icon shown in the UI."),
      runOnWorktreeCreate: optionalInput(
        Schema.Boolean,
        "Whether this Action should run automatically when a worktree is created.",
      ),
      previewUrl: optionalInput(Schema.String, "Optional preview URL associated with this Action."),
      autoOpenPreview: optionalInput(
        Schema.Boolean,
        "Whether the preview should auto-open when the Action runs. Requires previewUrl.",
      ),
    }),
    dependencies,
  }),
);

export const UpdateProjectActionTool = writeTool(
  Tool.make("update_project_action", {
    description:
      "Update a project Action. Requires explicit projectId and actionId. Commands remain hidden from MCP responses.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: ProjectIdInput,
      actionId: Schema.String.annotate({
        description: "Action id returned by list_project_actions.",
      }),
      name: optionalInput(Schema.String, "Updated human-readable Action name."),
      command: optionalInput(Schema.String, "Updated shell command to store for this Action."),
      icon: optionalInput(ProjectActionIconInput, "Updated Action icon shown in the UI."),
      runOnWorktreeCreate: optionalInput(Schema.Boolean, "Updated worktree-create auto-run flag."),
      previewUrl: optionalInput(
        Schema.NullOr(
          Schema.String.annotate({
            description: "Updated preview URL. Use null to clear it.",
          }),
        ),
        "Updated preview URL. Use null to clear it.",
      ),
      autoOpenPreview: optionalInput(
        Schema.Boolean,
        "Updated preview auto-open flag. Requires a resulting previewUrl.",
      ),
    }),
    dependencies,
  }),
);

export const DeleteProjectActionTool = destructiveTool(
  Tool.make("delete_project_action", {
    description:
      "Delete a project Action. Requires explicit projectId and actionId. Returns sanitized Action metadata without commands.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: ProjectIdInput,
      actionId: Schema.String.annotate({
        description: "Action id returned by list_project_actions.",
      }),
    }),
    dependencies,
  }),
);

export const AddProjectTool = writeTool(
  Tool.make("add_project", {
    description:
      "Add a project by source directory path, returning an existing project for duplicate paths.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description: "Filesystem path to a project source directory to add to T3 Code.",
      }),
    }),
    dependencies,
  }),
);

export const ThreadPlacement = Schema.Literals(["top_level", "child_of_thread"]);

export const CreateThreadTool = writeTool(
  Tool.make("create_thread", {
    description:
      "Create a T3Code thread, optionally as a child thread and optionally with a first message. Prefer child_of_thread for related follow-up work so related agents stay grouped under the existing workstream. Reserve top_level for independent workstreams that should stand apart from the current thread. When a first message is provided you may also pass the per-turn control options (waitForResponse, turnTimeoutMs, responseTimeoutMs) that send_thread_message accepts; they default OFF and apply to that first turn.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      projectId: OptionalProjectIdInput,
      placement: optionalInput(
        ThreadPlacement.annotate({
          description:
            "Where to place the new thread. Prefer child_of_thread for related follow-up work and pass parentThreadId for the current or directly relevant top-level thread. Reserve top_level for independent workstreams. Defaults to top_level unless parentThreadId is supplied, in which case child_of_thread is inferred.",
        }),
        "Where to place the new thread. Prefer child_of_thread for related follow-up work and pass parentThreadId for the current or directly relevant top-level thread. Reserve top_level for independent workstreams. Defaults to top_level unless parentThreadId is supplied, in which case child_of_thread is inferred.",
      ),
      parentThreadId: OptionalParentThreadIdInput,
      title: optionalInput(
        Schema.String.annotate({
          description:
            "Optional custom thread title. If omitted, the first message or New thread is used as the generated-title seed.",
        }),
        "Optional custom thread title. If omitted, the first message or New thread is used as the generated-title seed.",
      ),
      message: optionalInput(
        ThreadMessageInput,
        "Optional first user message. When present, the new thread is created and the turn is started.",
      ),
      modelSelection: OptionalModelSelectionInput,
      runtimeMode: CreateThreadRuntimeModeInput,
      interactionMode: OptionalInteractionModeInput,
      checkoutMode: CreateThreadCheckoutModeInput,
      branch: OptionalBootstrapBranchInput,
      baseBranch: OptionalBaseBranchInput,
      waitForResponse: OptionalWaitForResponseInput,
      timeoutMs: OptionalWaitTimeoutMsInput,
      turnTimeoutMs: OptionalTurnTimeoutMsInput,
      responseTimeoutMs: OptionalResponseTimeoutMsInput,
      maxCharacters: OptionalWaitMaxCharactersInput,
    }),
    dependencies,
  }),
);

export const SendThreadMessageTool = writeTool(
  Tool.make("send_thread_message", {
    description:
      "Send a user message to an existing idle thread, starting a turn. By default returns immediately after the turn is accepted (fire-and-forget). Optionally set waitForResponse to block for the turn's final answer, and/or turnTimeoutMs / responseTimeoutMs to auto-CANCEL a runaway or blocked turn. These options compose and all default OFF; note waitForResponse's timeout only stops waiting while turnTimeoutMs/responseTimeoutMs cancel.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
      message: ThreadMessageInput.annotate({
        description: "User message to send to the idle thread.",
      }),
      modelSelection: OptionalModelSelectionInput,
      checkoutMode: OptionalCheckoutModeInput,
      branch: OptionalBootstrapBranchInput,
      baseBranch: OptionalBaseBranchInput,
      waitForResponse: OptionalWaitForResponseInput,
      timeoutMs: OptionalWaitTimeoutMsInput,
      turnTimeoutMs: OptionalTurnTimeoutMsInput,
      responseTimeoutMs: OptionalResponseTimeoutMsInput,
      maxCharacters: OptionalWaitMaxCharactersInput,
    }),
    dependencies,
  }),
);

export const UpdateThreadSettingsTool = writeTool(
  Tool.make("update_thread_settings", {
    description: "Update settings for an existing idle thread.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
      title: optionalInput(
        Schema.String.annotate({
          description: "Human-readable thread title.",
        }),
        "Human-readable thread title.",
      ),
      modelSelection: OptionalModelSelectionInput,
      runtimeMode: OptionalRuntimeModeInput,
      interactionMode: OptionalInteractionModeInput,
      checkoutMode: OptionalCheckoutModeInput,
      branch: OptionalThreadMetadataBranchInput,
      worktreePath: OptionalWorktreePathInput,
    }),
    dependencies,
  }),
);

const RequestIdInput = Schema.String.annotate({
  description:
    "Open request id to answer. Discover open requests via get_thread_settings (pendingRequests) or get_thread_messages activities.",
})
  .check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .pipe(Schema.brand("ApprovalRequestId"));

export const InterruptThreadTurnTool = destructiveTool(
  Tool.make("interrupt_thread_turn", {
    description:
      "Interrupt the running turn of an MCP-managed sub-thread. Cancels any pending approval/user-input requests and returns the thread to idle so you can send a corrective message. Use to stop a runaway or misdirected sub-thread.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
    }),
    dependencies,
  }),
);

export const RespondToApprovalTool = writeTool(
  Tool.make("respond_to_approval", {
    description:
      "Answer a pending approval request raised inside an MCP-managed sub-thread (e.g. command execution or file change while in approval-required mode). The thread blocks on the gate until answered. Discover open requests via get_thread_settings (pendingRequests).",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
      requestId: RequestIdInput,
      decision: Schema.Literals(["accept", "decline", "acceptForSession"]).annotate({
        description:
          "accept = allow this one request; decline = deny it; acceptForSession = allow it AND stop being asked about the same kind of request for the rest of the session (cannot be individually revoked). To cancel the turn instead, use interrupt_thread_turn.",
      }),
    }),
    dependencies,
  }),
);

export const RespondToUserInputTool = writeTool(
  Tool.make("respond_to_user_input", {
    description:
      "Answer a pending user-input request (a question the provider asked mid-turn) inside an MCP-managed sub-thread. The thread blocks until answered. Discover the open request and its expected fields via get_thread_settings (pendingRequests).",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
      requestId: RequestIdInput,
      answers: Schema.Record(Schema.String, Schema.Unknown).annotate({
        description:
          "Answer fields keyed by the request's field names (see the pending request's fields). Free-form object.",
      }),
    }),
    dependencies,
  }),
);

export const DeleteThreadTool = destructiveTool(
  Tool.make("delete_thread", {
    description:
      "Permanently delete an MCP-managed thread and its sub-threads. Only threads within your MCP creation-subtree can be deleted; user-created threads cannot.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
    }),
    dependencies,
  }),
);

export const ArchiveThreadTool = destructiveTool(
  Tool.make("archive_thread", {
    description:
      "Archive an MCP-managed thread (hide it from the active list; reversible via unarchive_thread). Only threads within your MCP creation-subtree can be archived.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
    }),
    dependencies,
  }),
);

export const UnarchiveThreadTool = destructiveTool(
  Tool.make("unarchive_thread", {
    description:
      "Restore a previously archived MCP-managed thread to the active list. Only threads within your MCP creation-subtree can be unarchived.",
    success: Schema.Unknown,
    failure: McpOrchestrationError,
    parameters: Schema.Struct({
      threadId: ThreadIdInput,
    }),
    dependencies,
  }),
);

export const OrchestrationToolkit = Toolkit.make(
  ListMcpModelsTool,
  ListProjectsTool,
  GetProjectDetailsTool,
  GetProjectSettingsTool,
  UpdateProjectSettingsTool,
  ListThreadsTool,
  GetThreadSettingsTool,
  GetThreadMessagesTool,
  ListProjectActionsTool,
  CreateProjectActionTool,
  UpdateProjectActionTool,
  DeleteProjectActionTool,
  AddProjectTool,
  CreateThreadTool,
  SendThreadMessageTool,
  UpdateThreadSettingsTool,
  InterruptThreadTurnTool,
  RespondToApprovalTool,
  RespondToUserInputTool,
  DeleteThreadTool,
  ArchiveThreadTool,
  UnarchiveThreadTool,
  GetThreadDiffTool,
);
