import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  type ProjectionThreadArchiveFilter as ProjectionThreadArchiveFilterType,
  ProjectionThreadMessageSearchHit,
  ProjectionThreadMessageSearchRepository,
  type ProjectionThreadMessageSearchRepositoryShape,
  SearchProjectionThreadMessagesInput,
} from "../Services/ProjectionThreadMessageSearch.ts";

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', '""'))
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(" ");
}

export const makeProjectionThreadMessageSearchRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const archivePredicate = (archived: ProjectionThreadArchiveFilterType) => {
    switch (archived) {
      case "exclude":
        return sql`threads.archived_at IS NULL`;
      case "only":
        return sql`threads.archived_at IS NOT NULL`;
      case "include":
        return sql`1 = 1`;
    }
  };

  const searchProjectionThreadMessageRows = SqlSchema.findAll({
    Request: SearchProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageSearchHit,
    execute: ({ projectId, query, archived, limit }) =>
      sql`
        SELECT
          projection_thread_messages_fts.thread_id AS "threadId",
          projection_thread_messages_fts.message_id AS "messageId",
          projection_thread_messages_fts.role AS "role",
          snippet(projection_thread_messages_fts, 3, '<mark>', '</mark>', '...', 12) AS "snippet",
          bm25(projection_thread_messages_fts) AS "rank",
          projection_thread_messages_fts.created_at AS "createdAt"
        FROM projection_thread_messages_fts
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = projection_thread_messages_fts.thread_id
        WHERE threads.project_id = ${projectId}
          AND threads.deleted_at IS NULL
          AND ${archivePredicate(archived)}
          AND projection_thread_messages_fts MATCH ${query}
        ORDER BY "rank" ASC, "createdAt" DESC, "messageId" ASC
        LIMIT ${limit}
      `,
  });

  const searchByProject: ProjectionThreadMessageSearchRepositoryShape["searchByProject"] = (
    input,
  ) => {
    const normalizedQuery = toFtsQuery(input.query);
    if (normalizedQuery.length === 0) {
      return Effect.succeed([]);
    }

    return searchProjectionThreadMessageRows({
      ...input,
      query: normalizedQuery,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageSearchRepository.searchByProject:query"),
      ),
    );
  };

  return {
    searchByProject,
  } satisfies ProjectionThreadMessageSearchRepositoryShape;
});

export const ProjectionThreadMessageSearchRepositoryLive = Layer.effect(
  ProjectionThreadMessageSearchRepository,
  makeProjectionThreadMessageSearchRepository,
);
