import { describe, expect, it } from "vitest";

import { admitPaseoToolResult } from "./admit-tool-result.js";
import { JevClient } from "./client.js";

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("admit Paseo tool results", () => {
  it("keeps short results without calling Jev", async () => {
    let called = false;
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => {
        called = true;
        return new Response(JSON.stringify({ answers: { keepResult: { noul: 0.1 } } }));
      },
    });
    const result = textResult("short");
    expect(await admitPaseoToolResult(client, { toolName: "list_agents", input: {}, result })).toBe(
      result,
    );
    expect(called).toBe(false);
  });

  it("truncates long results Jev says are stale", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => new Response(JSON.stringify({ answers: { keepResult: { noul: 0.12 } } })),
    });
    const result = await admitPaseoToolResult(client, {
      toolName: "browser_snapshot",
      input: { browserId: "1" },
      result: textResult("x".repeat(800)),
      truncateHeadChars: 20,
    });
    expect(result.content[0]?.text).toContain("chars omitted by Jev");
    expect(result.content[0]?.text?.startsWith("x".repeat(20))).toBe(true);
  });

  it("keeps the full result when Jev is unavailable", async () => {
    const original = textResult("y".repeat(800));
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => new Response("nope", { status: 503 }),
    });
    expect(
      await admitPaseoToolResult(client, {
        toolName: "browser_snapshot",
        input: {},
        result: original,
      }),
    ).toBe(original);
  });
});
