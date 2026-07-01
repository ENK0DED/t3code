import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

export interface ProviderSessionCompatibilityIdentity {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey?: string | undefined;
  readonly requiresNewThreadForModelChange?: boolean | undefined;
}

export function resolveCurrentSessionModelSelectionForCompatibility(input: {
  readonly threadModelSelection: ModelSelection;
  readonly currentInstanceId: ProviderInstanceId;
  readonly activeSessionModel?: string | undefined;
}): ModelSelection {
  return input.activeSessionModel !== undefined
    ? {
        ...input.threadModelSelection,
        instanceId: input.currentInstanceId,
        model: input.activeSessionModel,
      }
    : input.threadModelSelection;
}

export function validateProviderSessionModelSelectionCompatibility(input: {
  readonly threadId: ThreadId;
  readonly hasStartedSession: boolean;
  readonly currentModelSelection: ModelSelection;
  readonly requestedModelSelection: ModelSelection | undefined;
  readonly currentIdentity: ProviderSessionCompatibilityIdentity;
  readonly desiredIdentity: ProviderSessionCompatibilityIdentity;
}): string | null {
  const requestedModelSelection = input.requestedModelSelection;
  if (!input.hasStartedSession || requestedModelSelection === undefined) {
    return null;
  }

  const requestedInstanceChanged =
    requestedModelSelection.instanceId !== input.currentIdentity.instanceId;
  const requestedModelChanged =
    input.currentModelSelection.instanceId !== requestedModelSelection.instanceId ||
    input.currentModelSelection.model !== requestedModelSelection.model;
  if (
    requestedModelChanged &&
    (input.currentIdentity.requiresNewThreadForModelChange === true ||
      input.desiredIdentity.requiresNewThreadForModelChange === true)
  ) {
    return `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`;
  }

  if (!requestedInstanceChanged) {
    return null;
  }

  if (input.currentIdentity.driverKind !== input.desiredIdentity.driverKind) {
    return `Thread '${input.threadId}' is bound to driver '${input.currentIdentity.driverKind}' and cannot switch to '${input.desiredIdentity.driverKind}'.`;
  }

  if (input.currentIdentity.continuationKey !== input.desiredIdentity.continuationKey) {
    return `Thread '${input.threadId}' cannot switch from instance '${input.currentIdentity.instanceId}' to '${input.desiredIdentity.instanceId}' because their provider resume state is incompatible.`;
  }

  return null;
}
