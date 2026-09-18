import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { JevClient } from "./client.js";
import {
  applyDroppedOutputsToCodexRollout,
  collectCompactToolSnapshots,
  findCodexRolloutFile,
  formatJevCompactStatus,
  rewriteCodexRolloutFile,
  scoreCompactToolHistory,
  selectSnapshotsToScore,
  snapshotFromCommandExecutionItem,
} from "./compact-tool-history.js";

function longOutput(size: number): string {
  return "x".repeat(size);
}

describe("compact tool history", () => {
  it("ignores short and failed command executions", () => {
    expect(
      snapshotFromCommandExecutionItem({
        id: "short",
        aggregatedOutput: "tiny",
        command: "echo hi",
      }),
    ).toBeNull();
    expect(
      snapshotFromCommandExecutionItem({
        id: "failed",
        aggregatedOutput: longOutput(400),
        status: "failed",
        command: "false",
      }),
    ).toBeNull();
  });

  it("collects large successful dumps from thread turns", () => {
    const snapshots = collectCompactToolSnapshots([
      {
        items: [
          {
            id: "a",
            type: "commandExecution",
            command: "seq 1 800",
            aggregatedOutput: longOutput(400),
          },
          { id: "b", type: "agentMessage", content: "ok" },
        ],
      },
    ]);
    expect(snapshots).toEqual([
      expect.objectContaining({ itemId: "a", resultChars: 400, command: "seq 1 800" }),
    ]);
  });

  it("scores keep vs drop in one Jev ask", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            answers: {
              keep_me: { noul: 0.9 },
              drop_me: { noul: 0.1 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const score = await scoreCompactToolHistory(client, [
      { itemId: "keep_me", command: "rg foo", resultChars: 400, resultHead: "foo", isError: false },
      {
        itemId: "drop_me",
        command: "seq 1 800",
        resultChars: 3000,
        resultHead: "1",
        isError: false,
      },
    ]);
    expect(score).toMatchObject({ scored: 2, keep: 1, drop: 1, droppedChars: 3000 });
    expect(formatJevCompactStatus(score)).toContain("drop 1/2");
    expect(formatJevCompactStatus(score, { applied: true })).toContain("Codex history rewritten");
    expect(score.decisions).toEqual([
      expect.objectContaining({ itemId: "drop_me", noul: 0.1, decision: "drop" }),
      expect.objectContaining({ itemId: "keep_me", noul: 0.9, decision: "keep" }),
    ]);
    expect(
      selectSnapshotsToScore([
        { itemId: "small", command: "a", resultChars: 400, resultHead: "a", isError: false },
        { itemId: "big", command: "b", resultChars: 9000, resultHead: "b", isError: false },
      ]).map((snapshot) => snapshot.itemId),
    ).toEqual(["big", "small"]);
  });

  it("drops compact results below the keep threshold of 0.7", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: (async () =>
        new Response(JSON.stringify({ answers: { dump: { noul: 0.6 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const score = await scoreCompactToolHistory(client, [
      { itemId: "dump", command: "seq 1 800", resultChars: 3092, resultHead: "1", isError: false },
    ]);
    expect(score).toMatchObject({ scored: 1, keep: 0, drop: 1, droppedChars: 3092 });
  });

  it("rewrites dropped Codex rollout tool outputs and leaves kept ones", () => {
    const dump = `${"x".repeat(400)}\nUNIQUE_TAIL`;
    const jsonl = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_drop",
          name: "exec",
          input: 'const a = await tools.exec_command({"cmd":"seq 1 800"});',
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_drop",
          output: [
            { type: "input_text", text: "Script completed\n" },
            {
              type: "input_text",
              text: JSON.stringify({ chunk_id: "10db07", output: dump }),
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_keep",
          name: "exec",
          input: 'const b = await tools.exec_command({"cmd":"git rev-parse HEAD"});',
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_keep",
          output: "deadbeef",
        },
      }),
    ].join("\n");
    const result = applyDroppedOutputsToCodexRollout(jsonl, [
      {
        itemId: "exec-drop",
        command: "seq 1 800",
        resultChars: dump.length,
        noul: 0.2,
        decision: "drop",
      },
      {
        itemId: "exec-keep",
        command: "git rev-parse HEAD",
        resultChars: 8,
        noul: 0.9,
        decision: "keep",
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.text).toContain("omitted by Jev");
    expect(result.text).toContain("deadbeef");
    expect(result.text).not.toContain("UNIQUE_TAIL");
  });

  it("matches bash -lc wrappers to the inner Codex exec cmd", () => {
    const jsonl = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_wrap",
          name: "exec",
          input: 'const a = await tools.exec_command({"cmd":"seq 1 800"});',
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_wrap",
          output: "x".repeat(400),
        },
      }),
    ].join("\n");
    const result = applyDroppedOutputsToCodexRollout(jsonl, [
      {
        itemId: "exec-wrap",
        command: "/bin/bash -lc 'seq 1 800'",
        resultChars: 400,
        noul: 0.04,
        decision: "drop",
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.text).toContain("omitted by Jev");
  });

  it("finds a Codex rollout file by session id and rewrites it on disk", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jev-rollout-"));
    const sessionId = "01a0b4d3-da8f-7ef1-8848-505ee58abd04";
    const dir = path.join(root, "sessions", "2026", "09", "18");
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `rollout-2026-09-18T14-02-58-${sessionId}.jsonl`);
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_1",
            name: "shell",
            arguments: '{"command":"seq 1 800"}',
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_1",
            output: "x".repeat(500),
          },
        }),
      ].join("\n"),
    );
    expect(findCodexRolloutFile(root, sessionId)).toBe(filePath);
    const result = rewriteCodexRolloutFile(filePath, [
      {
        itemId: "exec-1",
        command: "seq 1 800",
        resultChars: 500,
        noul: 0.1,
        decision: "drop",
      },
    ]);
    expect(result.applied).toBe(1);
    expect(readFileSync(filePath, "utf8")).toContain("omitted by Jev");
  });
});
