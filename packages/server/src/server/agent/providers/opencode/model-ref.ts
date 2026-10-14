// Forks that expose several upstream providers behind one Paseo provider id.
// Their model ids already name the inner provider ("qwen/glm-5.3"), and the
// OpenCode server has no provider named after the fork itself, so using the
// fork id as the providerID produces an unresolvable three-segment reference
// ("pentestcode/qwen/glm-5.3"). Strip the fork prefix and let the inner id
// decide. Single-provider catalogs such as orcarouter and blackbit are the
// opposite case: there the catalog id *is* the providerID, and a second
// segment is a vendor path within that provider, not a provider of its own.
const MULTI_PROVIDER_FORKS = new Set(["pentestcode"]);

export function resolveOpenCodeModel(
  model: string | undefined,
  catalogProviderId?: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  if (catalogProviderId && MULTI_PROVIDER_FORKS.has(catalogProviderId)) {
    const prefix = `${catalogProviderId}/`;
    let inner = model;
    while (inner.startsWith(prefix)) inner = inner.slice(prefix.length);
    return resolveOpenCodeModel(inner);
  }
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
