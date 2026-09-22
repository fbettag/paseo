import { JevClient, noulAnswer, type JevAnswers } from "./client.js";

export const COMPUTER_USE_MIN_CONFIDENCE = 0.55;
export const COMPUTER_USE_RISK_HOLD = 0.5;
export const COMPUTER_USE_MAX_REFS = 40;

const OPERATIONS = [
  "click",
  "fill",
  "type",
  "scroll_down",
  "scroll_up",
  "press_enter",
  "done",
  "blocked",
] as const;

export type ComputerUseOperation = (typeof OPERATIONS)[number];

export type ComputerUseDecision =
  | { status: "act"; operation: ComputerUseOperation; ref?: string }
  | { status: "done" }
  | { status: "blocked"; reason: string }
  | { status: "needs_text" }
  | { status: "needs_approval"; operation: ComputerUseOperation; ref?: string; risk: number }
  | { status: "low_confidence"; confidence: number };

export interface ComputerUsePage {
  snapshot(): Promise<string>;
  click(ref: string): Promise<void>;
  fill(ref: string, value: string): Promise<void>;
  typeText(ref: string, text: string): Promise<void>;
  scroll(deltaY: number): Promise<void>;
  pressEnter(): Promise<void>;
}

export interface ComputerUseRunResult {
  status: string;
  steps: string[];
}

const REF_PATTERN = /\[ref=(@e\d+)\]/g;

export function refsInSnapshot(snapshot: string): string[] {
  const refs: string[] = [];
  for (const match of snapshot.matchAll(REF_PATTERN)) {
    const ref = match[1];
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs.slice(0, COMPUTER_USE_MAX_REFS);
}

export function decisionFromComputerUseAnswers(
  answers: JevAnswers,
  refs: readonly string[],
  text: string | undefined,
): ComputerUseDecision {
  const operationAnswer = answers.operation;
  const operation = operationAnswer && "choice" in operationAnswer ? operationAnswer.choice : "";
  const confidence =
    operationAnswer && "choice" in operationAnswer && typeof operationAnswer.confidence === "number"
      ? operationAnswer.confidence
      : 1;
  if (!isOperation(operation)) {
    return { status: "blocked", reason: "Jev returned an operation that was not offered." };
  }
  if (confidence < COMPUTER_USE_MIN_CONFIDENCE) {
    return { status: "low_confidence", confidence };
  }
  const risk = readRisk(answers);
  const target = readTarget(answers, refs);
  if (operation === "done") return { status: "done" };
  if (operation === "blocked") {
    return {
      status: "blocked",
      reason: "Jev stopped because the page does not offer the next step.",
    };
  }
  if (needsRef(operation) && !target) {
    return { status: "blocked", reason: "Jev chose an element that is not in the snapshot." };
  }
  if ((operation === "fill" || operation === "type") && !text?.trim()) {
    return { status: "needs_text" };
  }
  if (risk >= COMPUTER_USE_RISK_HOLD) {
    return { status: "needs_approval", operation, ref: target, risk };
  }
  return { status: "act", operation, ref: target };
}

export async function decideComputerUse(
  client: JevClient,
  input: { goal: string; snapshot: string; text?: string },
): Promise<ComputerUseDecision> {
  const refs = refsInSnapshot(input.snapshot);
  const criteria: Record<string, string> = {
    click: "Press a button, link, or control.",
    fill: "Replace the value of a field with the supplied text.",
    type: "Type the supplied text into a field.",
    scroll_down: "Move down the page.",
    scroll_up: "Move up the page.",
    press_enter: "Press Enter.",
    done: "The goal is already satisfied.",
    blocked: "The page does not offer a safe next step.",
  };
  const questions: Parameters<JevClient["ask"]>[0]["questions"] = {
    operation: {
      type: "choice",
      instructions: `Goal: ${input.goal.slice(0, 500)}. Which one next step matches this page?`,
      criteria,
    },
    risk: {
      type: "noul",
      instructions:
        "How risky is the next step, from 0 for a harmless click to 1 for sending, paying, deleting, or granting permission?",
    },
  };
  if (refs.length > 0) {
    const targetCriteria: Record<string, string> = { none: "No element is needed." };
    for (const ref of refs) targetCriteria[ref] = `Element ${ref} from the snapshot.`;
    questions.target = {
      type: "choice",
      instructions: "Which snapshot element should receive the action?",
      criteria: targetCriteria,
    };
  }
  const answers = await client.ask({
    state: { goal: input.goal.slice(0, 500), page: input.snapshot.slice(0, 6000) },
    questions,
  });
  return decisionFromComputerUseAnswers(answers, refs, input.text);
}

export async function runComputerUse(input: {
  goal: string;
  text?: string;
  maxSteps: number;
  decide: (step: { goal: string; snapshot: string; text?: string }) => Promise<ComputerUseDecision>;
  page: ComputerUsePage;
}): Promise<ComputerUseRunResult> {
  const steps: string[] = [];
  const limit = Math.min(Math.max(input.maxSteps, 1), 16);
  for (let index = 0; index < limit; index += 1) {
    const snapshot = await input.page.snapshot();
    const decision = await input.decide({ goal: input.goal, snapshot, text: input.text });
    if (decision.status === "done") {
      steps.push("done");
      return { status: "done", steps };
    }
    if (decision.status !== "act") {
      steps.push(decision.status);
      return { status: decision.status, steps };
    }
    await perform(input.page, decision.operation, decision.ref, input.text);
    steps.push(formatStep(decision.operation, decision.ref));
  }
  return { status: "max_steps", steps };
}

async function perform(
  page: ComputerUsePage,
  operation: ComputerUseOperation,
  ref: string | undefined,
  text: string | undefined,
): Promise<void> {
  if (operation === "click" && ref) {
    await page.click(ref);
    return;
  }
  if (operation === "fill" && ref && text) {
    await page.fill(ref, text);
    return;
  }
  if (operation === "type" && ref && text) {
    await page.typeText(ref, text);
    return;
  }
  if (operation === "scroll_down") {
    await page.scroll(700);
    return;
  }
  if (operation === "scroll_up") {
    await page.scroll(-700);
    return;
  }
  if (operation === "press_enter") {
    await page.pressEnter();
  }
}

function formatStep(operation: ComputerUseOperation, ref: string | undefined): string {
  if (ref) return `${operation} ${ref}`;
  return operation;
}

function isOperation(value: string): value is ComputerUseOperation {
  return OPERATIONS.some((operation) => operation === value);
}

function needsRef(operation: ComputerUseOperation): boolean {
  return operation === "click" || operation === "fill" || operation === "type";
}

function readTarget(answers: JevAnswers, refs: readonly string[]): string | undefined {
  const answer = answers.target;
  const choice = answer && "choice" in answer ? answer.choice : "";
  if (!choice || choice === "none") return undefined;
  if (refs.includes(choice)) return choice;
  return undefined;
}

function readRisk(answers: JevAnswers): number {
  try {
    const risk = noulAnswer(answers, "risk");
    if (risk < 0) return 0;
    if (risk > 1) return 1;
    return risk;
  } catch {
    return 0;
  }
}
