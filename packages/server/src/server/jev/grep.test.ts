import { describe, expect, it } from "vitest";

import {
  formatJevGrepResult,
  looksLikeLiteralGrepQuery,
  searchWithJev,
  type JevGrepAsker,
  type JevGrepFs,
} from "./grep.js";

function memoryFs(tree: Record<string, string | Record<string, unknown>>): JevGrepFs {
  function nodeAt(path: string): unknown {
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    let current: unknown = tree;
    for (const part of parts) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  return {
    async readdir(path) {
      const node = path === "/" || path === "" ? tree : nodeAt(path);
      if (typeof node !== "object" || node === null) return [];
      return Object.entries(node as Record<string, unknown>).map(([name, value]) => ({
        name,
        kind: typeof value === "string" ? "file" : "directory",
      }));
    },
    async readFile(path) {
      const node = nodeAt(path);
      return typeof node === "string" ? node : null;
    },
  };
}

function askerFromScores(scores: Record<string, number>): JevGrepAsker {
  return {
    async ask(params) {
      const answers: Record<string, { noul: number }> = {};
      const items = Array.isArray((params.state as { items?: Array<{ path: string }> }).items)
        ? (params.state as { items: Array<{ path: string }> }).items
        : [];
      for (const [index, item] of items.entries()) {
        answers[`q${index}`] = { noul: scores[item.path] ?? 0 };
      }
      return answers;
    },
  };
}

describe("jevgrep", () => {
  it("treats behavior questions as semantic and identifiers as literal", () => {
    expect(looksLikeLiteralGrepQuery("Where is authentication checked before a handler?")).toBe(
      false,
    );
    expect(looksLikeLiteralGrepQuery("shouldAutoContinue")).toBe(true);
    expect(looksLikeLiteralGrepQuery("toolAdmissionEnabled")).toBe(true);
  });

  it("keeps useful files and skips unrelated directories", async () => {
    const fs = memoryFs({
      src: {
        "auth.ts": "export function checkAuth(req) { return req.user; }",
        "noise.ts": "export function formatDate() { return 'ok'; }",
      },
      vendor: {
        "lib.ts": "export const unused = 1;",
      },
      "README.md": "docs",
    });
    const result = await searchWithJev({
      query: "Where is authentication checked before a handler?",
      root: "/",
      fs,
      ask: askerFromScores({
        src: 0.9,
        vendor: 0.1,
        "README.md": 0.1,
        "src/auth.ts": 0.86,
        "src/noise.ts": 0.1,
      }),
    });
    expect(result.files.map((file) => file.path)).toEqual(["src/auth.ts"]);
    expect(result.files[0]?.excerpt).toContain("checkAuth");
    expect(result.status).toBe("complete");
  });

  it("formats ranked files with excerpts", () => {
    const text = formatJevGrepResult({
      query: "Where is auth checked?",
      root: "/repo",
      status: "complete",
      asks: 2,
      files: [{ path: "src/auth.ts", score: 0.86, excerpt: "export function checkAuth() {}" }],
    });
    expect(text).toContain("Jevgrep: Where is auth checked?");
    expect(text).toContain("src/auth.ts (0.86)");
    expect(text).toContain("checkAuth");
    expect(text).toContain("End context.");
  });
});
