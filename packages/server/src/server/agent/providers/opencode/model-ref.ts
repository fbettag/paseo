export function resolveOpenCodeModel(
  model: string | undefined,
  catalogProviderId?: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  if (catalogProviderId && catalogProviderId !== "opencode") {
    return { providerID: catalogProviderId, modelID: model };
  }
  const parts = model.split("/");
  if (parts.length >= 2) {
    return { providerID: parts[0] ?? "opencode", modelID: parts.slice(1).join("/") };
  }
  return { providerID: "opencode", modelID: model };
}
