import { join } from "node:path";

export interface LedgerFinding {
  title: string;
  relativePath: string;
  providerId?: string;
  modelId?: string;
}

const PROMPT_LEDGER_LIMIT = 30;

export function ledgerPathFor(cwd: string, agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return join(cwd, ".paseo", `security-ledger-${safe || "campaign"}.md`);
}

export function ledgerLines(findings: readonly LedgerFinding[]): string[] {
  return findings.slice(0, PROMPT_LEDGER_LIMIT).map((finding) => formatLedgerLine(finding));
}

export function renderFindingLedger(findings: readonly LedgerFinding[]): string {
  const lines = [
    "# Already filed",
    "Do not write another finding for an issue listed here.",
    "",
    ...findings.map((finding) => `- ${formatLedgerLine(finding)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function formatLedgerLine(finding: LedgerFinding): string {
  const model = [finding.providerId, finding.modelId].filter(Boolean).join("/");
  const who = model.length > 0 ? ` | ${model}` : "";
  return `${finding.title}${who} | ${finding.relativePath}`;
}
