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

  it("names a source finding from its comment instead of the banner", () => {
    const block = [
      "/*",
      " * Model of the aac AIF waiter retaining a context across sleep.",
      " *",
      " * Build:",
      " *   cc -O1 f160.c",
      " */",
      "",
      "#include <stdint.h>",
    ].join("\n");
    expect(parseFindingMarkdown(block).title).toBe(
      "Model of the aac AIF waiter retaining a context across sleep.",
    );

    const oneLine =
      "/* Model of read-only adlink ioctls reaching divide-by-zero and DMA setup. */\n\n#include <stdint.h>\n";
    expect(parseFindingMarkdown(oneLine).title).toBe(
      "Model of read-only adlink ioctls reaching divide-by-zero and DMA setup.",
    );
  });

  it("skips a source-commit banner and a git patch header", () => {
    const banner = [
      "/* -- source commits",
      " *",
      " * FreeBSD F-167 runtime probe: COMPAT_FREEBSD32 ptrace policy bypass.",
      " */",
    ].join("\n");
    expect(parseFindingMarkdown(banner).title).toBe(
      "FreeBSD F-167 runtime probe: COMPAT_FREEBSD32 ptrace policy bypass.",
    );

    const patch = [
      "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001",
      "From: Security Researcher <security@example.invalid>",
      "Date: Tue, 8 Sep 2026 00:00:00 +0000",
      "Subject: [PATCH] unix: serialize pathname socket bindings across vnode aliases",
      "",
    ].join("\n");
    expect(parseFindingMarkdown(patch).title).toBe(
      "unix: serialize pathname socket bindings across vnode aliases",
    );
  });

  it("uses the file name when a source file has no header comment", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-security-source-title-"));
    const dir = join(root, "freebsd", "poc", "findings");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "f161-mlx5-fwdump-copyout-race.c");
    await writeFile(file, "#include <stdint.h>\n\nstruct dump_state {\n  int copyout;\n};\n");
    const card = await summarizeFindingFile(file, root);
    expect(card.title).toBe("F161 mlx5 fwdump copyout race");
    expect(card.summary).not.toContain("#include");
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
