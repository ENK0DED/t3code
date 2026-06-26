import type {
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as McpInvocationContext from "../McpInvocationContext.ts";

export class McpOrchestrationError extends Schema.TaggedErrorClass<McpOrchestrationError>()(
  "McpOrchestrationError",
  {
    code: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export interface ListMcpModelsModel {
  readonly slug: string;
  readonly name: string;
  readonly isCustom: boolean;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}

export interface ListMcpModelsProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly name: string;
  readonly models: Readonly<Record<string, ListMcpModelsModel>>;
}

export interface ListMcpModelsResult {
  readonly providers: Readonly<Record<string, ListMcpModelsProvider>>;
}

export interface ListProjectsInput {
  readonly search?: string | undefined;
}

export interface ProjectSelector {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ListProjectsResult {
  readonly projects: ReadonlyArray<ProjectSelector>;
}

export interface ProjectRepositorySummary {
  readonly displayName?: string | undefined;
  readonly provider?: string | undefined;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
}

export interface ProjectDetailsResult {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly repositorySummary: ProjectRepositorySummary | null;
}

export interface ResolvedMcpModel {
  readonly provider: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly name: string;
  };
  readonly model: {
    readonly slug: string;
    readonly name: string;
  };
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly value: string | boolean;
    readonly label: string;
    readonly valueLabel?: string | undefined;
  }>;
}

export interface ProjectSettingsResult {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly resolvedDefaultModel: ResolvedMcpModel | null;
  readonly defaultModelResolutionWarning?: string | undefined;
}

export interface UpdateProjectSettingsInput {
  readonly projectId: ProjectId;
  readonly title?: string | undefined;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
}

export interface UpdateProjectSettingsResult {
  readonly status: "updated";
  readonly projectId: ProjectId;
  readonly sequence: number;
}

export interface ListThreadsInput {
  readonly projectId: ProjectId;
  readonly search?: string | undefined;
  readonly archived?: "exclude" | "include" | "only" | undefined;
}

export interface ListThreadsResult {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly parentThreadId: ThreadId | null;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
    readonly latestUserMessageAt: string | null;
    readonly session: unknown;
    readonly latestTurn: unknown;
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
    readonly hasActionableProposedPlan: boolean;
  }>;
}

export interface CurrentThreadSettingsResult {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly provider: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly name: string;
  };
  readonly model: {
    readonly slug: string;
    readonly name: string;
  };
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly value: string | boolean;
    readonly label: string;
    readonly valueLabel?: string | undefined;
  }>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly checkoutMode: "current_checkout" | "new_worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly threadDepth: 0 | 1;
  readonly maxThreadDepth: 1;
  readonly canCreateChildThread: boolean;
  readonly session: unknown;
}

export interface GetThreadHistoryInput {
  readonly threadId: ThreadId;
  readonly mode: "summary" | "complete";
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly maxCharacters?: number | undefined;
}

export interface McpOrchestrationServiceShape {
  readonly listMcpModels: () => Effect.Effect<
    ListMcpModelsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly listProjects: (
    input: ListProjectsInput,
  ) => Effect.Effect<
    ListProjectsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly getProjectDetails: (input: {
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<
    ProjectDetailsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly getProjectSettings: (input: {
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<
    ProjectSettingsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly updateProjectSettings: (
    input: UpdateProjectSettingsInput,
  ) => Effect.Effect<
    UpdateProjectSettingsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly listThreads: (
    input: ListThreadsInput,
  ) => Effect.Effect<
    ListThreadsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly getThreadHistory: (
    input: GetThreadHistoryInput,
  ) => Effect.Effect<unknown, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
  readonly getCurrentThreadSettings: () => Effect.Effect<
    CurrentThreadSettingsResult,
    McpOrchestrationError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly addProject: (
    input: unknown,
  ) => Effect.Effect<unknown, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
  readonly createThread: (
    input: unknown,
  ) => Effect.Effect<unknown, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
  readonly sendThreadMessage: (
    input: unknown,
  ) => Effect.Effect<unknown, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
  readonly updateThreadSettings: (
    input: unknown,
  ) => Effect.Effect<unknown, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
}

/** @effect-expect-leaking McpInvocationContext */
export class McpOrchestrationService extends Context.Service<
  McpOrchestrationService,
  McpOrchestrationServiceShape
>()("t3/mcp/Services/McpOrchestrationService") {}
