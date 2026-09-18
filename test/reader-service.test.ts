import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBeat,
  addCharacter,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
} from "../src/story-authoring.js";
import {
  applyReaderRegeneration,
  applyReaderReview,
  auditReaderBeat,
  getReaderState,
  prepareReaderBeatRegeneration,
  prepareReaderGeneration,
  prepareReaderIteration,
  prepareReaderReview,
  resolveReviewNarration,
  saveReaderDraft,
  saveReaderReview,
  startReaderRun as startReaderRunRequest,
} from "../src/reader-service.js";
import { DISTINCT_ITERATION_FOCUSES } from "../src/reader-prompts.js";
import { deleteReaderRun, listReaderRuns, mutateReaderRun, readReaderRun, type RunRequest } from "../src/reader-store.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const storyPath = "stories/night-train";

async function startReaderRun(
  requestOrRoot: RunRequest | string,
  legacyStoryPath?: string,
  legacyModel?: string,
  _legacyContextMode?: string,
  legacyProseWindow = 1,
  legacyReasoningMode = "native" as RunRequest["reasoning_mode"],
  legacyReasoningEffort = "default" as RunRequest["reasoning_effort"],
  legacyInstructions: string[] = [],
  legacyReviewer?: { generationMode?: RunRequest["generationMode"]; iterationCount?: number }
) {
  if (typeof requestOrRoot !== "string") return startReaderRunRequest(requestOrRoot);
  return startReaderRunRequest({
    root: requestOrRoot,
    story_path: legacyStoryPath!,
    model: legacyModel,
    prose_window: legacyProseWindow,
    reasoning_mode: legacyReasoningMode,
    reasoning_effort: legacyReasoningEffort,
    ongoing_instructions: legacyInstructions,
    reviewer: null,
    generationMode: legacyReviewer?.generationMode ?? "direct",
    iterationCount: legacyReviewer?.iterationCount ?? 3,
  });
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await createStory(root, {
    storyPath,
    title: "The Night Train",
    premise: "A conductor finds an impossible passenger.",
    storyType: "mystery",
    beatBudget: { min_words: 500, max_words: 500 },
    defaultNarrationMode: "close",
  });
  await addNarrationMode(root, storyPath, {
    id: "close",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Stay close to Mara."],
  });
  await addCharacter(root, storyPath, {
    id: "mara",
    name: "Mara",
    description: "The conductor.",
  });
  await addLocation(root, storyPath, {
    id: "car",
    name: "Dining Car",
    description: "A dim carriage.",
  });
  await addBeat(root, storyPath, {
    id: "b01",
    locationId: "car",
    characterIds: ["mara"],
    events: ["Mara enters.", "She finds a passenger, who looks up."],
  });
  await addBeat(root, storyPath, {
    id: "b02",
    locationId: "car",
    characterIds: ["mara"],
    events: ["The passenger offers a strange ticket.", "Mara accepts it."],
  });
  await finalizeStory(root, storyPath);
});

afterEach(async () => cleanup());

describe("reader run service", () => {
  it("builds distinct passes from an ordered event scaffold", async () => {
    const started = await startReaderRun(
      root,
      storyPath,
      "test-model",
      "blueprint",
      1,
      "native",
      "default",
      [],
      { generationMode: "distinct" }
    );
    const prepared = await prepareReaderGeneration(root, storyPath, started.run_id, "regenerate");

    expect(prepared.iterationSeed).toBe(
      "1. Mara enters.\n2. She finds a passenger, who looks up."
    );
    const prompts = await Promise.all(DISTINCT_ITERATION_FOCUSES.map((focus) =>
      prepareReaderIteration(
        root,
        storyPath,
        started.run_id,
        0,
        { messages: prepared.messages!, systemPrompt: prepared.systemPrompt! },
        prepared.iterationSeed!,
        focus
      )));
    expect(prompts.map((prompt) => prompt.systemPrompt)).toEqual([
      expect.stringContaining("complete rough scene"),
      expect.stringContaining("cause and effect"),
      expect.stringContaining("Polish the complete scene"),
    ]);
    expect(prompts[0].messages.at(-1)?.content).toContain(prepared.iterationSeed);
    expect(prompts[0].systemPrompt).toContain("Stay close to Mara.");
  });

  it("only requests tagged reasoning when the run opts in", async () => {
    const native = await startReaderRun(root, storyPath, "native-model");
    const nativeRequest = await prepareReaderGeneration(
      root,
      storyPath,
      native.run_id,
      "regenerate"
    );
    expect(native.reasoning_mode).toBe("native");
    expect(nativeRequest.systemPrompt).not.toContain("<think");

    const tagged = await startReaderRun(
      root,
      storyPath,
      "tagged-model",
      "full",
      1,
      "thinking"
    );
    const taggedRequest = await prepareReaderGeneration(
      root,
      storyPath,
      tagged.run_id,
      "regenerate"
    );
    expect(tagged.reasoning_mode).toBe("thinking");
    expect(taggedRequest.systemPrompt).toContain(
      "keep all reasoning inside <thinking>...</thinking>"
    );
  });

  it.each(["full", "hybrid", "blueprint"] as const)(
    "adds tagged reasoning to %s context mode",
    async (contextMode) => {
      const started = await startReaderRun(
        root,
        storyPath,
        `${contextMode}-model`,
        contextMode,
        1,
        "think"
      );
      const request = await prepareReaderGeneration(
        root,
        storyPath,
        started.run_id,
        "regenerate"
      );

      expect(request.systemPrompt).toContain("Begin with <think>");
    }
  );

  it("uses the chat template activation mode when requested", async () => {
    const started = await startReaderRun(
      root,
      storyPath,
      "template-model",
      "full",
      1,
      "template_think"
    );
    const request = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate"
    );

    expect(started.reasoning_mode).toBe("template_think");
    expect(request.systemPrompt).toContain("Begin with [THINK]");
    expect(request.systemPrompt).not.toContain("Begin with <think>");
  });

  it("keeps regeneration temporary and next-button directions ongoing", async () => {
    const started = await startReaderRun(root, storyPath, "test-model");
    expect(started.model).toBe("test-model");
    expect(await listReaderRuns(root, storyPath)).toEqual([
      expect.objectContaining({
        run_id: started.run_id,
        model: "test-model",
        beat_index: 0,
        accepted_beats: 0,
        has_current_draft: false,
        status: "active",
      }),
    ]);
    const firstRequest = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate",
      "Make the lamps flicker."
    );
    expect(firstRequest.input).toContain("Revision direction for this beat");
    expect(firstRequest.input).toContain("Make the lamps flicker.");
    expect(firstRequest.systemPrompt).toContain("You are an expert fiction writer");
    expect(firstRequest.previousResponseId).toBeUndefined();

    await saveReaderDraft(
      root,
      storyPath,
      started.run_id,
      "The accepted first beat.",
      firstRequest.promptInstruction,
      "resp_first",
      {
        input: firstRequest.input!,
        system_prompt: firstRequest.systemPrompt,
        previous_response_id: firstRequest.previousResponseId,
      }
    );
    const secondRequest = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "next",
      "The ticket smells of smoke."
    );

    expect(secondRequest.previousResponseId).toBeUndefined();
    expect(secondRequest.systemPrompt).toContain("You are an expert fiction writer");
    expect(secondRequest.input).toContain("Ongoing reader directions");
    expect(secondRequest.input).toContain("The ticket smells of smoke.");

    let state = await getReaderState(root, storyPath, started.run_id);
    let savedRun = await readReaderRun(root, storyPath, started.run_id);
    expect(state.beat_index).toBe(1);
    expect(state.accepted[0].narration).toBe("The accepted first beat.");
    expect(savedRun.accepted[0].prompt).toEqual({
      input: firstRequest.input,
      system_prompt: firstRequest.systemPrompt,
    });
    expect(state.ongoing_instructions).toEqual(["The ticket smells of smoke."]);

    await saveReaderDraft(root, storyPath, started.run_id, "The accepted final beat.");
    const completed = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "next"
    );
    expect(completed.input).toBeUndefined();
    expect(completed.state?.status).toBe("completed");

    state = await getReaderState(root, storyPath, started.run_id);
    expect(state.accepted).toHaveLength(2);
    expect(state.status).toBe("completed");
  });

  it("audits the hybrid request that produced a beat", async () => {
    const started = await startReaderRun(root, storyPath, "test-model", "hybrid", 0);
    const first = await prepareReaderGeneration(root, storyPath, started.run_id, "regenerate");
    await saveReaderDraft(
      root,
      storyPath,
      started.run_id,
      "The first beat.",
      first.promptInstruction,
      "resp_first",
      {
        input: first.input!,
        system_prompt: first.systemPrompt,
        previous_response_id: first.previousResponseId,
      }
    );
    const second = await prepareReaderGeneration(root, storyPath, started.run_id, "next");
    await saveReaderDraft(
      root,
      storyPath,
      started.run_id,
      "The second beat.",
      second.promptInstruction,
      "resp_second",
      {
        input: second.input!,
        system_prompt: second.systemPrompt,
        previous_response_id: second.previousResponseId,
      }
    );

    const audit = await auditReaderBeat(root, storyPath, started.run_id, 1);

    expect(audit.messages).toEqual(second.messages);
    expect(audit.previous_response_id).toBeUndefined();
    expect(audit.system_prompt).toContain("You are an expert fiction writer");
    expect(audit.gap).toBeUndefined();
  });

  it("does not report a response chain for hybrid requests", async () => {
    const started = await startReaderRun(root, storyPath, "test-model", "hybrid", 0);
    await saveReaderDraft(root, storyPath, started.run_id, "The first beat.", undefined, "resp_first", {
      input: "Beat 1 request",
    });
    await prepareReaderGeneration(root, storyPath, started.run_id, "next");
    await saveReaderDraft(root, storyPath, started.run_id, "The second beat.", undefined, "resp_second", {
      input: "Beat 2 request",
      previous_response_id: "resp_elsewhere",
    });

    const audit = await auditReaderBeat(root, storyPath, started.run_id, 1);

    expect(audit.gap).toBeUndefined();
  });

  it("returns the transcript as sent for a stateless beat", async () => {
    const started = await startReaderRun(root, storyPath, "test-model", "hybrid", 1);
    await saveReaderDraft(root, storyPath, started.run_id, "The first beat.");
    const second = await prepareReaderGeneration(root, storyPath, started.run_id, "next");
    await saveReaderDraft(
      root,
      storyPath,
      started.run_id,
      "The second beat.",
      undefined,
      undefined,
      { input: second.input!, messages: second.messages, system_prompt: second.systemPrompt }
    );

    const audit = await auditReaderBeat(root, storyPath, started.run_id, 1);

    expect(audit.messages).toEqual(second.messages);
    expect(audit.previous_response_id).toBeUndefined();
  });

  it("derives a word ceiling that leaves room above the budget", async () => {
    const started = await startReaderRun(root, storyPath, "test-model");
    const request = await prepareReaderGeneration(root, storyPath, started.run_id, "regenerate");

    // A tenth of 500 is under the 100-word floor, so the floor applies.
    expect(request.wordBudget).toEqual({ maxWords: 500, ceilingWords: 600 });
  });

  it("deletes one saved reader run", async () => {    const started = await startReaderRun(root, storyPath, "test-model");

    await deleteReaderRun(root, storyPath, started.run_id);

    expect(await listReaderRuns(root, storyPath)).toEqual([]);
    await expect(readReaderRun(root, storyPath, started.run_id)).rejects.toThrow("was not found");
  });

  it("reviews against the exact saved prompt and result", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "blueprint");
    await saveReaderDraft(root, storyPath, started.run_id, "Original prose.", undefined, undefined, {
      input: "Original beat input",
      system_prompt: "Original system prompt",
    });

    const review = await prepareReaderReview(root, storyPath, started.run_id, 0, "Check sentence endings.");
    const reviewInput = review.messages.map((item) => item.content).join("\n");

    expect(reviewInput).toContain("Original system prompt");
    expect(reviewInput).toContain("Original beat input");
    expect(reviewInput).toContain("Original prose.");
    expect(reviewInput).toContain("Check sentence endings.");
    expect(review.systemPrompt).toContain("reply with [VALID]");
    expect(review.systemPrompt).toContain("Start your reply with the [REPLACE] tag");
    expect(review.systemPrompt).toContain("Start your reply with the [APPEND] tag");
    expect(review.systemPrompt).toContain("word-list padding");
    expect(review.systemPrompt).toContain("unexplained trailing em dash");
    expect(review.store).toBe(false);
  });

  it("flags repeated trailing-off paragraphs for review without pre-judging them", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "blueprint");
    await saveReaderDraft(root, storyPath, started.run_id, "One...\n\nTwo...\n\nThree...\n\nFour...\n\nFive...", undefined, undefined, {
      input: "Original beat input",
      system_prompt: "Original system prompt",
    });

    const review = await prepareReaderReview(root, storyPath, started.run_id, 0);
    const reviewInput = review.messages.map((item) => item.content).join("\n");

    expect(reviewInput).toContain("final 5 paragraphs (1-5) all end with an ellipsis or bare em dash");
    expect(reviewInput).toContain("Decide whether this is deliberate style");
  });

  it("rebuilds regeneration from the current blueprint instead of the saved prompt", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "blueprint");
    await mutateReaderRun(root, storyPath, started.run_id, (run) => {
      run.accepted = [{
        beat_index: 0,
        narration: "Old prose.",
        prompt: { input: "STALE EVENT LIST" },
      }];
      run.beat_index = 1;
    });

    const regeneration = await prepareReaderBeatRegeneration(root, storyPath, started.run_id, 0);

    expect(regeneration.input).toContain("Mara enters.");
    expect(regeneration.input).toContain("She finds a passenger, who looks up.");
    expect(regeneration.input).not.toContain("STALE EVENT LIST");
  });

  it("keeps the original narration when the reviewer answers with [VALID]", () => {
    expect(resolveReviewNarration("Original prose.", "[VALID]")).toEqual({ narration: "Original prose.", verdict: "valid" });
    expect(resolveReviewNarration("Original prose.", "  [valid]")).toEqual({ narration: "Original prose.", verdict: "valid" });
  });

  it("replaces the beat with the tagged prose when the reviewer answers [REPLACE]", () => {
    expect(resolveReviewNarration("Original prose.", "[REPLACE]Rewritten prose.")).toEqual({ narration: "Rewritten prose.", verdict: "replace" });
  });

  it("appends only the missing continuation when the reviewer answers [APPEND]", () => {
    const result = resolveReviewNarration("Events one through four happened.", "[APPEND]\nEvent five occurred. Event six followed.");
    expect(result).toEqual({
      narration: "Events one through four happened.\n\nEvent five occurred. Event six followed.",
      verdict: "append",
    });
  });

  it("strips control and tracking tags from stored narration", () => {
    expect(resolveReviewNarration("Original.", "[REPLACE]Beat text [EVENT 2] continues here."))
      .toEqual({ narration: "Beat text  continues here.", verdict: "replace" });
    expect(resolveReviewNarration("Original.", "[REPLACE]<thinking>Internal notes</thinking>Beat text.</thinking>"))
      .toEqual({ narration: "Internal notesBeat text.", verdict: "replace" });
  });

  it("replaces a beat directly on regeneration without leaving a review record", async () => {
    const started = await startReaderRun(root, storyPath, "test-model", "blueprint");
    await saveReaderDraft(root, storyPath, started.run_id, "Original prose.", undefined, undefined, {
      input: "Original beat input",
    });
    await mutateReaderRun(root, storyPath, started.run_id, (run) => {
      run.current_draft!.review = {
        narration: "Stale review candidate.",
        model: "test-model",
        reviewed_at: new Date().toISOString(),
      };
    });

    const state = await applyReaderRegeneration(root, storyPath, started.run_id, 0, {
      narration: "Rebuilt prose.",
      prompt: { input: "Rebuilt beat input" },
    });

    expect(state.current_draft?.narration).toBe("Rebuilt prose.");
    expect(state.current_draft?.review).toBeUndefined();
    const savedRun = await readReaderRun(root, storyPath, started.run_id);
    expect(savedRun.current_draft?.revisions).toEqual([
      expect.objectContaining({ narration: "Original prose." }),
    ]);
  });

  it.each([
    ["think", "<think>", "</think>"],
    ["thinking", "<thinking>", "</thinking>"],
    ["template_think", "[THINK]", "[/THINK]"],
  ] as const)("uses %s reasoning format during review", async (reasoningMode, startTag, endTag) => {
    const started = await startReaderRun(
      root,
      storyPath,
      "review-model",
      "blueprint",
      1,
      reasoningMode
    );
    await saveReaderDraft(root, storyPath, started.run_id, "Original prose.", undefined, undefined, {
      input: "Original beat input",
    });

    const review = await prepareReaderReview(root, storyPath, started.run_id, 0);

    expect(review.systemPrompt).toContain(`keep all reasoning inside ${startTag}...${endTag}`);
    expect(review.systemPrompt).toContain(`then close with ${endTag}`);
  });

  it("replaces a reviewed blueprint beat without discarding later beats", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "blueprint");
    await mutateReaderRun(root, storyPath, started.run_id, (run) => {
      run.accepted = [0, 1].map((beatIndex) => ({
        beat_index: beatIndex,
        narration: `Original beat ${beatIndex + 1}.`,
        prompt: { input: `Beat ${beatIndex + 1} input` },
      }));
      run.beat_index = 2;
      run.status = "completed";
    });
    await saveReaderReview(root, storyPath, started.run_id, 0, {
      model: "review-model",
      narration: "Revised beat 1.",
    });

    const state = await applyReaderReview(root, storyPath, started.run_id, 0);
    const savedRun = await readReaderRun(root, storyPath, started.run_id);

    expect(state.accepted.map((item) => item.narration)).toEqual([
      "Revised beat 1.",
      "Original beat 2.",
    ]);
    expect(savedRun.accepted[0].revisions).toEqual([
      expect.objectContaining({ narration: "Original beat 1." }),
    ]);
    expect(state.status).toBe("completed");
  });

  it("keeps every prior revision in application order", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "blueprint");
    await saveReaderDraft(root, storyPath, started.run_id, "Version one.", undefined, undefined, {
      input: "Beat input",
    });
    await saveReaderReview(root, storyPath, started.run_id, 0, {
      model: "review-model",
      narration: "Version two.",
    });
    await applyReaderReview(root, storyPath, started.run_id, 0);
    await saveReaderReview(root, storyPath, started.run_id, 0, {
      model: "review-model",
      narration: "Version three.",
    });

    const state = await applyReaderReview(root, storyPath, started.run_id, 0);

    expect(state.current_draft?.narration).toBe("Version three.");
    let savedRun = await readReaderRun(root, storyPath, started.run_id);
    expect(savedRun.current_draft?.revisions?.map((item) => item.narration)).toEqual([
      "Version one.",
      "Version two.",
    ]);

    await prepareReaderGeneration(root, storyPath, started.run_id, "next");
    savedRun = await readReaderRun(root, storyPath, started.run_id);
    expect(savedRun.accepted[0].revisions?.map((item) => item.narration)).toEqual([
      "Version one.",
      "Version two.",
    ]);
  });

  it("keeps later beats when applying a reviewed hybrid beat", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "hybrid");
    await mutateReaderRun(root, storyPath, started.run_id, (run) => {
      run.accepted = [0, 1].map((beatIndex) => ({
        beat_index: beatIndex,
        narration: `Original beat ${beatIndex + 1}.`,
        response_id: `resp_original_${beatIndex}`,
        prompt: { input: `Beat ${beatIndex + 1} input` },
      }));
      run.beat_index = 2;
      run.status = "completed";
    });
    await saveReaderReview(root, storyPath, started.run_id, 0, {
      model: "review-model",
      narration: "Revised beat 1.",
      reasoning: "Removed the digression.",
      responseId: "resp_reviewed",
    });

    const state = await applyReaderReview(root, storyPath, started.run_id, 0);

    expect(state.accepted).toHaveLength(2);
    expect(state.accepted[0]).toMatchObject({
      narration: "Revised beat 1.",
      response_id: "resp_original_0",
    });
    expect(state.beat_index).toBe(2);
    expect(state.status).toBe("completed");
  });

  it("leaves an unchanged reviewed beat byte-identical", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "blueprint");
    await saveReaderDraft(root, storyPath, started.run_id, "Already correct.", undefined, undefined, {
      input: "Beat input",
    });
    await saveReaderReview(root, storyPath, started.run_id, 0, {
      model: "review-model",
      narration: "Already correct.",
    });

    const state = await applyReaderReview(root, storyPath, started.run_id, 0);

    expect(state.current_draft?.narration).toBe("Already correct.");
    expect(state.beat_index).toBe(0);
  });

  it("keeps the reviewed current draft in hybrid mode", async () => {
    const started = await startReaderRun(root, storyPath, "review-model", "hybrid");
    await saveReaderDraft(root, storyPath, started.run_id, "Original draft.", undefined, "resp_original", {
      input: "Beat input",
    });
    await saveReaderReview(root, storyPath, started.run_id, 0, {
      model: "review-model",
      narration: "Revised draft.",
      responseId: "resp_reviewed",
    });

    const state = await applyReaderReview(root, storyPath, started.run_id, 0);

    expect(state.current_draft).toMatchObject({
      narration: "Revised draft.",
      response_id: "resp_original",
    });
  });

  it("rolls back the last accepted beat before regenerating it", async () => {
    const started = await startReaderRun(root, storyPath, "test-model");
    await saveReaderDraft(root, storyPath, started.run_id, "Original beat one.");
    await prepareReaderGeneration(root, storyPath, started.run_id, "next");

    await mutateReaderRun(root, storyPath, started.run_id, (run) => {
      run.beat_index = 0;
    });
    const replacement = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate_previous",
      "Use a quieter opening."
    );

    expect(replacement.generationState).toMatchObject({
      beat_index: 0,
      accepted: [],
      current_draft: undefined,
    });
    expect(replacement.input).toContain("Use a quieter opening.");
    expect(replacement.systemPrompt).toContain("You are an expert fiction writer");
  });

  it("adopts a model for a legacy run and prevents later model switching", async () => {
    const started = await startReaderRun(root, storyPath);
    expect(started.model).toBeUndefined();

    const prepared = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate",
      undefined,
      "model-a"
    );
    expect(prepared.generationState?.model).toBe("model-a");
    expect((await listReaderRuns(root, storyPath))[0]?.model).toBe("model-a");

    await expect(prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate",
      undefined,
      "model-b"
    )).rejects.toThrow("Reader run uses model 'model-a', not 'model-b'.");
  });
});