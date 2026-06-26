import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  ProjectId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { buildProjectCreateCommand, resolveAddProjectPath } from "@t3tools/shared/addProject";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import { normalizeProjectPathForComparison } from "@t3tools/shared/projectPaths";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcher } from "../../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import {
  resolveCurrentSessionModelSelectionForCompatibility,
  validateProviderSessionModelSelectionCompatibility,
} from "../../orchestration/providerSessionCompatibility.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import {
  McpOrchestrationError,
  McpOrchestrationService,
} from "../Services/McpOrchestrationService.ts";

const MCP_STRUCTURED_RESPONSE_MAX_BYTES = 1_000_000;
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

const requireRead = Effect.fn("McpOrchestrationService.requireRead")(function* () {
  return yield* McpInvocationContext.requireMcpOrchestrationRead().pipe(
    Effect.mapError(
      (error) =>
        new McpOrchestrationError({
          code: "forbidden",
          message: error.message,
        }),
    ),
  );
});

function parseHistoryCursor(
  cursor: string | undefined,
): Effect.Effect<number, McpOrchestrationError> {
  if (cursor === undefined) {
    return Effect.succeed(0);
  }

  const parsed = Number.parseInt(cursor, 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed.toString() === cursor) {
    return Effect.succeed(parsed);
  }

  return Effect.fail(
    new McpOrchestrationError({
      code: "invalid_cursor",
      message: `Cursor '${cursor}' is invalid. Expected a non-negative integer.`,
    }),
  );
}

function applyHistoryWindow(
  thread: OrchestrationThread,
  input: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): Effect.Effect<OrchestrationThread, McpOrchestrationError> {
  return Effect.gen(function* () {
    const start = yield* parseHistoryCursor(input.cursor);
    const end = input.limit !== undefined ? start + input.limit : undefined;

    if (start === 0 && end === undefined) {
      return thread;
    }

    return {
      ...thread,
      messages: thread.messages.slice(start, end),
    };
  });
}

function toInternalError(message: string, detail?: unknown): McpOrchestrationError {
  return new McpOrchestrationError({
    code: "internal_error",
    message,
    ...(detail !== undefined
      ? {
          detail: detail instanceof Error ? detail.message : String(detail),
        }
      : {}),
  });
}

function toNotFoundError(message: string): McpOrchestrationError {
  return new McpOrchestrationError({
    code: "not_found",
    message,
  });
}

function isModelMcpEnabled(input: {
  readonly settings: ServerSettings;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}): boolean {
  const disabled = input.settings.mcpDisabledModelsByProvider[input.instanceId] ?? [];
  return !disabled.includes(input.model);
}

function modelOptionDescriptors(
  model: ServerProviderModel,
): ReadonlyArray<ProviderOptionDescriptor> {
  return model.capabilities?.optionDescriptors ?? [];
}

function isThreadIdleReady(thread: {
  readonly latestTurn?: { readonly state?: string | null } | null;
  readonly session?: {
    readonly activeTurnId?: string | null;
    readonly status?: string | null;
  } | null;
}): boolean {
  const latestRunning = thread.latestTurn?.state === "running";
  const hasActiveTurn =
    thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined;
  const sessionStatus = thread.session?.status ?? "idle";
  const sessionReady =
    thread.session === null || sessionStatus === "idle" || sessionStatus === "ready";
  return !latestRunning && !hasActiveTurn && sessionReady;
}

function makeCommandId(tag: string): CommandId {
  return CommandId.make(`mcp:${tag}:${randomUUID()}`);
}

function makeThreadId(): ThreadId {
  return ThreadId.make(`thread-${randomUUID()}`);
}

function makeProjectId(): ProjectId {
  return ProjectId.make(`project-${randomUUID()}`);
}

function makeMessageId(): MessageId {
  return MessageId.make(`message-${randomUUID()}`);
}

function randomHex(byteLength: number): string {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, byteLength * 2);
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
}

function searchTerms(query: string | undefined): ReadonlyArray<string> {
  const normalized = normalizeSearchQuery(query ?? "");
  if (!normalized) {
    return [];
  }
  return normalized.split(/\s+/).filter((term) => term.length > 0);
}

function scoreTermsAgainstValues(
  terms: ReadonlyArray<string>,
  values: ReadonlyArray<string>,
): number | null {
  if (terms.length === 0) {
    return 0;
  }

  let total = 0;
  for (const term of terms) {
    let bestScore: number | null = null;
    for (const value of values) {
      const score = scoreQueryMatch({
        value: normalizeSearchQuery(value),
        query: term,
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 35,
        fuzzyBase: 60,
      });
      if (score === null) continue;
      if (bestScore === null || score < bestScore) {
        bestScore = score;
      }
    }

    if (bestScore === null) {
      return null;
    }
    total += bestScore;
  }

  return total;
}

export const McpOrchestrationServiceLive = Layer.effect(
  McpOrchestrationService,
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const bootstrapDispatcher = yield* ThreadTurnStartBootstrapDispatcher;
    const providerRegistry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const serverSettings = yield* ServerSettingsService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const textGeneration = yield* TextGeneration;

    const currentIsoTimestamp = () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
      );

    const requireProject = Effect.fn("McpOrchestrationService.requireProject")(function* (
      projectId: ProjectId,
    ) {
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to read orchestration project.", error),
          ),
        );
      return yield* Option.match(project, {
        onNone: () =>
          Effect.fail(
            new McpOrchestrationError({
              code: "unknown_project",
              message: `Project '${projectId}' does not exist.`,
            }),
          ),
        onSome: Effect.succeed,
      });
    });

    const requireThreadDetail = Effect.fn("McpOrchestrationService.requireThreadDetail")(function* (
      threadId: ThreadId,
    ) {
      const thread = yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to read orchestration thread.", error),
          ),
        );
      return yield* Option.match(thread, {
        onNone: () =>
          Effect.fail(
            new McpOrchestrationError({
              code: "unknown_thread",
              message: `Thread '${threadId}' does not exist.`,
            }),
          ),
        onSome: (value) =>
          value.deletedAt === null
            ? Effect.succeed(value)
            : Effect.fail(
                new McpOrchestrationError({
                  code: "unknown_thread",
                  message: `Thread '${threadId}' does not exist.`,
                }),
              ),
      });
    });

    const requireIdleThread = Effect.fn("McpOrchestrationService.requireIdleThread")(function* (
      threadId: ThreadId,
    ) {
      const thread = yield* requireThreadDetail(threadId);
      if (!isThreadIdleReady(thread)) {
        return yield* new McpOrchestrationError({
          code: "non_idle_thread",
          message: `non_idle_thread: Thread '${threadId}' is not idle and cannot accept MCP write actions.`,
        });
      }
      return thread;
    });

    const loadProvidersAndSettings = () =>
      Effect.all({
        providers: providerRegistry.getProviders.pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to load provider registry snapshots.", error),
          ),
        ),
        settings: serverSettings.getSettings.pipe(
          Effect.mapError((error) => toInternalError("Failed to load server settings.", error)),
        ),
      });

    const findExistingProjectByWorkspaceRoot = Effect.fn(
      "McpOrchestrationService.findExistingProjectByWorkspaceRoot",
    )(function* (workspaceRoot: string) {
      const existing = yield* projectionSnapshotQuery
        .getActiveProjectByWorkspaceRoot(workspaceRoot)
        .pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to read orchestration projects.", error),
          ),
        );
      if (Option.isSome(existing)) {
        return existing.value;
      }

      const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
      const projects = yield* projectionSnapshotQuery
        .listProjectShells()
        .pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to read orchestration projects.", error),
          ),
        );
      return (
        projects.find(
          (project) =>
            normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot,
        ) ?? null
      );
    });

    const validateOptionSelections = (input: {
      readonly model: ServerProviderModel;
      readonly selection: {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
      };
    }): Effect.Effect<void, McpOrchestrationError> =>
      Effect.gen(function* () {
        const descriptorById = new Map(
          modelOptionDescriptors(input.model).map(
            (descriptor) => [descriptor.id, descriptor] as const,
          ),
        );
        for (const option of input.selection.options ?? []) {
          const descriptor = descriptorById.get(option.id);
          if (!descriptor) {
            return yield* new McpOrchestrationError({
              code: "invalid_model_option",
              message: `invalid_model_option: Option '${option.id}' is not supported by model '${input.selection.model}' on '${input.selection.instanceId}'.`,
            });
          }
          if (descriptor.type === "boolean") {
            if (typeof option.value !== "boolean") {
              return yield* new McpOrchestrationError({
                code: "invalid_model_option",
                message: `invalid_model_option: Option '${option.id}' requires a boolean value for model '${input.selection.model}'.`,
              });
            }
            continue;
          }
          if (
            typeof option.value !== "string" ||
            !descriptor.options.some((candidate) => candidate.id === option.value)
          ) {
            return yield* new McpOrchestrationError({
              code: "invalid_model_option",
              message: `invalid_model_option: Option '${option.id}' value '${String(option.value)}' is invalid for model '${input.selection.model}'.`,
            });
          }
        }
      });

    const validateMcpModelSelection = (selection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
    }) =>
      loadProvidersAndSettings().pipe(
        Effect.flatMap(({ providers, settings }) =>
          Effect.gen(function* () {
            const provider = providers.find(
              (candidate) => candidate.instanceId === selection.instanceId,
            );
            if (!provider || provider.enabled !== true || provider.installed === false) {
              return yield* new McpOrchestrationError({
                code: "unknown_provider_instance",
                message: `Provider instance '${selection.instanceId}' is not available.`,
              });
            }
            const model = provider.models.find((candidate) => candidate.slug === selection.model);
            if (!model) {
              return yield* new McpOrchestrationError({
                code: "unknown_model",
                message: `Model '${selection.model}' is not available on '${selection.instanceId}'.`,
              });
            }
            if (
              !isModelMcpEnabled({
                settings,
                instanceId: selection.instanceId,
                model: selection.model,
              })
            ) {
              return yield* new McpOrchestrationError({
                code: "mcp_disabled_model",
                message: `mcp_disabled_model: Model '${selection.model}' is disabled for MCP on '${selection.instanceId}'.`,
              });
            }
            yield* validateOptionSelections({ model, selection });
            return {
              provider,
              model,
            };
          }),
        ),
      );

    const resolveParentThreadId = (input: {
      readonly placement?: "child_of_current" | "top_level" | "child_of_thread" | undefined;
      readonly explicitParentThreadId?: ThreadId | undefined;
      readonly targetProjectId: ProjectId;
      readonly currentThread: OrchestrationThread;
    }): Effect.Effect<ThreadId | null, McpOrchestrationError> =>
      Effect.gen(function* () {
        const placement =
          input.placement ??
          (input.targetProjectId === input.currentThread.projectId
            ? "child_of_current"
            : "top_level");
        switch (placement) {
          case "top_level":
            return null;
          case "child_of_current":
            return input.currentThread.id;
          case "child_of_thread":
            if (!input.explicitParentThreadId) {
              return yield* new McpOrchestrationError({
                code: "missing_parent_thread",
                message: "parentThreadId is required for child_of_thread placement.",
              });
            }
            return input.explicitParentThreadId;
        }
      });

    const validateParentThreadProject = Effect.fn(
      "McpOrchestrationService.validateParentThreadProject",
    )(function* (input: {
      readonly parentThreadId: ThreadId | null;
      readonly targetProjectId: ProjectId;
    }) {
      if (input.parentThreadId === null) {
        return null;
      }
      const parentThread = yield* requireThreadDetail(input.parentThreadId);
      if (parentThread.projectId !== input.targetProjectId) {
        return yield* new McpOrchestrationError({
          code: "cross_project_parent",
          message: `cross_project_parent: Thread '${input.parentThreadId}' belongs to project '${parentThread.projectId}' and cannot parent a thread in project '${input.targetProjectId}'.`,
        });
      }
      return parentThread.id;
    });

    const validateSessionCompatibility = Effect.fn(
      "McpOrchestrationService.validateSessionCompatibility",
    )(function* (input: {
      readonly thread: OrchestrationThread;
      readonly desiredModelSelection: ModelSelection;
      readonly requestedModelSelection?: ModelSelection | undefined;
    }) {
      if (input.thread.session === null) {
        return;
      }
      const activeSession = yield* providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.find((session) => session.threadId === input.thread.id),
          ),
        );
      const currentInstanceId =
        activeSession?.providerInstanceId ??
        input.thread.session.providerInstanceId ??
        input.thread.modelSelection.instanceId;
      const currentModelSelection = resolveCurrentSessionModelSelectionForCompatibility({
        threadModelSelection: input.thread.modelSelection,
        currentInstanceId,
        activeSessionModel: activeSession?.model,
      });
      const providers = yield* providerRegistry.getProviders.pipe(
        Effect.mapError((error) =>
          toInternalError("Failed to load provider registry snapshots.", error),
        ),
      );
      const currentProvider = providers.find(
        (candidate) => candidate.instanceId === currentInstanceId,
      );
      const desiredProvider = providers.find(
        (candidate) => candidate.instanceId === input.desiredModelSelection.instanceId,
      );
      if (!currentProvider) {
        return yield* new McpOrchestrationError({
          code: "unknown_provider_instance",
          message: `Provider instance '${currentInstanceId}' is not available.`,
        });
      }
      if (!desiredProvider) {
        return yield* new McpOrchestrationError({
          code: "unknown_provider_instance",
          message: `Provider instance '${input.desiredModelSelection.instanceId}' is not available.`,
        });
      }
      const compatibilityDetail = validateProviderSessionModelSelectionCompatibility({
        threadId: input.thread.id,
        hasStartedSession: true,
        currentModelSelection,
        requestedModelSelection: input.requestedModelSelection,
        currentIdentity: {
          instanceId: currentInstanceId,
          driverKind: currentProvider.driver,
          continuationKey: currentProvider.continuation?.groupKey,
          requiresNewThreadForModelChange: currentProvider.requiresNewThreadForModelChange,
        },
        desiredIdentity: {
          instanceId: input.desiredModelSelection.instanceId,
          driverKind: desiredProvider.driver,
          continuationKey: desiredProvider.continuation?.groupKey,
          requiresNewThreadForModelChange: desiredProvider.requiresNewThreadForModelChange,
        },
      });
      if (compatibilityDetail !== null) {
        return yield* new McpOrchestrationError({
          code: "incompatible_model_session_switch",
          message: `incompatible_model_session_switch: ${compatibilityDetail}`,
        });
      }
    });

    return McpOrchestrationService.of({
      listMcpModels: () =>
        requireRead().pipe(
          Effect.flatMap(() =>
            Effect.all([
              providerRegistry.getProviders.pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to load provider registry snapshots.", error),
                ),
              ),
              serverSettings.getSettings.pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to load server settings.", error),
                ),
              ),
            ]),
          ),
          Effect.map(([providers, settings]) => ({
            providers: Object.fromEntries(
              providers
                .filter((provider) => provider.enabled)
                .map((provider) => [
                  provider.instanceId,
                  {
                    instanceId: provider.instanceId,
                    driver: provider.driver,
                    name: providerDisplayName(provider),
                    models: Object.fromEntries(
                      provider.models
                        .filter((model) =>
                          isModelMcpEnabled({
                            settings,
                            instanceId: provider.instanceId,
                            model: model.slug,
                          }),
                        )
                        .map((model) => [
                          model.slug,
                          {
                            slug: model.slug,
                            name: model.name,
                            isCustom: model.isCustom,
                            optionDescriptors: modelOptionDescriptors(model),
                          },
                        ]),
                    ),
                  },
                ]),
            ),
          })),
        ),
      listProjects: (input) =>
        requireRead().pipe(
          Effect.flatMap(() =>
            projectionSnapshotQuery
              .listProjectShells()
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to read orchestration projects.", error),
                ),
              ),
          ),
          Effect.map((projects) => {
            const terms = searchTerms(input.search);
            if (terms.length === 0) {
              return {
                projects,
              };
            }

            const ranked: Array<
              RankedSearchResult<{
                readonly id: (typeof projects)[number]["id"];
                readonly title: string;
                readonly workspaceRoot: string;
                readonly repositoryIdentity: (typeof projects)[number]["repositoryIdentity"];
                readonly defaultModelSelection: (typeof projects)[number]["defaultModelSelection"];
                readonly scripts: (typeof projects)[number]["scripts"];
                readonly createdAt: string;
                readonly updatedAt: string;
              }>
            > = [];

            for (const project of projects) {
              const score = scoreTermsAgainstValues(terms, [project.title, project.workspaceRoot]);
              if (score === null) continue;
              insertRankedSearchResult(
                ranked,
                {
                  item: {
                    id: project.id,
                    title: project.title,
                    workspaceRoot: project.workspaceRoot,
                    repositoryIdentity: project.repositoryIdentity,
                    defaultModelSelection: project.defaultModelSelection,
                    scripts: project.scripts,
                    createdAt: project.createdAt,
                    updatedAt: project.updatedAt,
                  },
                  score,
                  tieBreaker: `${project.createdAt}:${project.id}`,
                },
                projects.length,
              );
            }

            return {
              projects: ranked.map((entry) => entry.item),
            };
          }),
        ),
      listThreads: (input) =>
        requireRead().pipe(
          Effect.flatMap(() => {
            const archived = input.archived ?? "exclude";
            return projectionSnapshotQuery
              .listThreadShellsByProject({
                projectId: input.projectId,
                archived,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to read orchestration threads.", error),
                ),
                Effect.flatMap((threads) => {
                  const terms = searchTerms(input.search);
                  if (terms.length === 0) {
                    return Effect.succeed({ threads });
                  }

                  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));

                  return projectionSnapshotQuery
                    .searchThreadMessagesByProject({
                      projectId: input.projectId,
                      query: normalizeSearchQuery(input.search ?? ""),
                      archived,
                      limit: Math.max(threads.length, 1),
                    })
                    .pipe(
                      Effect.mapError((error) =>
                        toInternalError("Failed to search projected thread messages.", error),
                      ),
                      Effect.map((messageHits) => {
                        const rankedById = new Map<
                          string,
                          RankedSearchResult<(typeof threads)[number]>
                        >();

                        for (const thread of threads) {
                          const score = scoreTermsAgainstValues(terms, [thread.title]);
                          if (score === null) continue;
                          rankedById.set(thread.id, {
                            item: thread,
                            score,
                            tieBreaker: `${thread.createdAt}:${thread.id}`,
                          });
                        }

                        for (let index = 0; index < messageHits.length; index += 1) {
                          const hit = messageHits[index];
                          if (!hit) continue;
                          const thread = threadById.get(hit.threadId);
                          if (!thread) continue;

                          const candidate: RankedSearchResult<(typeof threads)[number]> = {
                            item: thread,
                            score: 500 + index,
                            tieBreaker: `${thread.createdAt}:${thread.id}`,
                          };
                          const existing = rankedById.get(thread.id);
                          if (!existing || candidate.score < existing.score) {
                            rankedById.set(thread.id, candidate);
                          }
                        }

                        const ranked = Array.from(rankedById.values());
                        ranked.sort((left, right) =>
                          left.score === right.score
                            ? left.tieBreaker.localeCompare(right.tieBreaker)
                            : left.score - right.score,
                        );

                        return {
                          threads: ranked.map((entry) => entry.item),
                        };
                      }),
                    );
                }),
              );
          }),
        ),
      getThreadHistory: (input) =>
        requireRead().pipe(
          Effect.flatMap(() =>
            projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to read orchestration thread history.", error),
              ),
              Effect.flatMap((detail) =>
                Option.match(detail, {
                  onNone: () =>
                    Effect.fail(
                      new McpOrchestrationError({
                        code: "unknown_thread",
                        message: `Thread '${input.threadId}' does not exist.`,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.flatMap(
                (thread): Effect.Effect<unknown, McpOrchestrationError> =>
                  Effect.gen(function* () {
                    if (input.mode === "complete") {
                      const history = yield* applyHistoryWindow(thread, input);
                      const payload = {
                        mode: "complete" as const,
                        thread: history,
                      };
                      const encoded = yield* encodeJsonString(payload).pipe(
                        Effect.mapError((error) =>
                          toInternalError("Failed to encode MCP thread history payload.", error),
                        ),
                      );
                      const budget = input.maxCharacters ?? MCP_STRUCTURED_RESPONSE_MAX_BYTES;
                      const encodedSize =
                        input.maxCharacters === undefined
                          ? Buffer.byteLength(encoded, "utf8")
                          : encoded.length;
                      if (encodedSize > budget) {
                        return yield* new McpOrchestrationError({
                          code: "payload_too_large",
                          message: `Thread '${input.threadId}' history is too large for one MCP response.`,
                          detail: "Retry with limit, cursor, or maxCharacters.",
                        });
                      }
                      return payload;
                    }

                    const settings = yield* serverSettings.getSettings.pipe(
                      Effect.mapError((error) =>
                        toInternalError("Failed to load server settings.", error),
                      ),
                    );
                    const summary = yield* textGeneration
                      .generateThreadSummary({
                        threadTitle: thread.title,
                        messages: thread.messages.map((message) => ({
                          role: message.role,
                          text: message.text,
                          createdAt: message.createdAt,
                        })),
                        maxOutputCharacters: 12_000,
                        modelSelection: settings.textGenerationModelSelection,
                      })
                      .pipe(
                        Effect.mapError((error) =>
                          toInternalError("Failed to generate thread history summary.", error),
                        ),
                      );
                    const now = yield* Clock.currentTimeMillis;

                    return {
                      mode: "summary" as const,
                      threadId: thread.id,
                      summary,
                      modelSelection: settings.textGenerationModelSelection,
                      generatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                    };
                  }),
              ),
            ),
          ),
        ),
      getCurrentThreadSettings: () =>
        requireRead().pipe(
          Effect.flatMap((invocation) =>
            projectionSnapshotQuery.getThreadDetailById(invocation.threadId).pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to read the current thread.", error),
              ),
              Effect.flatMap((option) =>
                Option.match(option, {
                  onNone: () => Effect.fail(toNotFoundError("Current MCP thread was not found.")),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.bindTo("thread"),
              Effect.bind("providers", () =>
                providerRegistry.getProviders.pipe(
                  Effect.mapError((error) =>
                    toInternalError("Failed to load provider registry snapshots.", error),
                  ),
                ),
              ),
              Effect.flatMap(({ thread, providers }) => {
                const provider = providers.find(
                  (candidate) => candidate.instanceId === thread.modelSelection.instanceId,
                );
                if (!provider) {
                  return Effect.fail(
                    toNotFoundError(
                      `Provider instance '${thread.modelSelection.instanceId}' for the current thread was not found.`,
                    ),
                  );
                }

                const model = provider.models.find(
                  (candidate) => candidate.slug === thread.modelSelection.model,
                );
                if (!model) {
                  return Effect.fail(
                    toNotFoundError(
                      `Model '${thread.modelSelection.model}' for the current thread was not found.`,
                    ),
                  );
                }

                const hydratedDescriptors = getProviderOptionDescriptors({
                  caps: model.capabilities ?? { optionDescriptors: [] },
                  selections: thread.modelSelection.options,
                });

                return Effect.succeed({
                  threadId: thread.id,
                  projectId: thread.projectId,
                  provider: {
                    instanceId: provider.instanceId,
                    driver: provider.driver,
                    name: providerDisplayName(provider),
                  },
                  model: {
                    slug: model.slug,
                    name: model.name,
                  },
                  options: (thread.modelSelection.options ?? []).map((selection) => {
                    const descriptor = hydratedDescriptors.find(
                      (candidate) => candidate.id === selection.id,
                    );
                    return {
                      id: selection.id,
                      value: selection.value,
                      label: descriptor?.label ?? selection.id,
                      ...(descriptor
                        ? {
                            valueLabel: getProviderOptionCurrentLabel(descriptor),
                          }
                        : {}),
                    };
                  }),
                  runtimeMode: thread.runtimeMode,
                  interactionMode: thread.interactionMode,
                  checkoutMode:
                    thread.branch !== null || thread.worktreePath !== null
                      ? "new_worktree"
                      : "current_checkout",
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                  session: thread.session,
                });
              }),
            ),
          ),
        ),
      addProject: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as { readonly path: string };
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const currentThread = yield* requireThreadDetail(invocation.threadId);
          const currentProject = yield* requireProject(currentThread.projectId);
          const platform = yield* HostProcessPlatform;
          const resolved = resolveAddProjectPath({
            rawPath: input.path,
            currentProjectCwd: currentProject.workspaceRoot,
            platform,
          });
          if (!resolved.ok) {
            return yield* new McpOrchestrationError({
              code: "invalid_project_path",
              message: resolved.error,
            });
          }

          const existing = yield* findExistingProjectByWorkspaceRoot(resolved.path);
          if (existing !== null) {
            return {
              status: "already_exists" as const,
              project: existing,
            };
          }

          const createdAt = yield* currentIsoTimestamp();
          const projectId = makeProjectId();
          const createCommand = buildProjectCreateCommand({
            commandId: makeCommandId("project-create"),
            projectId,
            workspaceRoot: resolved.path,
            createdAt,
          });
          const accepted = yield* orchestrationEngine
            .dispatch(createCommand)
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            status: "created" as const,
            project: {
              id: projectId,
              title: createCommand.title,
              workspaceRoot: createCommand.workspaceRoot,
              repositoryIdentity: null,
              defaultModelSelection: createCommand.defaultModelSelection,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
            },
            sequence: accepted.sequence,
          };
        }),
      createThread: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly projectId?: ProjectId;
            readonly placement?: "child_of_current" | "top_level" | "child_of_thread";
            readonly parentThreadId?: ThreadId;
            readonly title?: string;
            readonly message?: string;
            readonly modelSelection?: ModelSelection;
            readonly runtimeMode?: RuntimeMode;
            readonly interactionMode?: "default" | "plan";
            readonly checkoutMode?: "current_checkout" | "new_worktree";
            readonly branch?: string | null;
            readonly worktreePath?: string | null;
            readonly baseBranch?: string;
          };
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const currentThread = yield* requireThreadDetail(invocation.threadId);
          const targetProjectId = input.projectId ?? currentThread.projectId;
          const targetProject = yield* requireProject(targetProjectId);
          const desiredModelSelection = input.modelSelection ?? currentThread.modelSelection;
          yield* validateMcpModelSelection(desiredModelSelection);

          const parentThreadId = yield* resolveParentThreadId({
            placement: input.placement,
            explicitParentThreadId: input.parentThreadId,
            targetProjectId,
            currentThread,
          });
          yield* validateParentThreadProject({ parentThreadId, targetProjectId });

          const desiredRuntimeMode = input.runtimeMode ?? currentThread.runtimeMode;
          const desiredInteractionMode = input.interactionMode ?? currentThread.interactionMode;
          const isSameProjectTarget = targetProjectId === currentThread.projectId;
          const hasExplicitCheckoutMetadata =
            (input.branch ?? undefined) !== undefined ||
            (input.worktreePath ?? undefined) !== undefined;
          const desiredCheckoutMode =
            input.checkoutMode ??
            (hasExplicitCheckoutMetadata
              ? "new_worktree"
              : isSameProjectTarget &&
                  (currentThread.branch !== null || currentThread.worktreePath !== null)
                ? "new_worktree"
                : "current_checkout");
          const shouldPrepareWorktree =
            input.checkoutMode === "new_worktree" || input.baseBranch !== undefined;
          const desiredBranch =
            desiredCheckoutMode === "current_checkout"
              ? null
              : (input.branch ?? (isSameProjectTarget ? currentThread.branch : null) ?? null);
          const desiredWorktreePath =
            desiredCheckoutMode === "current_checkout"
              ? null
              : (input.worktreePath ??
                (isSameProjectTarget ? currentThread.worktreePath : null) ??
                null);
          const title = sanitizeThreadTitle(input.title ?? input.message ?? "New thread");
          const createdAt = yield* currentIsoTimestamp();
          const threadId = makeThreadId();
          const bootstrapBaseBranch = input.baseBranch;
          const createdThread = {
            id: threadId,
            projectId: targetProjectId,
            parentThreadId,
            title,
            modelSelection: desiredModelSelection,
            runtimeMode: desiredRuntimeMode,
            interactionMode: desiredInteractionMode,
            branch: desiredBranch,
            worktreePath: desiredWorktreePath,
            createdAt,
            updatedAt: createdAt,
            archivedAt: null,
            latestTurn: null,
            session: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          };

          if (!input.message) {
            const accepted = yield* orchestrationEngine
              .dispatch({
                type: "thread.create",
                commandId: makeCommandId("thread-create"),
                threadId,
                projectId: targetProjectId,
                parentThreadId,
                title,
                modelSelection: desiredModelSelection,
                runtimeMode: desiredRuntimeMode,
                interactionMode: desiredInteractionMode,
                branch: desiredBranch,
                worktreePath: desiredWorktreePath,
                createdAt,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              );
            return {
              status: "created" as const,
              threadId,
              thread: createdThread,
              sequence: accepted.sequence,
            };
          }

          if (shouldPrepareWorktree && !bootstrapBaseBranch) {
            return yield* new McpOrchestrationError({
              code: "missing_base_branch",
              message: `Thread '${threadId}' requires a baseBranch when checkoutMode is 'new_worktree' and a first message is supplied.`,
            });
          }

          const messageId = makeMessageId();
          const accepted = yield* bootstrapDispatcher
            .dispatch({
              type: "thread.turn.start",
              commandId: makeCommandId("thread-create-turn-start"),
              threadId,
              message: {
                messageId,
                role: "user",
                text: input.message,
                attachments: [],
              },
              modelSelection: desiredModelSelection,
              titleSeed: title,
              runtimeMode: desiredRuntimeMode,
              interactionMode: desiredInteractionMode,
              bootstrap: {
                createThread: {
                  projectId: targetProjectId,
                  parentThreadId,
                  title,
                  modelSelection: desiredModelSelection,
                  runtimeMode: desiredRuntimeMode,
                  interactionMode: desiredInteractionMode,
                  branch: desiredBranch,
                  worktreePath: desiredWorktreePath,
                  createdAt,
                },
                ...(shouldPrepareWorktree
                  ? {
                      prepareWorktree: {
                        projectCwd: targetProject.workspaceRoot,
                        baseBranch: bootstrapBaseBranch!,
                        branch: input.branch ?? buildTemporaryWorktreeBranchName(randomHex),
                      },
                      runSetupScript: true,
                    }
                  : {}),
              },
              createdAt,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            status: "accepted" as const,
            threadId,
            thread: createdThread,
            messageId,
            sequence: accepted.sequence,
          };
        }),
      sendThreadMessage: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly threadId: ThreadId;
            readonly message: string;
            readonly modelSelection?: ModelSelection;
          };
          const thread = yield* requireIdleThread(input.threadId);
          const desiredModelSelection = input.modelSelection ?? thread.modelSelection;
          yield* validateMcpModelSelection(desiredModelSelection);
          yield* validateSessionCompatibility({
            thread,
            desiredModelSelection,
            requestedModelSelection: input.modelSelection,
          });

          const messageId = makeMessageId();
          const createdAt = yield* currentIsoTimestamp();
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: makeCommandId("thread-turn-start"),
              threadId: input.threadId,
              message: {
                messageId,
                role: "user",
                text: input.message,
                attachments: [],
              },
              modelSelection: desiredModelSelection,
              titleSeed: thread.title,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            status: "accepted" as const,
            threadId: input.threadId,
            messageId,
            sequence: accepted.sequence,
          };
        }),
      updateThreadSettings: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly threadId: ThreadId;
            readonly modelSelection?: ModelSelection;
            readonly runtimeMode?: RuntimeMode;
            readonly interactionMode?: "default" | "plan";
            readonly checkoutMode?: "current_checkout" | "new_worktree";
            readonly branch?: string | null;
            readonly worktreePath?: string | null;
          };
          const thread = yield* requireIdleThread(input.threadId);
          const desiredModelSelection = input.modelSelection ?? thread.modelSelection;
          yield* validateMcpModelSelection(desiredModelSelection);
          yield* validateSessionCompatibility({
            thread,
            desiredModelSelection,
            requestedModelSelection: input.modelSelection,
          });

          const desiredRuntimeMode = input.runtimeMode ?? thread.runtimeMode;
          const desiredInteractionMode = input.interactionMode ?? thread.interactionMode;
          const desiredCheckoutMode =
            input.checkoutMode ??
            ((input.branch ?? undefined) !== undefined ||
            (input.worktreePath ?? undefined) !== undefined
              ? "new_worktree"
              : thread.branch !== null || thread.worktreePath !== null
                ? "new_worktree"
                : "current_checkout");
          const desiredBranch =
            desiredCheckoutMode === "current_checkout"
              ? null
              : (input.branch ?? thread.branch ?? null);
          const desiredWorktreePath =
            desiredCheckoutMode === "current_checkout"
              ? null
              : (input.worktreePath ?? thread.worktreePath ?? null);

          let lastSequence = 0;
          if (!Equal.equals(thread.modelSelection, desiredModelSelection)) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: makeCommandId("thread-meta-model"),
                threadId: input.threadId,
                modelSelection: desiredModelSelection,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (thread.runtimeMode !== desiredRuntimeMode) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.runtime-mode.set",
                commandId: makeCommandId("thread-runtime-mode"),
                threadId: input.threadId,
                runtimeMode: desiredRuntimeMode,
                createdAt: yield* currentIsoTimestamp(),
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (thread.interactionMode !== desiredInteractionMode) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.interaction-mode.set",
                commandId: makeCommandId("thread-interaction-mode"),
                threadId: input.threadId,
                interactionMode: desiredInteractionMode,
                createdAt: yield* currentIsoTimestamp(),
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (thread.branch !== desiredBranch || thread.worktreePath !== desiredWorktreePath) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: makeCommandId("thread-meta-workspace"),
                threadId: input.threadId,
                branch: desiredBranch,
                worktreePath: desiredWorktreePath,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }

          return {
            status: "updated" as const,
            threadId: input.threadId,
            sequence: lastSequence,
          };
        }),
    });
  }),
);
