import {
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

export type PendingUserInputFields = ReadonlyArray<{
  readonly id: string;
  readonly header?: string | undefined;
  readonly question?: string | undefined;
  readonly options?: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
  }>;
  readonly multiSelect?: boolean | undefined;
}>;

export type PendingTurnRequest =
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly requestKind?: "command" | "file-read" | "file-change" | undefined;
      readonly requestType?: string | undefined;
      readonly detail?: string | undefined;
    }
  | {
      readonly kind: "user-input";
      readonly requestId: string;
      readonly prompt?: string | undefined;
      readonly fields: PendingUserInputFields;
    };

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

function activityDetailLower(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const detail = (payload as Record<string, unknown>).detail;
  return typeof detail === "string" ? detail.toLowerCase() : null;
}

function isStaleApprovalFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request"))
  );
}

function isStaleUserInputFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request"))
  );
}

function userInputFieldsFromPayload(payload: unknown): PendingUserInputFields {
  const questions =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).questions
      : undefined;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((question) => {
    if (typeof question !== "object" || question === null) {
      return [];
    }
    const record = question as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (id === null) {
      return [];
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option !== "object" || option === null) {
            return [];
          }
          const optionRecord = option as Record<string, unknown>;
          const label = typeof optionRecord.label === "string" ? optionRecord.label : null;
          if (label === null) {
            return [];
          }
          return [
            {
              label,
              ...(typeof optionRecord.description === "string"
                ? { description: optionRecord.description }
                : {}),
            },
          ];
        })
      : undefined;
    return [
      {
        id,
        ...(typeof record.header === "string" ? { header: record.header } : {}),
        ...(typeof record.question === "string" ? { question: record.question } : {}),
        ...(options ? { options } : {}),
        ...(typeof record.multiSelect === "boolean" ? { multiSelect: record.multiSelect } : {}),
      },
    ];
  });
}

export function derivePendingRequestsFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingTurnRequest> {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  const open = new Map<string, PendingTurnRequest>();

  for (const activity of ordered) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    const detail = activityDetailLower(activity.payload);

    switch (activity.kind) {
      case "approval.requested": {
        open.set(requestId, {
          kind: "approval",
          requestId,
          ...(payload.requestKind === "command" ||
          payload.requestKind === "file-read" ||
          payload.requestKind === "file-change"
            ? { requestKind: payload.requestKind }
            : {}),
          ...(typeof payload.requestType === "string" ? { requestType: payload.requestType } : {}),
          ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
        });
        break;
      }
      case "approval.resolved": {
        open.delete(requestId);
        break;
      }
      case "user-input.requested": {
        open.set(requestId, {
          kind: "user-input",
          requestId,
          ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
          fields: userInputFieldsFromPayload(activity.payload),
        });
        break;
      }
      case "user-input.resolved": {
        open.delete(requestId);
        break;
      }
      case "provider.approval.respond.failed": {
        if (isStaleApprovalFailure(detail)) {
          open.delete(requestId);
        }
        break;
      }
      case "provider.user-input.respond.failed": {
        if (isStaleUserInputFailure(detail)) {
          open.delete(requestId);
        }
        break;
      }
      default:
        break;
    }
  }

  return [...open.values()];
}

export function derivePendingRequestsForTurn(
  thread: OrchestrationThread,
  turnId: string,
): ReadonlyArray<PendingTurnRequest> {
  return derivePendingRequestsFromActivities(
    thread.activities.filter((activity) => activity.turnId === TurnId.make(turnId)),
  );
}
