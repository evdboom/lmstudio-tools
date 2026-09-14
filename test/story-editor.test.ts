import { describe, expect, it } from "vitest";
import { createReaderServer } from "../src/reader-server.js";
import { makeSandbox } from "./helpers.js";

const blueprint = {
  schema: "story-v3" as const,
  status: "draft" as const,
  title: "Harbor Lights",
  premise: "A keeper sees a second lighthouse offshore.",
  story_type: "mystery",
  default_narration_mode: "close",
  beat_budget: { min_words: 500, max_words: 500 },
  characters: [],
  locations: [{ id: "tower", name: "Tower", description: "A salt-streaked lighthouse.", details: [], states: [] }],
  narration_modes: [{ id: "close", perspective: "third-person limited", tense: "past", rules: ["Stay close to the keeper."] }],
  facts: [],
  beats: [{ id: "b01", location: "tower", characters: [], events: ["The second light answers her signal."], keywords: [], narration_rules: [] }],
};

describe("story editor API", () => {
  it("creates, lists, reads, and updates description-only stories", async () => {
    const sandbox = await makeSandbox();
    const app = await createReaderServer({ root: sandbox.root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    try {
      const created = await app.inject({ method: "PUT", url: "/api/editor/story", payload: { story_path: "stories/harbor", story: blueprint, create: true } });
      expect(created.statusCode).toBe(200);

      const listed = await app.inject({ method: "GET", url: "/api/editor/stories" });
      expect(listed.json()).toMatchObject({ stories: [{ path: "stories/harbor", title: "Harbor Lights", status: "draft", beats: 1 }] });

      const changed = { ...blueprint, status: "final" as const, title: "The Other Light" };
      const updated = await app.inject({ method: "PUT", url: "/api/editor/story", payload: { story_path: "stories/harbor", story: changed } });
      expect(updated.statusCode).toBe(200);

      const read = await app.inject({ method: "GET", url: "/api/editor/story?story_path=stories%2Fharbor" });
      expect(read.json()).toMatchObject({ story: { title: "The Other Light", status: "final" } });
    } finally {
      await app.close();
      await sandbox.cleanup();
    }
  });

  it("rejects broken references instead of saving them", async () => {
    const sandbox = await makeSandbox();
    const app = await createReaderServer({ root: sandbox.root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    try {
      const invalid = structuredClone(blueprint);
      invalid.beats[0].location = "missing";
      const response = await app.inject({ method: "PUT", url: "/api/editor/story", payload: { story_path: "stories/broken", story: invalid, create: true } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("unknown_location");
    } finally {
      await app.close();
      await sandbox.cleanup();
    }
  });
});
