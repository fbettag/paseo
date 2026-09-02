import { seedWorkspace } from "./seed-client";
import { projectEquivalenceViewKey } from "./project-view-key";

interface SidebarScheduleClient {
  scheduleCreate(input: {
    prompt: string;
    cadence: { type: "cron"; expression: string };
    target: {
      type: "new-agent";
      config: {
        provider: "mock";
        cwd: string;
        model: string;
        modeId: string;
        archiveOnFinish: false;
        isolation: "local";
      };
    };
    runOnCreate: false;
  }): Promise<{ schedule: { id: string } | null; error: string | null }>;
  scheduleRunOnce(input: { id: string }): Promise<{
    schedule: { runs: Array<{ workspaceId?: string | null }> } | null;
    error: string | null;
  }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

export interface CompactProjectWorkspaces {
  projectViewKey: string;
  repoPath: string;
  workspaceIds: string[];
  cleanup(): Promise<void>;
}

async function runScheduleOnce(client: SidebarScheduleClient, scheduleId: string): Promise<string> {
  const runResult = await client.scheduleRunOnce({ id: scheduleId });
  const workspaceId = runResult.schedule?.runs.at(-1)?.workspaceId;
  if (!workspaceId) throw new Error(runResult.error ?? "Scheduled run has no workspace");
  return workspaceId;
}

/**
 * Seeds a project with two ordinary workspaces and two retained schedule runs so
 * compact sidebar mode has both a work target and a schedule target to collapse.
 */
export async function seedCompactProjectWorkspaces(): Promise<CompactProjectWorkspaces> {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-compact-workspaces-" });
  try {
    const created = await seeded.client.createWorkspace({
      source: {
        kind: "directory",
        path: seeded.repoPath,
        projectId: seeded.projectId,
      },
      title: "Compact target",
    });
    if (!created.workspace) throw new Error(created.error ?? "Failed to create workspace");

    const scheduleClient = seeded.client as unknown as SidebarScheduleClient;
    const scheduleResult = await scheduleClient.scheduleCreate({
      prompt: "Nightly sync",
      cadence: { type: "cron", expression: "0 9 * * *" },
      target: {
        type: "new-agent",
        config: {
          provider: "mock",
          cwd: seeded.repoPath,
          model: "e2e-fast-stream",
          modeId: "load-test",
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      runOnCreate: false,
    });
    if (!scheduleResult.schedule) {
      throw new Error(scheduleResult.error ?? "Failed to create compact workspace schedule");
    }
    const scheduleId = scheduleResult.schedule.id;
    const scheduleWorkspaceIds = [
      await runScheduleOnce(scheduleClient, scheduleId),
      await runScheduleOnce(scheduleClient, scheduleId),
    ];

    return {
      projectViewKey: projectEquivalenceViewKey(seeded.projectKey),
      repoPath: seeded.repoPath,
      workspaceIds: [seeded.workspaceId, created.workspace.id, ...scheduleWorkspaceIds],
      cleanup: async () => {
        await scheduleClient.scheduleDelete({ id: scheduleId }).catch(() => undefined);
        await seeded.cleanup();
      },
    };
  } catch (error) {
    await seeded.cleanup();
    throw error;
  }
}
