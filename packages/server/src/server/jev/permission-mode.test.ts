import { describe, expect, it } from "vitest";
import { mapJevPermissionMode } from "./permission-mode.js";

const CLAUDE = [
  { id: "plan" },
  { id: "default" },
  { id: "acceptEdits" },
  { id: "auto" },
  { id: "bypassPermissions" },
];
const CODEX = [{ id: "auto" }, { id: "auto-review" }, { id: "full-access" }];

describe("mapJevPermissionMode", () => {
  it("maps bypass to the provider mode that skips prompts", () => {
    expect(mapJevPermissionMode("bypass", CLAUDE)).toBe("bypassPermissions");
    expect(mapJevPermissionMode("bypass", CODEX)).toBe("full-access");
    expect(mapJevPermissionMode("bypass", [])).toBeUndefined();
  });

  it("keeps ask and auto on the matching provider mode", () => {
    expect(mapJevPermissionMode("ask", CLAUDE)).toBe("default");
    expect(mapJevPermissionMode("ask", CODEX)).toBe("auto");
    expect(mapJevPermissionMode("auto", CLAUDE)).toBe("auto");
    expect(mapJevPermissionMode("auto", CODEX)).toBe("auto-review");
    expect(mapJevPermissionMode("acceptEdits", CLAUDE)).toBe("acceptEdits");
  });
});
