import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function readPaseoKey(name: string, paseoHome?: string): Promise<string | null> {
  const home = paseoHome?.trim() || process.env["PASEO_HOME"]?.trim() || join(homedir(), ".paseo");
  try {
    const value = (await fs.readFile(join(home, "keys", name), "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
