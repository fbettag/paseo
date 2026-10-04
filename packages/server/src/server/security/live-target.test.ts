import { describe, expect, it } from "vitest";

import { campaignRunsLive } from "./live-target.js";

describe("campaignRunsLive", () => {
  it("keeps source audits parallel", () => {
    expect(campaignRunsLive("continue the firecracker source audit of reset paths")).toBe(false);
    expect(campaignRunsLive("read omarchy migrations line by line")).toBe(false);
  });

  it("runs live targets, daemons, vms, and chains one at a time", () => {
    expect(campaignRunsLive("evaluate against the remote target")).toBe(true);
    expect(campaignRunsLive("hit this against the daemon")).toBe(true);
    expect(campaignRunsLive("boot the vm and retry the payload")).toBe(true);
    expect(campaignRunsLive("chaining the reset bug into the balloon")).toBe(true);
  });
});
