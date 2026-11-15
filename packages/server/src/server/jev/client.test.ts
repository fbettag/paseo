import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createJevClientFromEnv,
  JevClient,
  JevRequestError,
  noulAnswer,
  resolveJevApiKey,
} from "./client.js";

describe("Jev client", () => {
  it("reads the API key file only when a request is made", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jev-client-"));
    const keyFile = path.join(dir, "key");
    const client = new JevClient({
      env: { TYPESAFE_API_KEY_FILE: keyFile },
      fetch: async (_url, init) => {
        expect(init?.headers).toMatchObject({ authorization: "Bearer file-key" });
        return new Response(JSON.stringify({ answers: { keepResult: { noul: 0.4 } } }));
      },
    });
    await writeFile(keyFile, " file-key\n");
    const answers = await client.ask({
      state: "x",
      questions: { keepResult: { type: "noul", instructions: "Keep?" } },
    });
    expect(noulAnswer(answers, "keepResult")).toBe(0.4);
    await rm(dir, { recursive: true, force: true });
  });

  it("is unavailable without a key or a loopback endpoint", () => {
    expect(createJevClientFromEnv(undefined, {})).toBeNull();
    expect(
      createJevClientFromEnv(undefined, { PASEO_JEV_BASE_URL: "http://127.0.0.1:8787/v1" }),
    ).not.toBeNull();
  });

  it("returns no key for an unreadable key file", async () => {
    await expect(
      resolveJevApiKey({ apiKeyFile: "/nonexistent-jev-key-for-test" }),
    ).resolves.toBeNull();
  });

  it("asks Jev and returns answers", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      baseUrl: "https://jev.test/v1/systemone",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://jev.test/v1/systemone");
        expect(init).toMatchObject({
          method: "POST",
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
          },
        });
        return new Response(JSON.stringify({ answers: { keepResult: { noul: 0.81 } } }), {
          status: 200,
        });
      },
    });

    const answers = await client.ask({
      state: { tool: "browser_snapshot" },
      questions: { keepResult: { type: "noul", instructions: "Keep the full result?" } },
    });
    expect(noulAnswer(answers, "keepResult")).toBe(0.81);
  });

  it("asks a loopback OpenJev endpoint without an API key", async () => {
    const client = new JevClient({
      baseUrl: "http://127.0.0.1:8787/v1/systemone",
      apiKeyFile: "/nonexistent-jev-key-for-test",
      env: {},
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:8787/v1/systemone");
        expect(init?.headers).toEqual({ "content-type": "application/json" });
        return new Response(JSON.stringify({ answers: { keepResult: { noul: 0.6 } } }), {
          status: 200,
        });
      },
    });
    const answers = await client.ask({
      state: { tool: "jevgrep" },
      questions: { keepResult: { type: "noul", instructions: "Keep?" } },
    });
    expect(noulAnswer(answers, "keepResult")).toBe(0.6);
  });

  it("throws when Jev omits answers", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => new Response("{}", { status: 200 }),
    });
    await expect(
      client.ask({
        state: "x",
        questions: { keepResult: { type: "noul", instructions: "Keep?" } },
      }),
    ).rejects.toBeInstanceOf(JevRequestError);
  });
});
