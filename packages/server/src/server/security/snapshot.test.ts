import { describe, expect, it } from "vitest";

import { appendCampaignFindings, createCampaignSnapshot, patchCampaignWorker } from "./snapshot.js";

describe("campaign snapshot", () => {
  it("tallies queued workers then running and findings", () => {
    const snapshot = createCampaignSnapshot(
      [
        {
          key: "grok/grok-4.6#1",
          providerId: "grok",
          modelId: "grok-4.6",
          replica: 1,
        },
        {
          key: "glm/glm-5.3-flash#1",
          providerId: "glm",
          modelId: "glm-5.3-flash",
          replica: 1,
        },
      ],
      "quiet",
    );
    expect(snapshot).toMatchObject({
      total: 2,
      queued: 2,
      running: 0,
      complete: false,
      pace: "quiet",
    });
    const running = patchCampaignWorker(snapshot, "grok/grok-4.6#1", {
      state: "running",
      agentId: "child-1",
    });
    expect(running.running).toBe(1);
    expect(running.queued).toBe(1);
    const withFinding = appendCampaignFindings(running, [
      {
        path: "/repo/engagements/acme/out/app/findings/xss/note.md",
        relativePath: "engagements/acme/out/app/findings/xss/note.md",
        title: "XSS",
        summary: "reflected",
      },
    ]);
    expect(withFinding.findingsCount).toBe(1);
    expect(withFinding.findings[0]?.title).toBe("XSS");
    const duplicated = appendCampaignFindings(withFinding, [
      {
        path: "/repo/engagements/acme/out/app/findings/xss/note.md",
        relativePath: "engagements/acme/out/app/findings/xss/note.md",
        title: "XSS",
        summary: "reflected again",
        providerId: "glm",
        modelId: "glm-5.3-flash",
      },
    ]);
    expect(duplicated.findings).toHaveLength(1);
    expect(duplicated.findings[0]).toMatchObject({
      summary: "reflected again",
      providerId: "glm",
      modelId: "glm-5.3-flash",
    });
    const titled = appendCampaignFindings(duplicated, [
      {
        path: "/repo/engagements/acme/out/app/findings/xss/other.md",
        relativePath: "engagements/acme/out/app/findings/xss/other.md",
        title: "Reflected XSS in the search box",
        summary: "same bug",
        providerId: "grok",
        modelId: "grok-4.6",
      },
      {
        path: "/repo/engagements/acme/out/app/findings/xss/again.md",
        relativePath: "engagements/acme/out/app/findings/xss/again.md",
        title: "Reflected XSS in the search box",
        summary: "same bug, longer writeup from the second worker",
        providerId: "glm",
        modelId: "glm-5.3-flash",
      },
    ]);
    expect(titled.findings).toHaveLength(2);
    const collapsed = titled.findings.find((finding) => finding.title.includes("search box"));
    expect(collapsed?.summary).toContain("longer writeup");
    expect(collapsed?.alsoFoundBy).toEqual([
      {
        relativePath: "engagements/acme/out/app/findings/xss/other.md",
        providerId: "grok",
        modelId: "grok-4.6",
      },
    ]);
  });
});
