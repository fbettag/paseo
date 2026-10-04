export function resolveOpenCodeModel(
  model: string | undefined,
  catalogProviderId?: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  if (catalogProviderId && catalogProviderId !== "opencode") {
    return {
      providerID: catalogProviderId,
      modelID: unwrapCatalogModel(model, catalogProviderId),
    };
  }
  const parts = model.split("/");
  if (parts.length >= 2) {
    return { providerID: parts[0] ?? "opencode", modelID: parts.slice(1).join("/") };
  }
  return { providerID: "opencode", modelID: model };
}

function unwrapCatalogModel(model: string, catalogProviderId: string): string {
  const prefix = `${catalogProviderId}/`;
  let current = model;
  while (current.startsWith(prefix)) {
    const rest = current.slice(prefix.length);
    // orcarouter/free and orcarouter/fusion are API ids. A picker id wraps
    // them again, or wraps a vendor id such as tencent/hy4-preview.
    if (!rest.includes("/") && catalogProviderId === "orcarouter") break;
    current = rest;
  }
  return current;
}
