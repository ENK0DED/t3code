import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  McpOrchestrationError,
  McpOrchestrationService,
} from "../../Services/McpOrchestrationService.ts";
import { OrchestrationToolkit } from "./tools.ts";

const invokeRead = Effect.fn("OrchestrationToolkit.invokeRead")(function* <A>(
  operation: Effect.Effect<
    A,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext | McpOrchestrationService
  >,
): Effect.fn.Return<
  A,
  McpOrchestrationError,
  McpInvocationContext.McpInvocationContext | McpOrchestrationService
> {
  yield* McpInvocationContext.requireMcpOrchestrationRead().pipe(
    Effect.mapError(
      (error) =>
        new McpOrchestrationError({
          code: "forbidden",
          message: error.message,
        }),
    ),
  );
  return yield* operation;
});

const invokeWrite = Effect.fn("OrchestrationToolkit.invokeWrite")(function* <A>(
  operation: Effect.Effect<
    A,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext | McpOrchestrationService
  >,
): Effect.fn.Return<
  A,
  McpOrchestrationError,
  McpInvocationContext.McpInvocationContext | McpOrchestrationService
> {
  yield* McpInvocationContext.requireMcpOrchestrationWrite().pipe(
    Effect.mapError(
      (error) =>
        new McpOrchestrationError({
          code: "forbidden",
          message: error.message,
        }),
    ),
  );
  return yield* operation;
});

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer({
  list_mcp_models: () =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.listMcpModels()))),
  list_projects: (input) =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.listProjects(input)))),
  get_project_details: (input) =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getProjectDetails(input)))),
  get_project_settings: (input) =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getProjectSettings(input)))),
  update_project_settings: (input) =>
    invokeWrite(
      McpOrchestrationService.pipe(Effect.flatMap((s) => s.updateProjectSettings(input))),
    ),
  list_threads: (input) =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.listThreads(input)))),
  get_thread_history: (input) =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getThreadHistory(input)))),
  get_current_thread_settings: () =>
    invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getCurrentThreadSettings()))),
  add_project: (input) =>
    invokeWrite(McpOrchestrationService.pipe(Effect.flatMap((s) => s.addProject(input)))),
  create_thread: (input) =>
    invokeWrite(McpOrchestrationService.pipe(Effect.flatMap((s) => s.createThread(input)))),
  send_thread_message: (input) =>
    invokeWrite(McpOrchestrationService.pipe(Effect.flatMap((s) => s.sendThreadMessage(input)))),
  update_thread_settings: (input) =>
    invokeWrite(McpOrchestrationService.pipe(Effect.flatMap((s) => s.updateThreadSettings(input)))),
});
