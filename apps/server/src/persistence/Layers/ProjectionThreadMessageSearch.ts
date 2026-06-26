import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

function toSnippetTerms(query: string): ReadonlyArray<string> {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', ""))
    .filter((term) => term.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSnippet(text: string, terms: ReadonlyArray<string>): string {
  if (text.length === 0) {
    return "";
  }

  const normalizedText = text.toLowerCase();
  const matches = terms
    .map((term) => ({ term, index: normalizedText.indexOf(term.toLowerCase()) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index);
  const firstMatch = matches[0];
  if (!firstMatch) {
    return text.length <= 96 ? text : `${text.slice(0, 93)}...`;
  }

  const start = Math.max(0, firstMatch.index - 36);
  const end = Math.min(text.length, firstMatch.index + firstMatch.term.length + 36);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  const fragment = text.slice(start, end);
  const highlighted = fragment.replace(
    new RegExp(escapeRegExp(firstMatch.term), "i"),
    (value) => `<mark>${value}</mark>`,
  );
  return `${prefix}${highlighted}${suffix}`;
}

const ProjectionThreadMessageSearchRow = Schema.Struct({
  threadId: ProjectionThreadMessageSearchHit.fields.threadId,
  messageId: ProjectionThreadMessageSearchHit.fields.messageId,
  role: ProjectionThreadMessageSearchHit.fields.role,
  text: Schema.String,
  rank: ProjectionThreadMessageSearchHit.fields.rank,
  createdAt: ProjectionThreadMessageSearchHit.fields.createdAt,
});

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
    Result: ProjectionThreadMessageSearchRow,
    execute: ({ projectId, query, archived, limit }) =>
      sql`
        SELECT
          ranked_matches."threadId" AS "threadId",
          ranked_matches."messageId" AS "messageId",
          ranked_matches."role" AS "role",
          ranked_matches."text" AS "text",
          ranked_matches."rank" AS "rank",
          ranked_matches."createdAt" AS "createdAt"
        FROM (
          SELECT
            messages.thread_id AS "threadId",
            messages.message_id AS "messageId",
            messages.role AS "role",
            messages.text AS "text",
            bm25(projection_thread_messages_fts) AS "rank",
            messages.created_at AS "createdAt",
            ROW_NUMBER() OVER (
              PARTITION BY messages.thread_id
              ORDER BY
                bm25(projection_thread_messages_fts) ASC,
                messages.created_at DESC,
                messages.message_id ASC
            ) AS "threadRowNumber"
          FROM projection_thread_messages_fts
          INNER JOIN projection_thread_messages AS messages
            ON messages.rowid = projection_thread_messages_fts.rowid
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          WHERE threads.project_id = ${projectId}
            AND threads.deleted_at IS NULL
            AND ${archivePredicate(archived)}
            AND projection_thread_messages_fts MATCH ${query}
        ) AS ranked_matches
        WHERE ranked_matches."threadRowNumber" = 1
        ORDER BY
          ranked_matches."rank" ASC,
          ranked_matches."createdAt" DESC,
          ranked_matches."messageId" ASC
        LIMIT ${limit}
      `,
  });

  const searchByProject: ProjectionThreadMessageSearchRepositoryShape["searchByProject"] = (
    input,
  ) => {
    const normalizedQuery = toFtsQuery(input.query);
    const snippetTerms = toSnippetTerms(input.query);
    if (normalizedQuery.length === 0) {
      return Effect.succeed([]);
    }

    return searchProjectionThreadMessageRows({
      ...input,
      query: normalizedQuery,
    }).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          threadId: row.threadId,
          messageId: row.messageId,
          role: row.role,
          snippet: buildSnippet(row.text, snippetTerms),
          rank: row.rank,
          createdAt: row.createdAt,
        })),
      ),
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
