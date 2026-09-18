import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-jev-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon Jev config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults Jev off when config is absent", async () => {
    const home = await createPaseoHome({ version: 1 });
    expect(loadConfig(home, { env: {} }).jev).toEqual({
      enabled: false,
      compact: true,
      toolAdmission: true,
      browserPolicy: false,
    });
  });

  test("loads Jev opt-in from persisted daemon config", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { jev: { enabled: true, browserPolicy: true } },
    });
    expect(loadConfig(home, { env: {} }).jev).toEqual({
      enabled: true,
      compact: true,
      toolAdmission: true,
      browserPolicy: true,
    });
  });
});
