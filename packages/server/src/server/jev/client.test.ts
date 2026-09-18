import { describe, expect, it } from "vitest";

import { JevClient, JevRequestError, noulAnswer, resolveJevApiKey } from "./client.js";

describe("Jev client", () => {
  it("prefers an explicit API key over the environment", () => {
    expect(
      resolveJevApiKey({
        apiKey: " from-options ",
        env: { TYPESAFE_API_KEY: "from-env" },
      }),
    ).toBe("from-options");
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
