import {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  McpOrchestrationError,
  McpOrchestrationService,
} from "../../Services/McpOrchestrationService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, McpOrchestrationService];

export const ListMcpModelsTool = Tool.make("list_mcp_models", {
  description: "Return provider instances and MCP-enabled models available to MCP tools.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({}),
  dependencies,
});

export const ListProjectsTool = Tool.make("list_projects", {
  description: "Return T3Code projects, optionally fuzzy searched by title or path.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    search: Schema.optional(Schema.String),
  }),
  dependencies,
});

export const ListThreadsTool = Tool.make("list_threads", {
  description: "Return threads for a project, optionally searched by title and message history.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: ProjectId,
    search: Schema.optional(Schema.String),
    archived: Schema.optional(Schema.Literals(["exclude", "include", "only"])),
  }),
  dependencies,
});

export const GetThreadHistoryTool = Tool.make("get_thread_history", {
  description: "Return a thread summary or complete projected thread history.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadId,
    mode: Schema.Literals(["summary", "complete"]),
    limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    cursor: Schema.optional(Schema.String),
    maxCharacters: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  dependencies,
});

export const GetCurrentThreadSettingsTool = Tool.make("get_current_thread_settings", {
  description: "Return settings for the current MCP credential thread.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({}),
  dependencies,
});

export const AddProjectTool = Tool.make("add_project", {
  description:
    "Add a project by source directory path, returning an existing project for duplicate paths.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    path: Schema.String,
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
    projectId: Schema.optional(ProjectId),
    placement: Schema.optional(ThreadPlacement),
    parentThreadId: Schema.optional(ThreadId),
    title: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    checkoutMode: Schema.optional(Schema.Literals(["current_checkout", "new_worktree"])),
    branch: Schema.optional(Schema.NullOr(Schema.String)),
    worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
    baseBranch: Schema.optional(Schema.String),
  }),
  dependencies,
});

export const SendThreadMessageTool = Tool.make("send_thread_message", {
  description: "Send a user message to an existing idle thread and return after turn acceptance.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadId,
    message: Schema.String,
    modelSelection: Schema.optional(ModelSelection),
  }),
  dependencies,
});

export const UpdateThreadSettingsTool = Tool.make("update_thread_settings", {
  description: "Update settings for an existing idle thread.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    threadId: ThreadId,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    checkoutMode: Schema.optional(Schema.Literals(["current_checkout", "new_worktree"])),
    branch: Schema.optional(Schema.NullOr(Schema.String)),
    worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
    baseBranch: Schema.optional(Schema.String),
  }),
  dependencies,
});

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
