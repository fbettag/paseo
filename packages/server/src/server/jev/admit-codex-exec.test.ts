import { describe, expect, it } from "vitest";

import {
  admitCodexExecOutput,
  admitCommandExecutionItem,
  combineCodexExecText,
} from "./admit-codex-exec.js";

describe("admitCodexExecOutput", () => {
  it("joins stdout and stderr", () => {
    expect(combineCodexExecText("out", "err")).toBe("out\nerr");
  });

  it("returns original output without an admit fn", async () => {
    await expect(
      admitCodexExecOutput(undefined, {
        command: "seq 1 800",
        output: "1\n2",
        isError: false,
      }),
    ).resolves.toEqual({ output: "1\n2" });
  });

  it("replaces output when Jev truncates", async () => {
    await expect(
      admitCodexExecOutput(
        async () => ({ decision: "truncate", text: "1\n[… omitted by Jev …]" }),
        { command: "seq 1 800", output: "1\n2\n3", isError: false },
      ),
    ).resolves.toEqual({ output: "1\n[… omitted by Jev …]" });
  });

  it("mutates commandExecution aggregatedOutput when truncated", async () => {
    const item: Record<string, unknown> = {
      type: "commandExecution",
      command: "seq 1 800",
      aggregatedOutput: "1\n2\n3",
    };
    await admitCommandExecutionItem(
      async () => ({ decision: "truncate", text: "truncated" }),
      item,
    );
    expect(item.aggregatedOutput).toBe("truncated");
  });

  it("keeps output when Jev keeps", async () => {
    await expect(
      admitCodexExecOutput(async () => ({ decision: "keep", text: "1\n2\n3", noul: 0.9 }), {
        command: "seq 1 800",
        output: "1\n2\n3",
        isError: false,
      }),
    ).resolves.toEqual({ output: "1\n2\n3" });
  });
});
