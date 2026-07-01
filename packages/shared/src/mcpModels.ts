export function isModelEnabledForMcp(input: {
  readonly mcpDisabledModelsByProvider: Readonly<Record<string, readonly string[]>>;
  readonly instanceId: string;
  readonly model: string;
}): boolean {
  return !(input.mcpDisabledModelsByProvider[input.instanceId] ?? []).includes(input.model);
}
