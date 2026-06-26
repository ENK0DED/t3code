import {
  ModelSelection,
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

const OptionalBranchInput = Schema.optional(
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

export const GetThreadHistoryTool = Tool.make("get_thread_history", {
  description: "Return a thread summary or complete projected thread history.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    mode: Schema.Literals(["summary", "complete"]).annotate({
      description:
        "History response mode. Use summary for a compact generated summary or complete for raw projected history.",
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

export const ThreadPlacement = Schema.Literals([
  "child_of_current",
  "top_level",
  "child_of_thread",
]);

export const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Create a T3Code thread, optionally as a child thread and optionally with a first message.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalProjectIdInput,
    placement: Schema.optional(
      ThreadPlacement.annotate({
        description:
          "Where to place the new thread. Defaults to child_of_current in the current project, otherwise top_level. Use child_of_thread with parentThreadId to pick a specific parent thread.",
      }),
    ).annotate({
      description:
        "Where to place the new thread. Defaults to child_of_current in the current project, otherwise top_level. Use child_of_thread with parentThreadId to pick a specific parent thread.",
    }),
    parentThreadId: OptionalParentThreadIdInput,
    title: Schema.optional(
      Schema.String.annotate({
        description:
          "Optional thread title. If omitted, the first message or New thread is used as the title seed.",
      }),
    ).annotate({
      description:
        "Optional thread title. If omitted, the first message or New thread is used as the title seed.",
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
    runtimeMode: OptionalRuntimeModeInput,
    interactionMode: OptionalInteractionModeInput,
    checkoutMode: OptionalCheckoutModeInput,
    branch: OptionalBranchInput,
    worktreePath: OptionalWorktreePathInput,
    baseBranch: OptionalBaseBranchInput,
  }),
  dependencies,
});

export const SendThreadMessageTool = Tool.make("send_thread_message", {
  description: "Send a user message to an existing idle thread and return after turn acceptance.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    message: Schema.String.annotate({
      description: "User message to send to the idle thread.",
    }),
    modelSelection: OptionalModelSelectionInput,
  }),
  dependencies,
});

export const UpdateThreadSettingsTool = Tool.make("update_thread_settings", {
  description: "Update settings for an existing idle thread.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    modelSelection: OptionalModelSelectionInput,
    runtimeMode: OptionalRuntimeModeInput,
    interactionMode: OptionalInteractionModeInput,
    checkoutMode: OptionalCheckoutModeInput,
    branch: OptionalBranchInput,
    worktreePath: OptionalWorktreePathInput,
    baseBranch: OptionalBaseBranchInput,
  }),
  dependencies,
});

export const OrchestrationToolkit = Toolkit.make(
  ListMcpModelsTool,
  ListProjectsTool,
  GetProjectDetailsTool,
  GetProjectSettingsTool,
  UpdateProjectSettingsTool,
  ListProjectActionsTool,
  CreateProjectActionTool,
  UpdateProjectActionTool,
  DeleteProjectActionTool,
  ListThreadsTool,
  GetThreadHistoryTool,
  GetThreadSettingsTool,
  AddProjectTool,
  CreateThreadTool,
  SendThreadMessageTool,
  UpdateThreadSettingsTool,
);
