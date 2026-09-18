import { describe, expect, it } from "vitest";

import { JevClient } from "./client.js";
import {
  collectCompactToolSnapshots,
  formatJevCompactStatus,
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
    expect(
      selectSnapshotsToScore([
        { itemId: "small", command: "a", resultChars: 400, resultHead: "a", isError: false },
        { itemId: "big", command: "b", resultChars: 9000, resultHead: "b", isError: false },
      ]).map((snapshot) => snapshot.itemId),
    ).toEqual(["big", "small"]);
  });
});
