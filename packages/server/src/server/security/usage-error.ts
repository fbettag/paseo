export type OrcaUsageSkipKind = "free" | "credits";

export class UsageSkipError extends Error {
  readonly kind: OrcaUsageSkipKind;

  constructor(kind: OrcaUsageSkipKind) {
    super(kind === "free" ? "out of free usage" : "out of credits");
    this.name = "UsageSkipError";
    this.kind = kind;
  }
}

export function classifyOrcaUsageSkip(error: unknown): OrcaUsageSkipKind | null {
  if (error instanceof UsageSkipError) return error.kind;
  const blob = flattenError(error).toLowerCase();
  if (blob.length === 0) return null;
  if (isFreeUsageBlob(blob)) return "free";
  if (isCreditsBlob(blob)) return "credits";
  return null;
}

function isFreeUsageBlob(blob: string): boolean {
  if (blob.includes("free_quota_exhausted")) return true;
  if (blob.includes("free_rate_limited")) return true;
  if (blob.includes("err_free_used")) return true;
  if (blob.includes("err_free_rate")) return true;
  if (blob.includes("err_free_access_denied")) return true;
  if (blob.includes("orcarouter/free allowance")) return true;
  if (blob.includes("allowance is used up") && blob.includes("orcarouter")) return true;
  return false;
}

function isCreditsBlob(blob: string): boolean {
  if (blob.includes("insufficient_user_quota")) return true;
  if (blob.includes("pre_consume_token_quota_failed")) return true;
  if (blob.includes("token quota is not enough")) return true;
  return false;
}

function flattenError(error: unknown): string {
  const parts: string[] = [];
  collectText(error instanceof Error ? error.message : error, parts, 0);
  return parts.join("\n");
}

function collectText(value: unknown, into: string[], depth: number): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    into.push(value);
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectText(JSON.parse(trimmed), into, depth + 1);
      } catch {
        return;
      }
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    into.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, into, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectText(nested, into, depth + 1);
  }
}
