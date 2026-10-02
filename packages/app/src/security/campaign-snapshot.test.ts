import { describe, expect, it } from "vitest";
import { parseCampaignSnapshot } from "./campaign-snapshot";

describe("parseCampaignSnapshot", () => {
  it("accepts a live campaign payload", () => {
    const parsed = parseCampaignSnapshot({
      total: 2,
      queued: 1,
      running: 1,
      done: 0,
      skipped: 0,
      failed: 0,
      findingsCount: 1,
      complete: false,
      pace: "quiet",
      workers: [
        {
          key: "grok/grok-4.6#1",
          providerId: "grok",
          modelId: "grok-4.6",
          replica: 1,
          state: "running",
          findingsCount: 0,
          agentId: "child-1",
        },
        {
          key: "glm/glm-5.3-flash#1",
          providerId: "glm",
          modelId: "glm-5.3-flash",
          replica: 1,
          state: "queued",
          findingsCount: 0,
        },
      ],
      findings: [
        {
          path: "/repo/engagements/acme/out/app/findings/xss/note.md",
          relativePath: "engagements/acme/out/app/findings/xss/note.md",
          title: "Reflected XSS",
          summary: "q is reflected.",
          class: "xss",
        },
      ],
    });
    expect(parsed?.running).toBe(1);
    expect(parsed?.findings[0]?.title).toBe("Reflected XSS");
    expect(parsed?.workers[0]?.agentId).toBe("child-1");
  });

  it("rejects junk", () => {
    expect(parseCampaignSnapshot(null)).toBeNull();
    expect(parseCampaignSnapshot({ total: 1 })).toBeNull();
  });
});
