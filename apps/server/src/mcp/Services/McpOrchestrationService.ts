import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class McpOrchestrationError extends Schema.TaggedErrorClass<McpOrchestrationError>()(
  "McpOrchestrationError",
  {
    code: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export interface McpOrchestrationServiceShape {
  readonly listMcpModels: () => Effect.Effect<unknown, McpOrchestrationError>;
  readonly listProjects: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly listThreads: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly getThreadHistory: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly getCurrentThreadSettings: () => Effect.Effect<unknown, McpOrchestrationError>;
  readonly addProject: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly createThread: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly sendThreadMessage: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
  readonly updateThreadSettings: (input: unknown) => Effect.Effect<unknown, McpOrchestrationError>;
}

export class McpOrchestrationService extends Context.Service<
  McpOrchestrationService,
  McpOrchestrationServiceShape
>()("t3/mcp/Services/McpOrchestrationService") {}
