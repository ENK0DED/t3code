import * as Effect from "effect/Effect";

import { McpOrchestrationService } from "../../Services/McpOrchestrationService.ts";
import { OrchestrationToolkit } from "./tools.ts";

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer({
  list_mcp_models: () =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.listMcpModels();
    }),
  list_projects: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.listProjects(input);
    }),
  list_threads: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.listThreads(input);
    }),
  get_thread_history: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.getThreadHistory(input);
    }),
  get_current_thread_settings: () =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.getCurrentThreadSettings();
    }),
  add_project: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.addProject(input);
    }),
  create_thread: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.createThread(input);
    }),
  send_thread_message: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.sendThreadMessage(input);
    }),
  update_thread_settings: (input) =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      return yield* service.updateThreadSettings(input);
    }),
});
