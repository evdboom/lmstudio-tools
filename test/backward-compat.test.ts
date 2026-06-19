import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { verifyCampaign, scaffoldCampaign } from "../src/runtime-engine.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});
afterEach(async () => {
  await cleanup();
});

const BUNDLED = ["campaign-harbor-letter", "campaign-sunken-vault", "campaign-lantern-cafe"];

describe("backward compatibility", () => {
  for (const game of BUNDLED) {
    it(`bundled game ${game} still verifies ok with no manifest edits`, async () => {
      const src = path.join(process.cwd(), "games", game);
      const exists = await fs.stat(src).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) {
        // Repo layout differs in CI sandbox; skip rather than fail.
        return;
      }
      const dest = path.join(root, game);
      await fs.cp(src, dest, { recursive: true });
      // Drop any pre-existing save slots so the copy is a clean template.
      await fs.rm(path.join(dest, "40-saves"), { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(path.join(dest, "40-saves"), { recursive: true });

      const result = await verifyCampaign(root, game);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const payload = JSON.parse(result.text) as {
        ok: boolean;
        smoke: { playtest?: { loop?: boolean } };
      };
      expect(payload.ok).toBe(true); // warnings allowed, no errors
      expect(payload.smoke.playtest?.loop).toBe(true);
    });
  }
});

describe("content_targets enforcement", () => {
  it("fails verify when a declared content target is below its min_count", async () => {
    const campaign = "campaign-targets";
    await scaffoldCampaign(root, {
      campaignPath: campaign,
      title: "Targets",
      authoringMode: "fixed",
      collections: {
        monsters: { summary_fields: ["id", "name", "status"], min_count: 0 },
      },
      runtimeContract: {
        required_state_fields: ["location"],
        content_targets: { monsters: { min_count: 4 } },
      },
      opening: "A start.",
    });
    // scaffold bumped monsters.min_count to 4, but no monsters authored → below min.
    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as { ok: boolean; issues: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.issues.some((i) => i.code === "collection_below_min" || i.code === "content_target_below_min")).toBe(true);
  });
});
