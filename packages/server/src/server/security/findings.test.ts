import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  countFindingFiles,
  listFindingFiles,
  parseFindingMarkdown,
  parseFindingPath,
  resolveFindingScopes,
  summarizeFindingFile,
} from "./findings.js";

describe("listFindingFiles", () => {
  it("counts files under any findings directory and skips node_modules and git", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-security-findings-"));
    await mkdir(join(root, "engagements", "acme", "out", "app.example", "findings", "xss"), {
      recursive: true,
    });
    await mkdir(join(root, "node_modules", "findings"), { recursive: true });
    await mkdir(join(root, ".git", "findings"), { recursive: true });
    await writeFile(
      join(root, "engagements", "acme", "out", "app.example", "findings", "xss", "note.md"),
      "xss",
    );
    await writeFile(
      join(root, "engagements", "acme", "out", "app.example", "findings", "xss", "poc.txt"),
      "poc",
    );
    await writeFile(join(root, "node_modules", "findings", "noise.md"), "nope");
    await writeFile(join(root, ".git", "findings", "noise.md"), "nope");
    await writeFile(join(root, "README.md"), "not a finding");

    const files = await listFindingFiles(root);
    expect(countFindingFiles(files)).toBe(2);
    expect(files.every((path) => path.includes(`${join("findings", "xss")}`))).toBe(true);

    const parsed = parseFindingPath(
      join(root, "engagements", "acme", "out", "app.example", "findings", "xss", "note.md"),
      root,
    );
    expect(parsed).toMatchObject({
      engagement: "acme",
      host: "app.example",
      class: "xss",
      fileName: "note.md",
    });
  });

  it("reads title, severity, and summary from markdown", () => {
    expect(
      parseFindingMarkdown(
        "# Reflected XSS\n\nSeverity: high\n\nChain: reset then balloon\n\nThe q parameter is reflected.",
      ),
    ).toEqual({
      title: "Reflected XSS",
      summary: "The q parameter is reflected.",
      severity: "high",
      chain: "reset then balloon",
    });
  });

  it("keeps a session on the targets named in its goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-security-scopes-"));
    await mkdir(join(root, "firecracker", "research", "review", "findings"), { recursive: true });
    await mkdir(join(root, "omarchy", "research", "review", "findings"), { recursive: true });
    await writeFile(join(root, "firecracker", "research", "review", "findings", "reset.md"), "# R");
    await writeFile(join(root, "omarchy", "research", "review", "findings", "O-14.md"), "# O");
    const scopes = resolveFindingScopes({
      topLevel: ["firecracker", "omarchy", "engagements"],
      engagements: ["firecracker"],
      text: "continue the omarchy source audit",
    });
    expect(scopes).toEqual(["omarchy/", "engagements/omarchy/"]);
    const files = await listFindingFiles(root, { scopes });
    expect(files.map((file) => file.endsWith("O-14.md"))).toEqual([true]);
    const closed = await listFindingFiles(root, { scopes: [] });
    expect(closed).toEqual([]);
  });

  it("summarizes a finding file on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-security-finding-card-"));
    const dir = join(root, "engagements", "acme", "out", "app.example", "findings", "xss");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "note.md");
    await writeFile(file, "# Cookie leak\n\nSession cookie is readable.\n");
    const card = await summarizeFindingFile(file, root);
    expect(card.title).toBe("Cookie leak");
    expect(card.summary).toContain("Session cookie");
    expect(card.class).toBe("xss");
  });
});
