import {
  ModelSelection,
  NonNegativeInt,
  ProjectScriptIcon,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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

const OptionalProjectIdInput = Schema.optional(ProjectIdInput).annotate({
  description:
    "Project id for the new thread. Omit to use the current MCP credential thread's project.",
});

const OptionalCurrentProjectIdInput = Schema.optional(ProjectIdInput).annotate({
  description: "Project id. Omit to use the current MCP credential thread's project.",
});

const ProjectActionIconInput = ProjectScriptIcon.annotate({
  description: "Action icon. Use one of: play, test, lint, configure, build, or debug.",
});

const ThreadIdInput = Schema.String.annotate({
  description: "Thread id returned by list_threads or create_thread.",
})
  .check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .pipe(Schema.brand("ThreadId"));

const OptionalThreadIdInput = Schema.optional(ThreadIdInput).annotate({
  description:
    "Thread id returned by list_threads or create_thread. Omit to use the current MCP credential thread.",
});

const OptionalParentThreadIdInput = Schema.optional(ThreadIdInput).annotate({
  description:
    "Existing top-level thread id to use as the parent when placement is child_of_thread. The parent must be in the target project and must not already be a sub-thread.",
});

const OptionalModelSelectionInput = Schema.optional(
  ModelSelection.annotate({
    description:
      "Provider instance, model slug, and model option selections. Use list_mcp_models to discover MCP-enabled choices.",
  }),
).annotate({
  description:
    "Provider instance, model slug, and model option selections. Use list_mcp_models to discover MCP-enabled choices.",
});

const OptionalNullableModelSelectionInput = Schema.optional(
  Schema.NullOr(
    ModelSelection.annotate({
      description:
        "Provider instance, model slug, and model option selections. Use null to clear the project's default model.",
    }),
  ),
).annotate({
  description:
    "Provider instance, model slug, and model option selections. Use list_mcp_models to discover MCP-enabled choices, or null to clear the project's default model.",
});

const OptionalTitleInput = Schema.optional(
  Schema.String.annotate({
    description: "Human-readable project title.",
  }),
).annotate({
  description: "Human-readable project title.",
});

const OptionalRuntimeModeInput = Schema.optional(
  RuntimeMode.annotate({
    description:
      "Runtime permission mode for the thread: approval-required, auto-accept-edits, or full-access.",
  }),
).annotate({
  description:
    "Runtime permission mode for the thread: approval-required, auto-accept-edits, or full-access.",
});

const CreateThreadRuntimeModeInput = Schema.optional(
  RuntimeMode.annotate({
    description:
      "Runtime permission mode for the new thread: approval-required, auto-accept-edits, or full-access. Omitted default (this field only): auto-accept-edits (workspace-write sandbox — commands run sandboxed and escalations are gated). Pass an explicit value to override; full-access removes the sandbox.",
  }),
).annotate({
  description:
    "Runtime permission mode for the new thread: approval-required, auto-accept-edits, or full-access. Omitted default (this field only): auto-accept-edits (workspace-write sandbox — commands run sandboxed and escalations are gated). Pass an explicit value to override; full-access removes the sandbox.",
});

const OptionalInteractionModeInput = Schema.optional(
  ProviderInteractionMode.annotate({
    description: "Provider interaction mode. Use plan for planning-only turns.",
  }),
).annotate({
  description: "Provider interaction mode. Use plan for planning-only turns.",
});

const OptionalCheckoutModeInput = Schema.optional(
  Schema.Literals(["current_checkout", "new_worktree"]).annotate({
    description:
      "Checkout handling for the thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation.",
  }),
).annotate({
  description:
    "Checkout handling for the thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation.",
});

const CreateThreadCheckoutModeInput = Schema.optional(
  Schema.Literals(["current_checkout", "new_worktree"]).annotate({
    description:
      "Checkout handling for the new thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation. Omitted default (this field only): top_level threads default to new_worktree (isolated checkout); child_of_thread threads inherit the parent thread's checkout. Pass an explicit value to override.",
  }),
).annotate({
  description:
    "Checkout handling for the new thread. Use current_checkout for the project workspace or new_worktree for branch/worktree metadata and first-turn worktree preparation. Omitted default (this field only): top_level threads default to new_worktree (isolated checkout); child_of_thread threads inherit the parent thread's checkout. Pass an explicit value to override.",
});

const OptionalBootstrapBranchInput = Schema.optional(
  Schema.String.annotate({
    description:
      "Optional branch name for first-turn new_worktree bootstrap. Omit to let T3 Code derive a branch. Null is not accepted.",
  }),
).annotate({
  description:
    "Optional branch name for first-turn new_worktree bootstrap. Omit to let T3 Code derive a branch. Null is not accepted.",
});

const OptionalThreadMetadataBranchInput = Schema.optional(
  Schema.NullOr(
    Schema.String.annotate({
      description: "Git branch name associated with a new_worktree checkout, or null to clear it.",
    }),
  ),
).annotate({
  description: "Git branch name associated with a new_worktree checkout, or null to clear it.",
});

const OptionalWorktreePathInput = Schema.optional(
  Schema.NullOr(
    Schema.String.annotate({
      description:
        "Filesystem path for a new_worktree checkout, or null to clear it. Omit to inherit the current compatible checkout metadata.",
    }),
  ),
).annotate({
  description:
    "Filesystem path for a new_worktree checkout, or null to clear it. Omit to inherit the current compatible checkout metadata.",
});

const OptionalBaseBranchInput = Schema.optional(
  Schema.String.annotate({
    description: "Base git branch used when preparing a new worktree during a first turn.",
  }),
).annotate({
  description: "Base git branch used when preparing a new worktree during a first turn.",
});

// --- Per-turn control options (default OFF; omitted = fire-and-forget) ---
// These three knobs are independent and COMPOSE; whichever condition fires first wins.
// CRITICAL distinction the agent must not confuse:
//   - waitForResponse timeout (timeoutMs) => STOP WAITING and return; the turn KEEPS RUNNING.
//   - turnTimeoutMs / responseTimeoutMs  => CANCEL (interrupt) the turn on breach.
const WAIT_FOR_RESPONSE_DESCRIPTION =
  'When true, block after dispatching the turn until it reaches a terminal state (completed/interrupted/error) or timeoutMs elapses, then return a `wait` object containing the terminal `state` and the verbatim final assistant answer inline (reasoning/tool calls excluded; maxCharacters-bounded with a `truncated` flag). On the timeoutMs deadline this STOPS WAITING and returns (state: "running", answer: null, timedOut: true) WITHOUT cancelling — the turn keeps running (use interrupt_thread_turn or turnTimeoutMs to cancel). error/interrupted/edits-only turns return their state with a null answer (use get_thread_diff for code changes). Default OFF (fire-and-forget; no `wait` object).';

const OptionalWaitForResponseInput = Schema.optional(
  Schema.Boolean.annotate({ description: WAIT_FOR_RESPONSE_DESCRIPTION }),
).annotate({ description: WAIT_FOR_RESPONSE_DESCRIPTION });

const WAIT_TIMEOUT_MS_DESCRIPTION =
  'Milliseconds to wait when waitForResponse is true before giving up. On expiry the call STOPS WAITING and returns (state: "running", answer: null, timedOut: true); the turn is NOT cancelled (distinct from turnTimeoutMs). Ignored unless waitForResponse is true. If omitted while waiting, falls back to turnTimeoutMs, then to a default ceiling so the call always returns.';

const OptionalWaitTimeoutMsInput = Schema.optional(
  NonNegativeInt.annotate({ description: WAIT_TIMEOUT_MS_DESCRIPTION }),
).annotate({ description: WAIT_TIMEOUT_MS_DESCRIPTION });

const TURN_TIMEOUT_MS_DESCRIPTION =
  "Total wall-clock budget (milliseconds) for the dispatched turn. On breach the turn is CANCELLED (interrupt dispatched) — never auto-approved — leaving a timed-out activity. Bounds total work; composes with responseTimeoutMs (whichever fires first cancels). This CANCELS, unlike a waitForResponse timeout which only stops waiting. Default OFF.";

const OptionalTurnTimeoutMsInput = Schema.optional(
  NonNegativeInt.annotate({ description: TURN_TIMEOUT_MS_DESCRIPTION }),
).annotate({ description: TURN_TIMEOUT_MS_DESCRIPTION });

const RESPONSE_TIMEOUT_MS_DESCRIPTION =
  "Maximum time (milliseconds) the turn may sit blocked on a pending approval/user-input request. On breach the turn is CANCELLED (interrupt dispatched) — NEVER auto-approved. Bounds an abandoned/blocked gate; composes with turnTimeoutMs (whichever fires first cancels). This CANCELS, unlike a waitForResponse timeout which only stops waiting. Default OFF.";

const OptionalResponseTimeoutMsInput = Schema.optional(
  NonNegativeInt.annotate({ description: RESPONSE_TIMEOUT_MS_DESCRIPTION }),
).annotate({ description: RESPONSE_TIMEOUT_MS_DESCRIPTION });

const WAIT_MAX_CHARACTERS_DESCRIPTION =
  "When waitForResponse is true, the maximum number of characters of the inline answer text returned in the `wait` object; longer answers are truncated with truncated: true (fetch the full text via get_thread_messages). Ignored unless waitForResponse is true.";

const OptionalWaitMaxCharactersInput = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: WAIT_MAX_CHARACTERS_DESCRIPTION,
  }),
).annotate({ description: WAIT_MAX_CHARACTERS_DESCRIPTION });

export const ListMcpModelsTool = Tool.make("list_mcp_models", {
  description: "Return provider instances and MCP-enabled models available to MCP tools.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: EmptyObjectInput,
  dependencies,
});

export const ListProjectsTool = Tool.make("list_projects", {
  description: "Return T3Code projects, optionally fuzzy searched by title or path.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    search: Schema.optional(
      Schema.String.annotate({
        description: "Optional fuzzy search text matched against project title and path.",
      }),
    ).annotate({
      description: "Optional fuzzy search text matched against project title and path.",
    }),
  }),
  dependencies,
});

export const ListThreadsTool = Tool.make("list_threads", {
  description: "Return threads for a project, optionally searched by title and message history.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: ProjectIdInput,
    search: Schema.optional(
      Schema.String.annotate({
        description: "Optional fuzzy search text matched against thread title and message history.",
      }),
    ).annotate({
      description: "Optional fuzzy search text matched against thread title and message history.",
    }),
    archived: Schema.optional(
      Schema.Literals(["exclude", "include", "only"]).annotate({
        description:
          "Archive filter. Defaults to exclude; use include to search active and archived threads or only for archived threads.",
      }),
    ).annotate({
      description:
        "Archive filter. Defaults to exclude; use include to search active and archived threads or only for archived threads.",
    }),
  }),
  dependencies,
});

export const GetThreadMessagesTool = Tool.make("get_thread_messages", {
  description:
    "Read a thread's messages in one of five modes. summary: an LLM-distilled summary of the whole thread. complete: the full projected message history (pageable via limit/cursor). latest_response: the verbatim text of the last assistant message of the latest COMPLETED turn (reasoning/tool calls already excluded), plus that turn's id and state; if a turn is currently running it returns the previous completed answer with inProgress: true (or a null answer when nothing has completed yet). turn: the user message and assistant response of one turn identified by turnCount, plus that turn's state. message: a single message identified by messageId.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    mode: Schema.Literals(["summary", "complete", "latest_response", "turn", "message"]).annotate({
      description:
        "Message read mode. summary = a compact generated summary of the whole thread. complete = raw projected message history (use limit/cursor/maxCharacters). latest_response = the latest completed turn's final assistant message text verbatim, with the turn id/state and an inProgress flag. turn = one turn's user message + assistant response + state (requires turnCount). message = a single message (requires messageId).",
    }),
    limit: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description: "Maximum number of messages to include when mode is complete.",
      }),
    ).annotate({
      description: "Maximum number of messages to include when mode is complete.",
    }),
    cursor: Schema.optional(
      Schema.String.annotate({
        description:
          "Zero-based message offset cursor returned by the caller. Use with limit to page complete history.",
      }),
    ).annotate({
      description:
        "Zero-based message offset cursor returned by the caller. Use with limit to page complete history.",
    }),
    turnCount: Schema.optional(
      NonNegativeInt.annotate({
        description:
          "Required when mode is turn: the zero-based ordinal of the turn to read (the checkpointTurnCount reported by checkpoints and get_thread_diff). Returns that turn's user message and assistant response.",
      }),
    ).annotate({
      description:
        "Required when mode is turn: the zero-based ordinal of the turn to read (the checkpointTurnCount reported by checkpoints and get_thread_diff). Returns that turn's user message and assistant response.",
    }),
    messageId: Schema.optional(
      Schema.String.annotate({
        description:
          "Required when mode is message: the id of the single message to return (from list_threads, complete history, or another get_thread_messages response).",
      })
        .check(Schema.isTrimmed())
        .check(Schema.isNonEmpty())
        .pipe(Schema.brand("MessageId")),
    ).annotate({
      description:
        "Required when mode is message: the id of the single message to return (from list_threads, complete history, or another get_thread_messages response).",
    }),
    maxCharacters: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description:
          "Maximum serialized response size allowed for complete history before returning payload_too_large.",
      }),
    ).annotate({
      description:
        "Maximum serialized response size allowed for complete history before returning payload_too_large.",
    }),
  }),
  dependencies,
});

export const GetThreadDiffTool = Tool.make("get_thread_diff", {
  description:
    "Return the code changes an MCP-managed sub-thread produced, as a unified git diff plus a structured per-file summary (path, change kind, added/removed line counts) so you can triage what changed without parsing the patch. Omit BOTH fromTurnCount and toTurnCount to get the full diff from the thread's first checkpoint to its latest completed turn (resolved server-side) — the single-call way to collect everything a child changed. Provide a turn range for a narrower diff. Turn counts are the zero-based checkpointTurnCount ordinals reported by checkpoints and get_thread_messages (mode=turn). If the unified diff exceeds maxCharacters the response still returns the per-file summary with truncated: true and an empty diff (re-request a narrower range for the full patch).",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    fromTurnCount: Schema.optional(
      NonNegativeInt.annotate({
        description:
          "Start of the turn range (exclusive lower checkpoint), as a zero-based checkpointTurnCount. Omit together with toTurnCount to diff the whole thread to its latest completed turn. If provided, toTurnCount must also be provided and be >= fromTurnCount.",
      }),
    ).annotate({
      description:
        "Start of the turn range (exclusive lower checkpoint), as a zero-based checkpointTurnCount. Omit together with toTurnCount to diff the whole thread to its latest completed turn. If provided, toTurnCount must also be provided and be >= fromTurnCount.",
    }),
    toTurnCount: Schema.optional(
      NonNegativeInt.annotate({
        description:
          "End of the turn range (inclusive upper checkpoint), as a zero-based checkpointTurnCount. Omit together with fromTurnCount to diff the whole thread to its latest completed turn. If provided, fromTurnCount must also be provided and be <= toTurnCount.",
      }),
    ).annotate({
      description:
        "End of the turn range (inclusive upper checkpoint), as a zero-based checkpointTurnCount. Omit together with fromTurnCount to diff the whole thread to its latest completed turn. If provided, fromTurnCount must also be provided and be <= toTurnCount.",
    }),
    ignoreWhitespace: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Whether to ignore whitespace-only changes when computing the diff. Defaults to true.",
      }),
    ).annotate({
      description:
        "Whether to ignore whitespace-only changes when computing the diff. Defaults to true.",
    }),
    maxCharacters: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description:
          "Maximum serialized response size. When the unified diff would exceed it, the diff is omitted (returned empty) and the response is flagged truncated: true while keeping the per-file summary; payload_too_large is only returned if even that summary cannot fit.",
      }),
    ).annotate({
      description:
        "Maximum serialized response size allowed before returning payload_too_large. Use to bound a large diff; the per-file summary still tells you what changed when the patch is too big.",
    }),
  }),
  dependencies,
});

export const GetThreadSettingsTool = Tool.make("get_thread_settings", {
  description:
    "Return thread settings and resolved model details. Omit threadId to inspect the current MCP credential thread.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: OptionalThreadIdInput,
  }),
  dependencies,
});

export const GetProjectDetailsTool = Tool.make("get_project_details", {
  description:
    "Return safe read-only project details. Omits repository remote URLs and project Actions.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalCurrentProjectIdInput,
  }),
  dependencies,
});

export const GetProjectSettingsTool = Tool.make("get_project_settings", {
  description:
    "Return mutable project settings. Omit projectId to inspect the current MCP thread's project.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalCurrentProjectIdInput,
  }),
  dependencies,
});

export const UpdateProjectSettingsTool = Tool.make("update_project_settings", {
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
});

export const ListProjectActionsTool = Tool.make("list_project_actions", {
  description:
    "Return project Actions for a project. Commands are intentionally omitted from the response. Omit projectId to inspect the current MCP thread's project.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalCurrentProjectIdInput,
  }),
  dependencies,
});

export const CreateProjectActionTool = Tool.make("create_project_action", {
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
    icon: Schema.optional(ProjectActionIconInput).annotate({
      description: "Optional Action icon shown in the UI.",
    }),
    runOnWorktreeCreate: Schema.optional(Schema.Boolean).annotate({
      description: "Whether this Action should run automatically when a worktree is created.",
    }),
    previewUrl: Schema.optional(Schema.String).annotate({
      description: "Optional preview URL associated with this Action.",
    }),
    autoOpenPreview: Schema.optional(Schema.Boolean).annotate({
      description:
        "Whether the preview should auto-open when the Action runs. Requires previewUrl.",
    }),
  }),
  dependencies,
});

export const UpdateProjectActionTool = Tool.make("update_project_action", {
  description:
    "Update a project Action. Requires explicit projectId and actionId. Commands remain hidden from MCP responses.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: ProjectIdInput,
    actionId: Schema.String.annotate({
      description: "Action id returned by list_project_actions.",
    }),
    name: Schema.optional(Schema.String).annotate({
      description: "Updated human-readable Action name.",
    }),
    command: Schema.optional(Schema.String).annotate({
      description: "Updated shell command to store for this Action.",
    }),
    icon: Schema.optional(ProjectActionIconInput).annotate({
      description: "Updated Action icon shown in the UI.",
    }),
    runOnWorktreeCreate: Schema.optional(Schema.Boolean).annotate({
      description: "Updated worktree-create auto-run flag.",
    }),
    previewUrl: Schema.optional(
      Schema.NullOr(
        Schema.String.annotate({
          description: "Updated preview URL. Use null to clear it.",
        }),
      ),
    ).annotate({
      description: "Updated preview URL. Use null to clear it.",
    }),
    autoOpenPreview: Schema.optional(Schema.Boolean).annotate({
      description: "Updated preview auto-open flag. Requires a resulting previewUrl.",
    }),
  }),
  dependencies,
});

export const DeleteProjectActionTool = Tool.make("delete_project_action", {
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
});

export const AddProjectTool = Tool.make("add_project", {
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
});

export const ThreadPlacement = Schema.Literals(["top_level", "child_of_thread"]);

export const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Create a T3Code thread, optionally as a child thread and optionally with a first message. When a first message is provided you may also pass the per-turn control options (waitForResponse, turnTimeoutMs, responseTimeoutMs) that send_thread_message accepts; they default OFF and apply to that first turn.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalProjectIdInput,
    placement: Schema.optional(
      ThreadPlacement.annotate({
        description:
          "Where to place the new thread. Defaults to top_level. Use child_of_thread with parentThreadId to pick a specific parent thread.",
      }),
    ).annotate({
      description:
        "Where to place the new thread. Defaults to top_level. Use child_of_thread with parentThreadId to pick a specific parent thread.",
    }),
    parentThreadId: OptionalParentThreadIdInput,
    title: Schema.optional(
      Schema.String.annotate({
        description:
          "Optional custom thread title. If omitted, the first message or New thread is used as the generated-title seed.",
      }),
    ).annotate({
      description:
        "Optional custom thread title. If omitted, the first message or New thread is used as the generated-title seed.",
    }),
    message: Schema.optional(
      Schema.String.annotate({
        description:
          "Optional first user message. When present, the new thread is created and the turn is started.",
      }),
    ).annotate({
      description:
        "Optional first user message. When present, the new thread is created and the turn is started.",
    }),
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
});

export const SendThreadMessageTool = Tool.make("send_thread_message", {
  description:
    "Send a user message to an existing idle thread, starting a turn. By default returns immediately after the turn is accepted (fire-and-forget). Optionally set waitForResponse to block for the turn's final answer, and/or turnTimeoutMs / responseTimeoutMs to auto-CANCEL a runaway or blocked turn. These options compose and all default OFF; note waitForResponse's timeout only stops waiting while turnTimeoutMs/responseTimeoutMs cancel.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    message: Schema.String.annotate({
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
});

export const UpdateThreadSettingsTool = Tool.make("update_thread_settings", {
  description: "Update settings for an existing idle thread.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    title: Schema.optional(
      Schema.String.annotate({
        description: "Human-readable thread title.",
      }),
    ).annotate({
      description: "Human-readable thread title.",
    }),
    modelSelection: OptionalModelSelectionInput,
    runtimeMode: OptionalRuntimeModeInput,
    interactionMode: OptionalInteractionModeInput,
    checkoutMode: OptionalCheckoutModeInput,
    branch: OptionalThreadMetadataBranchInput,
    worktreePath: OptionalWorktreePathInput,
  }),
  dependencies,
});

const RequestIdInput = Schema.String.annotate({
  description:
    "Open request id to answer. Discover open requests via get_thread_settings (pendingRequests) or get_thread_messages activities.",
})
  .check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .pipe(Schema.brand("ApprovalRequestId"));

export const InterruptThreadTurnTool = Tool.make("interrupt_thread_turn", {
  description:
    "Interrupt the running turn of an MCP-managed sub-thread. Cancels any pending approval/user-input requests and returns the thread to idle so you can send a corrective message. Use to stop a runaway or misdirected sub-thread.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
  }),
  dependencies,
});

export const RespondToApprovalTool = Tool.make("respond_to_approval", {
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
});

export const RespondToUserInputTool = Tool.make("respond_to_user_input", {
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
});

export const DeleteThreadTool = Tool.make("delete_thread", {
  description:
    "Permanently delete an MCP-managed thread and its sub-threads. Only threads within your MCP creation-subtree can be deleted; user-created threads cannot.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
  }),
  dependencies,
});

export const ArchiveThreadTool = Tool.make("archive_thread", {
  description:
    "Archive an MCP-managed thread (hide it from the active list; reversible via unarchive_thread). Only threads within your MCP creation-subtree can be archived.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
  }),
  dependencies,
});

export const UnarchiveThreadTool = Tool.make("unarchive_thread", {
  description:
    "Restore a previously archived MCP-managed thread to the active list. Only threads within your MCP creation-subtree can be unarchived.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
  }),
  dependencies,
});

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
