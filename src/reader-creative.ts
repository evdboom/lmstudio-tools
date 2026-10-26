import { iterationFocuses, taggedReasoningRule, type NarrationRequest } from "./reader-prompts.js";
import { mutateReaderRun, readReaderRun, type ReaderRun } from "./reader-store.js";

export function creativeContext(run: ReaderRun, before = run.beat_index): string {
  const history = run.accepted.filter((scene) => scene.beat_index < before);
  const proseStart = Math.max(0, history.length - run.prose_window);
  const recap = run.recap && run.recap.through < before ? run.recap : undefined;
  return [
    "# Premise", run.premise ?? "",
    ...(run.narration_rules ? ["# Narration rules", run.narration_rules,
      "These current rules govern voice, viewpoint, tense and style, including when older prose used a different style. Preserve established story facts."] : []),
    "# Persistent directions", ...run.ongoing_instructions,
    "# Established history (already happened; do not retell)",
    ...(recap ? [recap.text] : []),
    ...history.map((scene, index) => index >= proseStart
      ? `Scene ${scene.beat_index + 1} (full prose):\n${scene.narration}`
      : scene.beat_index > (recap?.through ?? -1)
        ? `Scene ${scene.beat_index + 1}: ${scene.summary ?? scene.narration}` : ""),
  ].filter(Boolean).join("\n\n");
}

export function buildCreativePrompt(run: ReaderRun, instruction?: string, pass?: number): NarrationRequest {
  const focuses = iterationFocuses(run.generation_mode, run.iteration_count);
  const previous = run.current_draft?.iterations ?? [];
  const iterations = run.include_iterations === "full" ? previous : previous.slice(-1);
  return {
    systemPrompt: [
      ...(run.reasoning_mode === "template_think" ? ["/think"] : []),
      "Write the next scene of an unfolding fictional story. Output only the complete scene as prose.",
      ...taggedReasoningRule(run.reasoning_mode),
      "Invent events, characters and locations as needed, but preserve established facts, viewpoint, tense and cause and effect.",
      "Advance the story rather than repeating it. Choose a natural scene boundary and finish complete sentences. Do not force a cliffhanger or conclude the whole story unless warranted or requested.",
      `Use at most ${run.scene_words} words. Use clear paragraphs and controlled sentences. No headings, summaries, XML or control tags. Preserve permitted lowercase vocal cues when requested.`,
    ].join("\n"),
    messages: [{ role: "user", content: [
      creativeContext(run),
      ...(run.approved_plan ? ["# Approved scene plan (follow its events and stopping point)", run.approved_plan] : []),
      ...(instruction?.trim() ? ["# Reader direction", instruction.trim()] : []),
      ...(pass ? [
        `# Improvement pass ${pass}/${focuses.length}`,
        focuses[pass - 1] ?? "Improve the story.",
        "Preserve this scene's events and boundary. Output the complete improved scene.",
        ...iterations.map((item) => `Draft ${item.pass}:\n${item.narration}`),
      ] : ["Write the next scene now."]),
    ].join("\n\n") }],
  };
}

export function buildCreativePlanPrompt(run: ReaderRun, instruction?: string): NarrationRequest {
  return {
    systemPrompt: [
      ...(run.reasoning_mode === "template_think" ? ["/think"] : []),
      ...taggedReasoningRule(run.reasoning_mode),
      "Your final answer is a short scene proposal for reader approval, not prose and not private reasoning.",
      `In at most 200 words propose concrete events in order, character choices, viewpoint, and a natural stopping point for one scene of at most ${run.scene_words} words.`,
      "Invent freely within the premise and established continuity. Do not plan the entire story. Proposed events have NOT happened yet.",
    ].join("\n"),
    messages: [{ role: "user", content: [creativeContext(run), instruction ?? "", "Propose the next scene."].join("\n\n") }],
  };
}

export function invalidateCreativeSummary(run: ReaderRun, beatIndex: number): void {
  const target = run.beat_index === beatIndex ? run.current_draft : run.accepted.find((scene) => scene.beat_index === beatIndex);
  if (target) target.summary = undefined;
  if (run.recap && run.recap.through >= beatIndex) run.recap = undefined;
  if (run.accepted.some((scene) => scene.beat_index > beatIndex) || (run.current_draft && run.beat_index > beatIndex)) {
    run.continuity_warning = `Scene ${beatIndex + 1} changed. Later scenes may need a continuity review.`;
  }
}

export async function summarizeCreativeRun(
  root: string, storyPath: string, runId: string,
  generate: (prompt: NarrationRequest) => Promise<string>
): Promise<void> {
  let run = await readReaderRun(root, storyPath, runId);
  if (run.workflow === "authored") return;
  const scenes = [...run.accepted, ...(run.current_draft ? [{ ...run.current_draft, beat_index: run.beat_index }] : [])];
  for (const scene of scenes) {
    if (scene.summary) continue;
    const summary = (await generate({
      systemPrompt: "Summarize only the supplied final prose in at most 180 words. Record actual events in order, character identities and relationships, location/time, state changes, discoveries, unresolved threads and the exact ending situation. No inventions, predictions, proposals, vocal cues or commentary. Output only the factual summary.",
      messages: [{ role: "user", content: scene.narration }],
    })).trim();
    if (!summary) throw new Error("The scene summary was empty. Retry Continue to summarize the saved prose.");
    await mutateReaderRun(root, storyPath, runId, (current) => {
      const target = current.beat_index === scene.beat_index ? current.current_draft : current.accepted.find((item) => item.beat_index === scene.beat_index);
      if (!target || target.narration !== scene.narration) throw new Error("The scene changed during summarization. Retry.");
      target.summary = summary;
    });
  }
  run = await readReaderRun(root, storyPath, runId);
  const older = run.accepted.slice(0, Math.max(0, run.accepted.length - Math.max(8, run.prose_window)))
    .filter((scene) => scene.beat_index > (run.recap?.through ?? -1));
  for (let offset = 0; offset < older.length; offset += 8) {
    const batch = older.slice(offset, offset + 8);
    const text = (await generate({
      systemPrompt: "Consolidate the supplied factual history into at most 500 words. Preserve identities, relationships, consequential events, current states, unresolved threads and discoveries. Do not invent or predict. Output only the recap.",
      messages: [{ role: "user", content: [run.recap?.text ?? "", ...batch.map((scene) => scene.summary!)].join("\n\n") }],
    })).trim();
    if (!text) throw new Error("The continuity recap was empty. Retry Continue.");
    run = await mutateReaderRun(root, storyPath, runId, (current) => {
      if (current.recap?.through !== run.recap?.through || batch.some((scene) => {
        const target = current.accepted.find((item) => item.beat_index === scene.beat_index);
        return !target || target.narration !== scene.narration || target.summary !== scene.summary;
      })) throw new Error("History changed during recap consolidation. Retry Continue.");
      current.recap = { through: batch.at(-1)!.beat_index, text };
      return current;
    });
  }
}