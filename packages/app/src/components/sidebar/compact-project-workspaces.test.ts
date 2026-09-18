import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildCompactProjectWorkspaceTargets } from "./compact-project-workspaces";

function workspace(
  input: Pick<SidebarWorkspaceEntry, "workspaceKey" | "workspaceId"> &
    Partial<SidebarWorkspaceEntry>,
): SidebarWorkspaceEntry {
  return {
    serverId: "host-a",
    projectViewKey: "project-a",
    projectName: "Project A",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: input.workspaceId,
    title: null,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: false,
    archiveUnpushedCommitCount: 0,
    scripts: [],
    hasRunningScripts: false,
    scheduleId: null,
    ...input,
  };
}

describe("compact project workspace targets", () => {
  it("merges manual work and multiple schedules into one project target", () => {
    const oldWork = workspace({
      workspaceKey: "host-a:work-old",
      workspaceId: "work-old",
      statusEnteredAt: new Date("2026-08-24T10:00:00.000Z"),
    });
    const runningWork = workspace({
      workspaceKey: "host-a:work-new",
      workspaceId: "work-new",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    const oldRun = workspace({
      workspaceKey: "host-a:run-old",
      workspaceId: "run-old",
      scheduleId: "schedule-1",
      statusEnteredAt: new Date("2026-08-25T10:00:00.000Z"),
    });
    const runningRun = workspace({
      workspaceKey: "host-a:run-new",
      workspaceId: "run-new",
      scheduleId: "schedule-2",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-26T10:00:00.000Z"),
    });

    const targets = buildCompactProjectWorkspaceTargets({
      workspaces: [oldWork, runningWork, oldRun, runningRun],
      selection: null,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: "project:project-a",
      workspace: runningWork,
      statusBucket: "running",
      selected: false,
    });
  });

  it("navigates to the workspace that owns the aggregated status", () => {
    const selectedRun = workspace({
      workspaceKey: "host-a:run-old",
      workspaceId: "run-old",
      scheduleId: "schedule-1",
      statusEnteredAt: new Date("2026-08-25T10:00:00.000Z"),
    });
    const runningRun = workspace({
      workspaceKey: "host-a:run-new",
      workspaceId: "run-new",
      scheduleId: "schedule-1",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-26T10:00:00.000Z"),
    });

    const [target] = buildCompactProjectWorkspaceTargets({
      workspaces: [selectedRun, runningRun],
      selection: { serverId: "host-a", workspaceId: selectedRun.workspaceId },
    });

    expect(target).toMatchObject({
      workspace: runningRun,
      statusBucket: "running",
      selected: true,
    });
  });

  it("keeps the selected workspace when it owns the aggregated status", () => {
    const selectedRun = workspace({
      workspaceKey: "host-a:run-selected",
      workspaceId: "run-selected",
      scheduleId: "schedule-1",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-25T10:00:00.000Z"),
    });
    const olderRun = workspace({
      workspaceKey: "host-a:run-old",
      workspaceId: "run-old",
      scheduleId: "schedule-1",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-24T10:00:00.000Z"),
    });

    const [target] = buildCompactProjectWorkspaceTargets({
      workspaces: [selectedRun, olderRun],
      selection: { serverId: "host-a", workspaceId: selectedRun.workspaceId },
    });

    expect(target).toMatchObject({
      workspace: selectedRun,
      statusBucket: "running",
      selected: true,
    });
  });

  it.each(["needs_input", "failed"] as const)(
    "keeps manual %s visible while multiple schedules run",
    (statusBucket) => {
      const manual = workspace({
        workspaceKey: "host-a:manual",
        workspaceId: "manual",
        statusBucket,
      });
      const runs = ["schedule-1", "schedule-2"].map((scheduleId) =>
        workspace({
          workspaceKey: `host-a:${scheduleId}`,
          workspaceId: scheduleId,
          scheduleId,
          statusBucket: "running",
        }),
      );
      expect(
        buildCompactProjectWorkspaceTargets({ workspaces: [...runs, manual], selection: null }),
      ).toEqual([{ key: "project:project-a", workspace: manual, statusBucket, selected: false }]);
    },
  );

  it("groups old retained runs on first load before schedule ownership is reconciled", () => {
    const manual = workspace({ workspaceKey: "host-a:manual", workspaceId: "manual" });
    const oldRuns = ["old-run-1", "old-run-2"].map((workspaceId) =>
      workspace({ workspaceKey: `host-a:${workspaceId}`, workspaceId, scheduleId: null }),
    );
    const input = { workspaces: [manual, ...oldRuns], selection: null };
    const initialTargets = buildCompactProjectWorkspaceTargets(input);
    expect(initialTargets).toEqual([
      { key: "project:project-a", workspace: manual, statusBucket: "done", selected: false },
    ]);
    for (const run of oldRuns) {
      run.scheduleId = "restored-schedule";
    }
    expect(buildCompactProjectWorkspaceTargets(input)).toEqual(initialTargets);
  });

  it("keeps different projects separate", () => {
    const projectA = workspace({
      workspaceKey: "host-a:project-a",
      workspaceId: "project-a",
    });
    const projectB = workspace({
      workspaceKey: "host-a:project-b",
      workspaceId: "project-b",
      projectViewKey: "project-b",
    });

    expect(
      buildCompactProjectWorkspaceTargets({
        workspaces: [projectA, projectB],
        selection: null,
      }).map((target) => target.key),
    ).toEqual(["project:project-a", "project:project-b"]);
  });
});
