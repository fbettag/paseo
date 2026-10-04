import { describe, expect, it } from "vitest";
import {
  campaignKeepsParentActive,
  parseCampaignSnapshot,
  selectCampaignFindings,
} from "./campaign-snapshot";

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

  it("hides other targets, duplicates, and older findings until asked", () => {
    const parsed = parseCampaignSnapshot({
      total: 1,
      workers: [
        {
          key: "glm/glm-5.3-flash#1",
          providerId: "glm",
          modelId: "glm-5.3-flash",
          replica: 1,
          state: "running",
          findingsCount: 1,
        },
      ],
      findings: [
        {
          path: "/repo/firecracker/research/review/findings/reset.md",
          relativePath: "firecracker/research/review/findings/reset.md",
          title: "Reset",
          summary: "old",
        },
        {
          path: "/repo/omarchy/research/review/findings/O-14.md",
          relativePath: "omarchy/research/review/findings/O-14.md",
          title: "O-14",
          summary: "first",
          prior: true,
        },
        {
          path: "/repo/omarchy/research/review/findings/O-14.md",
          relativePath: "omarchy/research/review/findings/O-14.md",
          title: "O-14",
          summary: "again",
          providerId: "glm",
          modelId: "glm-5.3-flash",
        },
        {
          path: "/repo/firecracker/research/review/findings/reset.md",
          relativePath: "firecracker/research/review/findings/reset.md",
          title: "Reset",
          summary: "again",
        },
      ],
    });
    if (!parsed) throw new Error("expected a snapshot");
    expect(campaignKeepsParentActive(parsed)).toBe(true);
    const visible = selectCampaignFindings(parsed, { title: "omarchy" });
    expect(visible.map((finding) => finding.relativePath)).toEqual([
      "omarchy/research/review/findings/O-14.md",
    ]);
    expect(visible[0]?.summary).toBe("again");
    expect(visible[0]?.modelId).toBe("glm-5.3-flash");
    const withPrior = selectCampaignFindings(parsed, { title: "omarchy", includePrior: true });
    expect(withPrior).toHaveLength(1);
    const duplicatedTitle = parseCampaignSnapshot({
      total: 1,
      workers: [
        {
          key: "glm/glm-5.3-flash#1",
          providerId: "glm",
          modelId: "glm-5.3-flash",
          replica: 1,
          state: "completed",
          findingsCount: 2,
        },
      ],
      scopes: ["omarchy/"],
      findings: [
        {
          path: "/repo/omarchy/research/review/findings/reset-a.md",
          relativePath: "omarchy/research/review/findings/reset-a.md",
          title: "Reset path leak in the jailer",
          summary: "short",
          providerId: "grok",
          modelId: "grok-4.6",
        },
        {
          path: "/repo/omarchy/research/review/findings/reset-b.md",
          relativePath: "omarchy/research/review/findings/reset-b.md",
          title: "Reset path leak in the jailer",
          summary: "the longer writeup of the same leak",
          providerId: "glm",
          modelId: "glm-5.3-flash",
        },
      ],
    });
    if (!duplicatedTitle) throw new Error("expected a snapshot");
    const collapsed = selectCampaignFindings(duplicatedTitle, { title: "omarchy" });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.summary).toContain("longer writeup");
    expect(collapsed[0]?.alsoFoundBy?.[0]?.modelId).toBe("grok-4.6");
  });

  it("rejects junk", () => {
    expect(parseCampaignSnapshot(null)).toBeNull();
    expect(parseCampaignSnapshot({ total: 1 })).toBeNull();
  });
});
