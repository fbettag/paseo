import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { countFindingFiles, listFindingFiles } from "./findings.js";

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
  });
});
