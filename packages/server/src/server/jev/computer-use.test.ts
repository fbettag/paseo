import { describe, expect, it } from "vitest";
import {
  decisionFromComputerUseAnswers,
  refsInSnapshot,
  runComputerUse,
  type ComputerUsePage,
} from "./computer-use.js";

const SNAPSHOT = '- button "Save" [ref=@e1]\n- textbox "Name" [ref=@e2]';

describe("computer use decisions", () => {
  it("reads only refs that the snapshot published", () => {
    expect(refsInSnapshot(SNAPSHOT)).toEqual(["@e1", "@e2"]);
  });

  it("clicks a published element and refuses one that was not offered", () => {
    expect(
      decisionFromComputerUseAnswers(
        {
          operation: { choice: "click", confidence: 0.9 },
          target: { choice: "@e1" },
          risk: { noul: 0.1 },
        },
        ["@e1", "@e2"],
        undefined,
      ),
    ).toEqual({ status: "act", operation: "click", ref: "@e1" });
    expect(
      decisionFromComputerUseAnswers(
        {
          operation: { choice: "click", confidence: 0.9 },
          target: { choice: "@e9" },
          risk: { noul: 0.1 },
        },
        ["@e1"],
        undefined,
      ).status,
    ).toBe("blocked");
  });

  it("holds a risky action and asks for text before filling", () => {
    expect(
      decisionFromComputerUseAnswers(
        {
          operation: { choice: "click", confidence: 0.95 },
          target: { choice: "@e1" },
          risk: { noul: 0.8 },
        },
        ["@e1"],
        undefined,
      ).status,
    ).toBe("needs_approval");
    expect(
      decisionFromComputerUseAnswers(
        {
          operation: { choice: "fill", confidence: 0.9 },
          target: { choice: "@e2" },
          risk: { noul: 0.1 },
        },
        ["@e2"],
        undefined,
      ).status,
    ).toBe("needs_text");
  });

  it("runs a click and then stops when the goal is done", async () => {
    const clicks: string[] = [];
    const page: ComputerUsePage = {
      snapshot: async () => SNAPSHOT,
      click: async (ref) => {
        clicks.push(ref);
      },
      fill: async () => undefined,
      typeText: async () => undefined,
      scroll: async () => undefined,
      pressEnter: async () => undefined,
    };
    let turn = 0;
    const result = await runComputerUse({
      goal: "Save",
      maxSteps: 4,
      page,
      decide: async () => {
        turn += 1;
        if (turn === 1) return { status: "act", operation: "click", ref: "@e1" };
        return { status: "done" };
      },
    });
    expect(clicks).toEqual(["@e1"]);
    expect(result).toEqual({ status: "done", steps: ["click @e1", "done"] });
  });
});
