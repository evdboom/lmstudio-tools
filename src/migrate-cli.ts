#!/usr/bin/env node
import { migrateStoryRoot } from "./story-migrate.js";

/** `node dist/migrate-cli.js --root <stories> [--dry-run]` */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
  const dryRun = args.includes("--dry-run");

  if (!root) {
    console.error("Usage: migrate-cli --root <stories folder> [--dry-run]");
    process.exit(2);
  }

  const results = await migrateStoryRoot(root, { dryRun });
  if (results.length === 0) {
    console.log(`No story.json found beneath ${root}.`);
    return;
  }

  for (const result of results) {
    const detail = result.report
      ? `${result.report.beats} beats, ${result.report.scopedFacts} facts kept their beat pins or subjects`
      : result.detail ?? "";
    console.log(`${result.status.padEnd(11)} ${result.file}${detail ? `  (${detail})` : ""}`);
    // v2 never showed a fact no beat referenced; v3 will, from the first beat.
    if (result.report && result.report.unreferencedFacts.length > 0) {
      console.log(`            review: no beat referenced ${result.report.unreferencedFacts.join(", ")} — now always in scope`);
    }
  }

  const failed = results.filter((result) => result.status === "failed");
  if (dryRun) console.log("\nDry run: nothing was written.");
  else console.log("\nOriginals kept alongside each story as story.v2.json.");
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
