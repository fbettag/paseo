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

  it("lets a multi-provider fork's inner id choose the provider", () => {
    expect(resolveOpenCodeModel("qwen/glm-5.3", "pentestcode")).toEqual({
      providerID: "qwen",
      modelID: "glm-5.3",
    });
    expect(resolveOpenCodeModel("pentestcode/qwen/glm-5.3", "pentestcode")).toEqual({
      providerID: "qwen",
      modelID: "glm-5.3",
    });
    expect(resolveOpenCodeModel("orcarouter/kimi/kimi-k3", "pentestcode")).toEqual({
      providerID: "orcarouter",
      modelID: "kimi/kimi-k3",
    });
    // hunt wraps a plain OpenCode server that serves zai and orcarouter side by side.
    expect(resolveOpenCodeModel("zai/glm-5.3", "hunt")).toEqual({
      providerID: "zai",
      modelID: "glm-5.3",
    });
    expect(resolveOpenCodeModel("hunt/orcarouter/deepseek/deepseek-v4.1-flash", "hunt")).toEqual({
      providerID: "orcarouter",
      modelID: "deepseek/deepseek-v4.1-flash",
    });
  });

  it("unwraps a direct picker id without doubling the provider", () => {
    expect(resolveOpenCodeModel("orcarouter/tencent/hy4-preview", "orcarouter")).toEqual({
      providerID: "orcarouter",
      modelID: "tencent/hy4-preview",
    });
    expect(resolveOpenCodeModel("orcarouter/orcarouter/free", "orcarouter")).toEqual({
      providerID: "orcarouter",
      modelID: "orcarouter/free",
    });
    expect(resolveOpenCodeModel("blackbit/xiaomi_mimo_v2_6_flash", "blackbit")).toEqual({
      providerID: "blackbit",
      modelID: "xiaomi_mimo_v2_6_flash",
    });
  });
});
