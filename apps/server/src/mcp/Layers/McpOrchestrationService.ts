import {
  type OrchestrationThread,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  McpOrchestrationError,
  McpOrchestrationService,
} from "../Services/McpOrchestrationService.ts";

const MCP_STRUCTURED_RESPONSE_MAX_BYTES = 1_000_000;
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

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
    const textGeneration = yield* TextGeneration;

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
      addProject: () => failNotImplemented("add_project"),
      createThread: () => failNotImplemented("create_thread"),
      sendThreadMessage: () => failNotImplemented("send_thread_message"),
      updateThreadSettings: () => failNotImplemented("update_thread_settings"),
    });
  }),
);
