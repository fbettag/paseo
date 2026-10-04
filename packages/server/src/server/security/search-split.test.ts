import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listSearchSlices, partitionSearchPaths } from "./search-split.js";

describe("partitionSearchPaths", () => {
  it("gives each worker a disjoint random slice that covers the tree", () => {
    const paths = ["a", "b", "c", "d", "e"];
    const buckets = partitionSearchPaths(paths, 2, seeded(7));
    expect(buckets).toHaveLength(2);
    const flat = buckets.flat();
    expect(flat).toHaveLength(paths.length);
    expect(new Set(flat)).toEqual(new Set(paths));
    expect(buckets[0]?.filter((path) => buckets[1]?.includes(path))).toEqual([]);
    expect(buckets[0]?.length).toBeGreaterThan(0);
    expect(buckets[1]?.length).toBeGreaterThan(0);
  });
});

describe("listSearchSlices", () => {
  it("descends until there are enough source paths and skips findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-security-slices-"));
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      await mkdir(join(root, "omarchy", "src", name), { recursive: true });
    }
    await mkdir(join(root, "omarchy", "findings"), { recursive: true });
    await writeFile(join(root, "omarchy", "findings", "old.md"), "old");
    await mkdir(join(root, "omarchy", "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, "firecracker", "src", "jailer"), { recursive: true });

    const slices = await listSearchSlices(root, ["omarchy/", "engagements/omarchy/"], 2);
    expect(new Set(slices)).toEqual(
      new Set(["omarchy/src/alpha", "omarchy/src/beta", "omarchy/src/gamma", "omarchy/src/delta"]),
    );
    expect(await listSearchSlices(root, ["omarchy/"], 1)).toEqual([]);
    expect(await listSearchSlices(root, [], 4)).toEqual([]);
  });
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
