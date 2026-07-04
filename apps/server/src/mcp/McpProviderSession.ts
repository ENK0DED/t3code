import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function isMcpProviderSessionLive(
  scope: Pick<
    McpProviderSessionConfig,
    "environmentId" | "threadId" | "providerSessionId" | "providerInstanceId"
  >,
): boolean {
  const session = sessionsByThread.get(scope.threadId);
  return (
    session !== undefined &&
    session.environmentId === scope.environmentId &&
    session.providerSessionId === scope.providerSessionId &&
    session.providerInstanceId === scope.providerInstanceId
  );
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
