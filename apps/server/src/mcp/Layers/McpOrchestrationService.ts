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

const failNotImplemented = Effect.fn("McpOrchestrationService.failNotImplemented")(function* (
  tool: string,
) {
  return yield* notImplemented(tool);
});

export const McpOrchestrationServiceLive = Layer.succeed(
  McpOrchestrationService,
  McpOrchestrationService.of({
    listMcpModels: () => failNotImplemented("list_mcp_models"),
    listProjects: () => failNotImplemented("list_projects"),
    listThreads: () => failNotImplemented("list_threads"),
    getThreadHistory: () => failNotImplemented("get_thread_history"),
    getCurrentThreadSettings: () => failNotImplemented("get_current_thread_settings"),
    addProject: () => failNotImplemented("add_project"),
    createThread: () => failNotImplemented("create_thread"),
    sendThreadMessage: () => failNotImplemented("send_thread_message"),
    updateThreadSettings: () => failNotImplemented("update_thread_settings"),
  }),
);
