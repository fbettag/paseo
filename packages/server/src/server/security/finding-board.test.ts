import { describe, expect, it } from "vitest";

import {
  boardBuilderPrompt,
  boardEntryLines,
  boardLooksWritten,
  findingBoardStatus,
  renderFindingBoard,
} from "./finding-board.js";

describe("findingBoardStatus", () => {
  it("marks reported and chained findings and ignores reporting prose", () => {
    expect(findingBoardStatus("Status: reported\n\nSubmitted upstream.")).toBe("reported");
    expect(findingBoardStatus("# Reset\n\nChain: reset then balloon\n")).toBe("chained");
    expect(findingBoardStatus("Status: chained, reported\n\nChain: reset\n")).toBe(
      "chained, reported",
    );
    expect(findingBoardStatus("Kette: jailer to guest\n")).toBe("chained");
    expect(
      findingBoardStatus(
        "Status: source-only, no candidate above the reporting bar.\n\nThis is never reported.",
      ),
    ).toBe("open");
    expect(findingBoardStatus("Status: **CONFIRMED LIVE**\n")).toBe("open");
  });
});

describe("renderFindingBoard", () => {
  it("writes one fresh board and keeps the status on each line", () => {
    const rendered = renderFindingBoard([
      {
        status: "chained, reported",
        title: "Reset path leak",
        relativePath: "omarchy/research/review/findings/O-01.md",
      },
    ]);
    expect(boardLooksWritten(rendered)).toBe(true);
    expect(boardEntryLines(rendered)).toEqual([
      "chained, reported | Reset path leak | omarchy/research/review/findings/O-01.md",
    ]);
    expect(rendered).toContain("Do not rebuild this file.");
    const prompt = boardBuilderPrompt({
      boardPath: "/repo/.paseo/security-board-security-parent.md",
      scopes: ["omarchy/"],
      files: ["omarchy/research/review/findings/O-01.md"],
    });
    expect(prompt).toContain("chained, reported");
    expect(prompt).not.toContain("Submitted upstream");
  });
});
