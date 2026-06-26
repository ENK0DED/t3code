import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
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
    const providerRegistry = yield* ProviderRegistry;
    const serverSettings = yield* ServerSettingsService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

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
                projects: projects.map((project) => ({
                  id: project.id,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  defaultModelSelection: project.defaultModelSelection,
                  createdAt: project.createdAt,
                  updatedAt: project.updatedAt,
                })),
              };
            }

            const ranked: Array<
              RankedSearchResult<{
                readonly id: (typeof projects)[number]["id"];
                readonly title: string;
                readonly workspaceRoot: string;
                readonly defaultModelSelection: (typeof projects)[number]["defaultModelSelection"];
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
                    defaultModelSelection: project.defaultModelSelection,
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

                  return projectionSnapshotQuery
                    .searchThreadMessagesByProject({
                      projectId: input.projectId,
                      query: normalizeSearchQuery(input.search ?? ""),
                      archived,
                      limit: Math.min(Math.max(threads.length, 20), 100),
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
                          const thread = threads.find((candidate) => candidate.id === hit.threadId);
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
      getThreadHistory: () => failNotImplemented("get_thread_history"),
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
      addProject: () => failNotImplemented("add_project"),
      createThread: () => failNotImplemented("create_thread"),
      sendThreadMessage: () => failNotImplemented("send_thread_message"),
      updateThreadSettings: () => failNotImplemented("update_thread_settings"),
    });
  }),
);
