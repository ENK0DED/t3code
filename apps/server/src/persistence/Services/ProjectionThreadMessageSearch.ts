import { MessageId, OrchestrationMessageRole, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadArchiveFilter = Schema.Literals(["exclude", "include", "only"]);
export type ProjectionThreadArchiveFilter = typeof ProjectionThreadArchiveFilter.Type;

export const SearchProjectionThreadMessagesInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.String,
  archived: ProjectionThreadArchiveFilter,
  limit: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(100)),
});
export type SearchProjectionThreadMessagesInput = typeof SearchProjectionThreadMessagesInput.Type;

export const ProjectionThreadMessageSearchHit = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  snippet: Schema.String,
  rank: Schema.Number,
  createdAt: Schema.String,
});
export type ProjectionThreadMessageSearchHit = typeof ProjectionThreadMessageSearchHit.Type;

export interface ProjectionThreadMessageSearchRepositoryShape {
  readonly searchByProject: (
    input: SearchProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessageSearchHit>, ProjectionRepositoryError>;
}

export class ProjectionThreadMessageSearchRepository extends Context.Service<
  ProjectionThreadMessageSearchRepository,
  ProjectionThreadMessageSearchRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadMessageSearch/ProjectionThreadMessageSearchRepository",
) {}
