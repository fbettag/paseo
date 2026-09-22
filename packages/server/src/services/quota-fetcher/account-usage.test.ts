import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extraCodexUsageFetchers } from "./codex-accounts.js";
import { QwenQuotaProvider } from "./providers/qwen.js";
import { ZaiQuotaProvider } from "./providers/zai.js";

function logger() {
  const sink = {
    debug: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    child: () => sink,
  };
  return sink as never;
}

describe("account usage sources", () => {
  it("reads the GLM key file and treats a missing subscription as spent", async () => {
    const previousZai = process.env["ZAI_API_KEY"];
    const previousGlm = process.env["GLM_API_KEY"];
    delete process.env["ZAI_API_KEY"];
    delete process.env["GLM_API_KEY"];
    const home = join(tmpdir(), `paseo-glm-${Date.now()}`);
    mkdirSync(join(home, "keys"), { recursive: true });
    writeFileSync(join(home, "keys", "glm"), "glm-key\n");
    let authorization = "";
    const provider = new ZaiQuotaProvider({
      logger: logger(),
      paseoHome: home,
      fetch: (async (_url, init) => {
        const headers = init?.headers;
        if (headers && typeof headers === "object" && "Authorization" in headers) {
          const value = headers.Authorization;
          authorization = typeof value === "string" ? value : "";
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });

    const usage = await provider.fetchUsage();

    expect(authorization).toBe("Bearer glm-key");
    expect(usage.windows[0]).toMatchObject({ usedPct: 100 });
    if (previousZai === undefined) delete process.env["ZAI_API_KEY"];
    else process.env["ZAI_API_KEY"] = previousZai;
    if (previousGlm === undefined) delete process.env["GLM_API_KEY"];
    else process.env["GLM_API_KEY"] = previousGlm;
  });

  it("blocks Qwen when the token plan rejects the key", async () => {
    const provider = new QwenQuotaProvider({
      logger: logger(),
      fetch: (async () => new Response("subscription inactive", { status: 403 })) as typeof fetch,
    });
    const previous = process.env["QWEN_API_KEY"];
    process.env["QWEN_API_KEY"] = "qwen-key";
    try {
      const usage = await provider.fetchUsage();
      expect(usage.status).toBe("available");
      expect(usage.windows[0]?.usedPct).toBe(100);
    } finally {
      if (previous === undefined) delete process.env["QWEN_API_KEY"];
      else process.env["QWEN_API_KEY"] = previous;
    }
  });

  it("adds a usage fetcher for a second Codex home", async () => {
    const fetchers = extraCodexUsageFetchers(
      {
        "codex-work": {
          extends: "codex",
          label: "Codex (Work)",
          env: { CODEX_HOME: "/tmp/codex-work" },
        },
        codex: { extends: "codex", env: { CODEX_HOME: "/tmp/default" } },
      },
      { logger: logger() },
    );
    expect(fetchers.map((fetcher) => fetcher.providerId)).toEqual(["codex-work"]);
    expect(fetchers[0]?.displayName).toBe("Codex (Work)");
  });
});
