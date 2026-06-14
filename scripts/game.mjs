// Thin CLI over the runtime engine so the game tools can be driven without
// LM Studio. Mimics what the lmstudio-game MCP servers expose.
//
// Usage (run from the repo root after `npm run build`):
//   node scripts/game.mjs verify <root> <campaign>
//   node scripts/game.mjs save-create <root> <campaign> <slotId> [label]
//   node scripts/game.mjs save-list <root> <campaign>
//   node scripts/game.mjs open <root> <campaign> [slot]
//   node scripts/game.mjs scene <root> <campaign> <slot> [focusCsv]
//   node scripts/game.mjs read <root> <campaign> <slot> <path> [property]
//   node scripts/game.mjs write <root> <campaign> <slot> <target> '<jsonPatch>' [mode]
//   node scripts/game.mjs commit <root> <campaign> <slot> '<jsonOptions>'
//   node scripts/game.mjs roll <notation> [reason]
//   node scripts/game.mjs rewind <root> <campaign> <slot> [toTurn]
//
// JSON args are passed as a single (single-quoted in PowerShell) argument.

import { promises as fs } from "node:fs";
import {
  gameOpen,
  gameScene,
  gameRead,
  gameWrite,
  gameCommit,
  gameRoll,
  gameRewind,
  verifyCampaign,
} from "../dist/runtime-engine.js";
import { createSaveSlot, listSaveSlots, runtimeCampaignPath } from "../dist/game.js";

function out(result) {
  if (result.ok) {
    console.log(result.text);
    process.exit(0);
  }
  console.error(`ERROR: ${result.error}`);
  process.exit(1);
}

async function main() {
  const [, , cmd, ...a] = process.argv;
  if (!cmd) {
    console.error("missing command");
    process.exit(2);
  }

  // Commands that need a root resolve it; `roll` does not.
  const resolveRoot = async (p) => fs.realpath(p);

  switch (cmd) {
    case "verify": {
      const root = await resolveRoot(a[0]);
      return out(await verifyCampaign(root, a[1]));
    }
    case "save-create": {
      const root = await resolveRoot(a[0]);
      return out(await createSaveSlot(root, a[1], { slotId: a[2], label: a[3] ?? a[2] }));
    }
    case "save-list": {
      const root = await resolveRoot(a[0]);
      return out(await listSaveSlots(root, a[1]));
    }
    case "open": {
      const root = await resolveRoot(a[0]);
      return out(await gameOpen(root, a[1], { saveSlot: a[2] }));
    }
    case "scene": {
      const root = await resolveRoot(a[0]);
      const focus = a[3] ? a[3].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      return out(await gameScene(root, runtimeCampaignPath(a[1], a[2]), { focus }));
    }
    case "read": {
      const root = await resolveRoot(a[0]);
      return out(await gameRead(root, runtimeCampaignPath(a[1], a[2]), a[3], a[4]));
    }
    case "write": {
      const root = await resolveRoot(a[0]);
      const patch = a[4] ? JSON.parse(a[4]) : {};
      return out(await gameWrite(root, runtimeCampaignPath(a[1], a[2]), a[3], patch, a[5] ?? "merge"));
    }
    case "commit": {
      const root = await resolveRoot(a[0]);
      const opts = a[3] ? JSON.parse(a[3]) : {};
      return out(await gameCommit(root, runtimeCampaignPath(a[1], a[2]), {
        summary: opts.summary,
        statePatch: opts.state_patch,
        journal: opts.journal,
        incrementTurn: opts.increment_turn,
      }));
    }
    case "roll": {
      return out(gameRoll(a[0] ?? "1d20", a[1]));
    }
    case "rewind": {
      const root = await resolveRoot(a[0]);
      return out(await gameRewind(root, runtimeCampaignPath(a[1], a[2]), a[3] ? Number(a[3]) : undefined));
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e?.message ?? e}`);
  process.exit(1);
});
