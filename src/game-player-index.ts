#!/usr/bin/env node
import { runGameServer } from "./game-index.js";

runGameServer("lmstudio-game-player", "player").catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});