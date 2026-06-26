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
