import { describe, expect, it } from "vitest";

import { resolveOpenCodeModel } from "./model-ref.js";

describe("resolveOpenCodeModel", () => {
  it("keeps a builtin provider/model split", () => {
    expect(resolveOpenCodeModel("anthropic/claude-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
  });

  it("keeps a slashless builtin id on the opencode provider", () => {
    expect(resolveOpenCodeModel("mimo-v2.6-flash-free")).toEqual({
      providerID: "opencode",
      modelID: "mimo-v2.6-flash-free",
    });
  });

  it("does not split an extended provider model id again", () => {
    expect(resolveOpenCodeModel("xiaomi_mimo_v2_6_flash", "blackbit")).toEqual({
      providerID: "blackbit",
      modelID: "xiaomi_mimo_v2_6_flash",
    });
    expect(resolveOpenCodeModel("orcarouter/free", "orcarouter")).toEqual({
      providerID: "orcarouter",
      modelID: "orcarouter/free",
    });
  });
});
