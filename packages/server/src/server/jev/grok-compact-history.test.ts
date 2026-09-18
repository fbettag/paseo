import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyDroppedOutputsToGrokChatHistory,
  collectGrokCompactSnapshots,
  findGrokChatHistoryFile,
  rewriteGrokChatHistoryFile,
} from "./grok-compact-history.js";

describe("grok compact history", () => {
  it("collects large tool results and rewrites dropped ones by call id", () => {
    const dump = `${"x".repeat(400)}\nUNIQUE_TAIL`;
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-drop",
            name: "run_terminal_command",
            arguments: '{"command":"seq 1 800"}',
          },
          {
            id: "call-keep",
            name: "read_file",
            arguments: '{"target_file":"README.md"}',
          },
        ],
      }),
      JSON.stringify({ type: "tool_result", tool_call_id: "call-drop", content: dump }),
      JSON.stringify({ type: "tool_result", tool_call_id: "call-keep", content: "short" }),
    ].join("\n");
    const snapshots = collectGrokCompactSnapshots(jsonl);
    expect(snapshots).toEqual([
      expect.objectContaining({
        itemId: "call-drop",
        command: expect.stringContaining("seq 1 800"),
        resultChars: dump.length,
      }),
    ]);
    const result = applyDroppedOutputsToGrokChatHistory(jsonl, [
      {
        itemId: "call-drop",
        command: "run_terminal_command seq 1 800",
        resultChars: dump.length,
        noul: 0.1,
        decision: "drop",
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.text).toContain("omitted by Jev");
    expect(result.text).not.toContain("UNIQUE_TAIL");
    expect(result.text).toContain("short");
  });

  it("finds a Grok chat_history.jsonl by session id", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jev-grok-"));
    const sessionId = "01a0b4d3-da8f-7ef1-8848-505ee58abd04";
    const dir = path.join(root, "sessions", "%2Ftmp", sessionId);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "chat_history.jsonl");
    writeFileSync(
      filePath,
      JSON.stringify({
        type: "tool_result",
        tool_call_id: "call-1",
        content: "x".repeat(500),
      }),
    );
    expect(findGrokChatHistoryFile(root, sessionId)).toBe(filePath);
    const result = rewriteGrokChatHistoryFile(filePath, [
      {
        itemId: "call-1",
        command: "tool",
        resultChars: 500,
        noul: 0.1,
        decision: "drop",
      },
    ]);
    expect(result.applied).toBe(1);
    expect(readFileSync(filePath, "utf8")).toContain("omitted by Jev");
  });
});
