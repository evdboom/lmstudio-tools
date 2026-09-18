import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthoringApp } from "./authoring";
import { useScreenWakeLock } from "./wake-lock";
import type { GenerationMode, ReasoningMode, ReasoningEffort, RunItem, ReaderState, StoryItem } from "../../src/reader-store";
import "./styles.css";

const REVISION_VERDICT_LABELS: Record<"replace" | "append", string> = {
  replace: "replacement",
  append: "addition",
};

type GenerationAction = "next" | "regenerate" | "regenerate_previous";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("story-reader-theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [stories, setStories] = useState<StoryItem[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [storyPath, setStoryPath] = useState("");
  const [model, setModel] = useState("");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("direct");
  const [iterationCount, setIterationCount] = useState(3);
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>("native");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("default");
  const [differentReviewer, setDifferentReviewer] = useState(false);
  const [reviewerModel, setReviewerModel] = useState("");
  const [reviewerReasoningMode, setReviewerReasoningMode] = useState<ReasoningMode>("native");
  const [reviewerReasoningEffort, setReviewerReasoningEffort] = useState<ReasoningEffort>("default");
  const [proseWindow, setProseWindow] = useState(1);
  const [ongoingInstructions, setOngoingInstructions] = useState<string[]>([]);
  const [ongoingInstructionInput, setOngoingInstructionInput] = useState("");
  const [modelOptionsOpen, setModelOptionsOpen] = useState(false);
  const [state, setState] = useState<ReaderState>();
  const [streamed, setStreamed] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  useScreenWakeLock(busy);
  const [generationAction, setGenerationAction] = useState<GenerationAction>();
  const [generationStatus, setGenerationStatus] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [actionBeatIndex, setActionBeatIndex] = useState<number>();
  const [actionKind, setActionKind] = useState<"regenerate" | "review">();
  const [actionStatus, setActionStatus] = useState("");
  const [actionReasoning, setActionReasoning] = useState("");
  const [actionStreamed, setActionStreamed] = useState("");
  const [reviewBeatIndex, setReviewBeatIndex] = useState<number>();
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [visibleReviews, setVisibleReviews] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [autoContinue, setAutoContinue] = useState(
    () => localStorage.getItem("story-reader-auto-continue") === "true"
  );
  const [reviewAfterGeneration, setReviewAfterGeneration] = useState(
    () => localStorage.getItem("story-reader-review-after-generation") === "true"
  );
  const autoContinueRef = useRef(autoContinue);
  const reviewAfterGenerationRef = useRef(reviewAfterGeneration);
  const generationAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("story-reader-theme", theme);
  }, [theme]);

  useEffect(() => {
    autoContinueRef.current = autoContinue;
    localStorage.setItem("story-reader-auto-continue", String(autoContinue));
  }, [autoContinue]);

  useEffect(() => {
    reviewAfterGenerationRef.current = reviewAfterGeneration;
    localStorage.setItem("story-reader-review-after-generation", String(reviewAfterGeneration));
  }, [reviewAfterGeneration]);

  useEffect(() => {
    Promise.all([
      json<{ stories: StoryItem[] }>("/api/stories"),
      json<{ models: string[] }>("/api/models"),
    ]).then(([storyResult, modelResult]) => {
      setStories(storyResult.stories);
      setModels(modelResult.models);
      setStoryPath(storyResult.stories[0]?.path ?? "");
      setModel(modelResult.models[0] ?? "");
      setReviewerModel(modelResult.models[0] ?? "");
    }).catch((reason) => setError(reason.message));
  }, []);

  useEffect(() => {
    if (!storyPath) {
      setRuns([]);
      return;
    }
    json<{ runs: RunItem[] }>(`/api/runs?story_path=${encodeURIComponent(storyPath)}`)
      .then((result) => setRuns(result.runs))
      .catch((reason) => setError(reason.message));
  }, [storyPath]);

  function narrationAt(run: ReaderState, beatIndex: number) {
    if (run.beat_index === beatIndex && run.current_draft) return run.current_draft;
    return run.accepted.find((item) => item.beat_index === beatIndex);
  }

  async function readEventStream(response: Response, handlers: {
    onStatus?: (value: string) => void;
    onReasoning?: (value: string) => void;
    onDelta?: (value: string) => void;
    onState?: (value: ReaderState) => void;
    onRestart?: (value: string) => void;
  }): Promise<ReaderState> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ReaderState | undefined;
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const type = event.match(/^event: (.+)$/m)?.[1];
        const data = event.match(/^data: (.+)$/m)?.[1];
        if (!data) continue;
        if (type === "state") handlers.onState?.(JSON.parse(data));
        if (type === "status") handlers.onStatus?.(JSON.parse(data));
        if (type === "reasoning") handlers.onReasoning?.(JSON.parse(data));
        if (type === "delta") handlers.onDelta?.(JSON.parse(data));
        if (type === "restart") handlers.onRestart?.(JSON.parse(data));
        if (type === "done") result = JSON.parse(data);
        if (type === "error") throw new Error(JSON.parse(data));
      }
      if (done) break;
    }
    if (!result) throw new Error("The stream ended without a result.");
    return result;
  }

  async function runReview(run: ReaderState, beatIndex: number, signal?: AbortSignal, instruction?: string) {
    setReasoning("");
    setActionBeatIndex(beatIndex);
    setActionKind("review");
    setActionStreamed("");
    setActionReasoning("");
    setActionStatus(`Reviewing beat ${beatIndex + 1}...`);
    const incompleteReason = narrationAt(run, beatIndex)?.incomplete_reason;
    const reviewInstruction = [instruction?.trim(), incompleteReason].filter(Boolean).join("\n\n");
    const response = await fetch(`/api/runs/${run.run_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        story_path: run.story_path,
        model: run.reviewer_model || model,
        beat_index: beatIndex,
        instruction: reviewInstruction || undefined,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => undefined);
      throw new Error(body?.error ?? `Review failed (${response.status}).`);
    }
    const reviewed = await readEventStream(response, {
      onStatus: setActionStatus,
      onReasoning: (value) => setActionReasoning((current) => current + value),
      onDelta: (value) => setActionStreamed((current) => current + value),
    });
    setState(reviewed);
    setVisibleReviews((current) => new Set(current).add(beatIndex));
    const original = narrationAt(run, beatIndex)?.narration;
    const result = narrationAt(reviewed, beatIndex)?.review?.narration;
    return { state: reviewed, changed: original !== result };
  }

  function openReview(beatIndex: number) {
    setReviewBeatIndex(beatIndex);
    setReviewInstruction("");
  }

  async function reviewBeat(run: ReaderState, beatIndex: number) {
    setError("");
    setBusy(true);
    try {
      await runReview(run, beatIndex, undefined, reviewInstruction);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setActionBeatIndex(undefined);
      setActionStatus("");
      setActionStreamed("");
      setActionReasoning("");
      setActionKind(undefined);
      setReviewBeatIndex(undefined);
      setReviewInstruction("");
    }
  }

  async function applyReviewRequest(run: ReaderState, beatIndex: number): Promise<ReaderState> {
    const applied = await json<ReaderState>(`/api/runs/${run.run_id}/apply-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ story_path: run.story_path, beat_index: beatIndex }),
    });
    setState(applied);
    setVisibleReviews((current) => {
      if (!current.has(beatIndex)) return current;
      const next = new Set(current);
      next.delete(beatIndex);
      return next;
    });
    return applied;
  }

  async function applyReview(run: ReaderState, beatIndex: number) {
    setBusy(true);
    setGenerationStatus(`Applying review to beat ${beatIndex + 1}...`);
    setError("");
    try {
      await applyReviewRequest(run, beatIndex);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setGenerationStatus("");
    }
  }

  async function dismissReview(run: ReaderState, beatIndex: number) {
    setBusy(true);
    setGenerationStatus(`Keeping the original beat ${beatIndex + 1}...`);
    setError("");
    try {
      const dismissed = await json<ReaderState>(`/api/runs/${run.run_id}/dismiss-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ story_path: run.story_path, beat_index: beatIndex }),
      });
      setState(dismissed);
      setVisibleReviews((current) => {
        if (!current.has(beatIndex)) return current;
        const next = new Set(current);
        next.delete(beatIndex);
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setGenerationStatus("");
    }
  }

  async function regenerateBeat(run: ReaderState, beatIndex: number) {
    const abort = new AbortController();
    generationAbort.current = abort;
    setBusy(true);
    setActionBeatIndex(beatIndex);
    setActionKind("regenerate");
    setActionStreamed("");
    setActionReasoning("");
    setActionStatus(`Regenerating beat ${beatIndex + 1}...`);
    setError("");
    setVisibleReviews((current) => {
      if (!current.has(beatIndex)) return current;
      const next = new Set(current);
      next.delete(beatIndex);
      return next;
    });
    try {
      const response = await fetch(`/api/runs/${run.run_id}/regenerate-beat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ story_path: run.story_path, model, beat_index: beatIndex }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.error ?? `Regeneration failed (${response.status}).`);
      }
      let regenerated = await readEventStream(response, {
        onStatus: setActionStatus,
        onReasoning: (value) => setActionReasoning((current) => current + value),
        onDelta: (value) => setActionStreamed((current) => current + value),
        onRestart: (value) => {
          setActionStreamed("");
          setActionReasoning("");
          setActionStatus(value);
        },
      });
      setState(regenerated);
      if (reviewAfterGenerationRef.current) {
        regenerated = (await runReview(regenerated, beatIndex, abort.signal)).state;
        setState(regenerated);
      }
    } catch (reason) {
      if (!abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generationAbort.current === abort) generationAbort.current = null;
      setBusy(false);
      setActionBeatIndex(undefined);
      setActionKind(undefined);
      setActionStatus("");
      setActionStreamed("");
      setActionReasoning("");
    }
  }

  async function generate(
    run: ReaderState,
    action: "next" | "regenerate" | "regenerate_previous",
    direction = ""
  ) {
    const abort = new AbortController();
    generationAbort.current = abort;
    setBusy(true);
    setGenerationAction(action);
    setGenerationStatus("Connecting to LM Studio...");
    setError("");
    setStreamed("");
    setReasoning("");
    let completedState: ReaderState | undefined;
    try {
      const response = await fetch(`/api/runs/${run.run_id}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          story_path: run.story_path,
          model,
          action,
          instruction: direction || undefined,
        }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json();
        throw new Error(body.error ?? `Generation failed (${response.status}).`);
      }

      completedState = await readEventStream(response, {
        onState: setState,
        onStatus: setGenerationStatus,
        onReasoning: (value) => setReasoning((current) => current + value),
        onDelta: (value) => {
          setGenerationStatus("Writing the beat...");
          setStreamed((current) => current + value);
        },
        onRestart: (value) => {
          setStreamed("");
          setReasoning("");
          setGenerationStatus(value);
        },
      });
      setState(completedState);
      setStreamed("");
      let reviewChanged = false;
      if (reviewAfterGenerationRef.current && completedState?.current_draft) {
        const reviewed = await runReview(completedState, completedState.beat_index, abort.signal);
        completedState = reviewed.state;
        reviewChanged = reviewed.changed;
        if (reviewChanged && autoContinueRef.current) {
          completedState = await applyReviewRequest(completedState, completedState.beat_index);
          reviewChanged = false;
        }
      }
      if (!reviewChanged && autoContinueRef.current && completedState?.current_draft &&
          completedState.beat_index + 1 < completedState.total_beats) {
        await generate(completedState, "next");
      }
    } catch (reason) {
      if (!abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generationAbort.current === abort) generationAbort.current = null;
      setBusy(false);
      setGenerationAction(undefined);
      setGenerationStatus("");
    }
  }

  function cancelGeneration() {
    autoContinueRef.current = false;
    setAutoContinue(false);
    generationAbort.current?.abort();
  }

  async function refreshShelf() {
    const storyResult = await json<{ stories: StoryItem[] }>("/api/stories");
    const nextStoryPath = storyResult.stories.some((story) => story.path === storyPath)
      ? storyPath
      : storyResult.stories[0]?.path ?? "";
    const runResult = nextStoryPath
      ? await json<{ runs: RunItem[] }>(`/api/runs?story_path=${encodeURIComponent(nextStoryPath)}`)
      : { runs: [] };
    setStories(storyResult.stories);
    setStoryPath(nextStoryPath);
    setRuns(runResult.runs);
  }

  async function returnToStories() {
    setState(undefined);
    setStreamed("");
    setInstruction("");
    setGenerationStatus("");
    setReasoning("");
    setVisibleReviews(new Set());
    setError("");
    try {
      await refreshShelf();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function removeRun(run: RunItem) {
    if (!confirm("Delete this told story? This cannot be undone.")) return;
    setBusy(true);
    setError("");
    try {
      await json<void>(`/api/runs/${run.run_id}?story_path=${encodeURIComponent(run.story_path)}`, {
        method: "DELETE",
      });
      setRuns((current) => current.filter((item) => item.run_id !== run.run_id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function addOngoingInstruction() {
    const value = ongoingInstructionInput.trim();
    if (!value) return;
    setOngoingInstructions((current) => [...current, value]);
    setOngoingInstructionInput("");
  }

  function removeOngoingInstruction(index: number) {
    setOngoingInstructions((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  async function begin() {
    if (!storyPath || !model) return;
    setBusy(true);
    setError("");
    setVisibleReviews(new Set());
    try {
      const run = await json<ReaderState>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          story_path: storyPath,
          model,
          generation_mode: generationMode,
          iteration_count: iterationCount,
          prose_window: proseWindow,
          reasoning_mode: reasoningMode,
          reasoning_effort: reasoningEffort,
          ongoing_instructions: ongoingInstructions,
          reviewer_model: differentReviewer ? reviewerModel : undefined,
          reviewer_reasoning_mode: differentReviewer ? reviewerReasoningMode : undefined,
          reviewer_reasoning_effort: differentReviewer ? reviewerReasoningEffort : undefined,
        }),
      });
      setState(run);
      await generate(run, "regenerate");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  async function resume(run: RunItem) {
    setBusy(true);
    setError("");
    setVisibleReviews(new Set());
    try {
      const resumed = await json<ReaderState>(
        `/api/runs/${run.run_id}?story_path=${encodeURIComponent(run.story_path)}`
      );
      setState(resumed);
      if (resumed.model) setModel(resumed.model);
      setGenerationMode(resumed.generation_mode);
      setIterationCount(resumed.iteration_count);
      setReasoningMode(resumed.reasoning_mode);
      setReasoningEffort(resumed.reasoning_effort ?? "default");
      setProseWindow(resumed.prose_window);
      setDifferentReviewer(Boolean(resumed.reviewer_model));
      setReviewerModel(resumed.reviewer_model ?? resumed.model ?? "");
      setReviewerReasoningMode(resumed.reviewer_reasoning_mode ?? resumed.reasoning_mode);
      setReviewerReasoningEffort(resumed.reviewer_reasoning_effort ?? resumed.reasoning_effort ?? "default");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function act(action: "next" | "regenerate" | "regenerate_previous") {
    if (!state) return;
    const direction = instruction;
    setInstruction("");
    void generate(state, action, direction);
  }

  const currentNarration = streamed
    || (busy && generationAction !== "next" ? undefined : state?.current_draft?.narration);
  const isActingCurrent = actionBeatIndex !== undefined && actionBeatIndex === state?.beat_index;
  const currentDisplayNarration =
    isActingCurrent && actionKind === "regenerate" && actionStreamed ? actionStreamed : currentNarration;
  const currentBeatIndex = state
    ? state.current_draft
      ? state.beat_index
      : Math.max(state.beat_index, state.accepted.length)
    : 0;

  return (
    <main className={state ? "reader active" : "reader"}>
      <header className="topbar">
        <div className="wordmark">Folio</div>
        <div className="topbar-actions">
          <a className="nav-link" href="/author">Write</a>
          {!state ? (
            <div className="selectors">
              <select aria-label="Story" value={storyPath} onChange={(event) => setStoryPath(event.target.value)}>
                {stories.map((story) => <option key={story.path} value={story.path}>{story.title}</option>) }
              </select>
              <button className="secondary" onClick={() => setModelOptionsOpen(true)}>Model options</button>
              <button className="primary" disabled={!storyPath || !model || busy} onClick={begin}>Begin</button>
            </div>
          ) : (
            <>
              <button className="secondary" disabled={busy} onClick={() => void returnToStories()}>Stories</button>
              <div className="progress" aria-label={`Beat ${Math.min(currentBeatIndex + 1, state.total_beats)} of ${state.total_beats}`}>
                <span title={state.model}>{state.model ?? "Unknown model"} · {Math.min(currentBeatIndex + 1, state.total_beats)} / {state.total_beats}</span>
                <i style={{ width: `${(state.accepted.length / state.total_beats) * 100}%` }} />
              </div>
            </>
          )}
          <button
            className="theme-toggle"
            aria-label={`Use ${theme === "light" ? "dark" : "light"} mode`}
            title={`Use ${theme === "light" ? "dark" : "light"} mode`}
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {modelOptionsOpen && (
        <div className="modal-overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Model options">
            <div className="modal-heading">
              <h2>Model options</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close model options"
                onClick={() => setModelOptionsOpen(false)}
              >×</button>
            </div>
            <label className="modal-field checkbox-field">
              <input
                type="checkbox"
                checked={differentReviewer}
                onChange={(event) => setDifferentReviewer(event.target.checked)}
              />
              <span>Different reviewer</span>
            </label>
            <div className={differentReviewer ? "model-columns" : undefined}>
              <div className="model-column">
                {differentReviewer && <h3>Prose</h3>}
                <label className="modal-field">
                  <span>Model</span>
                  <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
                    {models.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label className="modal-field">
                  <span>Reasoning mode</span>
                  <select aria-label="Reasoning mode" value={reasoningMode} onChange={(event) => setReasoningMode(event.target.value as ReasoningMode)}>
                    <option value="native">Native reasoning</option>
                    <option value="template_think">Template /think ([THINK])</option>
                    <option value="think">XML &lt;think&gt;</option>
                    <option value="thinking">XML &lt;thinking&gt;</option>
                  </select>
                </label>
                <label className="modal-field">
                  <span>Reasoning effort</span>
                  <select aria-label="Reasoning effort" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}>
                    <option value="default">Model default effort</option>
                    <option value="off">Reasoning off</option>
                    <option value="low">Low effort</option>
                    <option value="medium">Medium effort</option>
                    <option value="high">High effort</option>
                  </select>
                </label>
              </div>
              {differentReviewer && (
                <div className="model-column">
                  <h3>Reviewer</h3>
                  <label className="modal-field">
                    <span>Model</span>
                    <select aria-label="Reviewer model" value={reviewerModel} onChange={(event) => setReviewerModel(event.target.value)}>
                      {models.map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </label>
                  <label className="modal-field">
                    <span>Reasoning mode</span>
                    <select aria-label="Reviewer reasoning mode" value={reviewerReasoningMode} onChange={(event) => setReviewerReasoningMode(event.target.value as ReasoningMode)}>
                      <option value="native">Native reasoning</option>
                      <option value="template_think">Template /think ([THINK])</option>
                      <option value="think">XML &lt;think&gt;</option>
                      <option value="thinking">XML &lt;thinking&gt;</option>
                    </select>
                  </label>
                  <label className="modal-field">
                    <span>Reasoning effort</span>
                    <select aria-label="Reviewer reasoning effort" value={reviewerReasoningEffort} onChange={(event) => setReviewerReasoningEffort(event.target.value as ReasoningEffort)}>
                      <option value="default">Model default effort</option>
                      <option value="off">Reasoning off</option>
                      <option value="low">Low effort</option>
                      <option value="medium">Medium effort</option>
                      <option value="high">High effort</option>
                    </select>
                  </label>
                </div>
              )}
            </div>
            <label className="modal-field">
              <span>Drafting mode</span>
              <select aria-label="Drafting mode" value={generationMode} onChange={(event) => setGenerationMode(event.target.value as GenerationMode)}>
                <option value="direct">Direct</option>
                <option value="distinct">Distinct: rough, causality, polish</option>
                <option value="recurring">Recurring improvement</option>
              </select>
            </label>
            {generationMode === "recurring" && (
              <label className="modal-field">
                <span>Improvement passes</span>
                <input
                  aria-label="Improvement passes"
                  type="number"
                  min={1}
                  max={20}
                  value={iterationCount}
                  onChange={(event) => setIterationCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
                />
              </label>
            )}
            <label className="modal-field" title="Higher values give more context and consistency, but can cause more instruction drift.">
                <span>Recent beats carried as prose</span>
                <small>Higher gives more context and consistency, but can cause more instruction drift.</small>
                <input
                  aria-label="Recent beats carried as prose"
                  type="number"
                  min={0}
                  max={20}
                  value={proseWindow}
                  onChange={(event) => setProseWindow(Math.max(0, Math.min(20, Number(event.target.value) || 0)))}
                />
            </label>
            <div className="modal-field">
              <span>Ongoing instructions</span>
              {ongoingInstructions.length > 0 && (
                <ul className="ongoing-instructions-list">
                  {ongoingInstructions.map((item, index) => (
                    <li key={index}>
                      <span>{item}</span>
                      <button
                        type="button"
                        className="icon-button danger"
                        aria-label={`Remove instruction ${index + 1}`}
                        onClick={() => removeOngoingInstruction(index)}
                      >×</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="ongoing-instruction-input">
                <input
                  aria-label="New ongoing instruction"
                  placeholder="e.g. Never use the word 'suddenly'"
                  value={ongoingInstructionInput}
                  onChange={(event) => setOngoingInstructionInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addOngoingInstruction();
                    }
                  }}
                />
                <button type="button" className="secondary" onClick={addOngoingInstruction}>Add</button>
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={() => setModelOptionsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {!state ? (
        <section className="shelf">
          <p className="eyebrow">Local stories</p>
          <h1>{stories.find((story) => story.path === storyPath)?.title ?? "No finalized stories found"}</h1>
          <p>{stories.find((story) => story.path === storyPath)?.premise ?? "Finalize a story blueprint to place it on the shelf."}</p>
          {runs.length > 0 && (
            <section className="saved-runs" aria-label="Saved reading sessions">
              <h2>Continue reading</h2>
              {runs.map((run) => (
                <div className="saved-run" key={run.run_id}>
                  <div className="saved-run-summary">
                    <strong>{run.status === "completed" ? "Completed" : `Beat ${run.beat_index + 1}`}</strong>
                    <span title={run.model}>{run.model ?? "Unknown model"} · {run.accepted_beats} accepted · {new Date(run.updated_at).toLocaleString()}</span>
                  </div>
                  <div className="saved-run-actions">
                    <button className="secondary" disabled={busy} onClick={() => void resume(run)}>
                      {run.status === "completed" ? "Read" : "Continue"}
                    </button>
                    <button className="icon-button danger" disabled={busy} title="Delete told story" aria-label="Delete told story" onClick={() => void removeRun(run)}>×</button>
                  </div>
                </div>
              ))}
            </section>
          )}
          {error && <div className="error" role="alert">{error}</div>}
        </section>
      ) : (
        <>
          <nav className="beat-map" aria-label="Beat map">
            <p className="eyebrow">Beats</p>
            <ol>
              {state.beat_titles.map((beatTitle, index) => {
                const written = state.accepted.some((item) => item.beat_index === index)
                  || Boolean(state.current_draft && state.beat_index === index);
                const className = [
                  "beat-map-entry",
                  written ? "written" : "pending",
                  index === currentBeatIndex ? "active" : "",
                ].filter(Boolean).join(" ");
                return (
                  <li key={index}>
                    {written ? (
                      <a
                        className={className}
                        href={`#beat-${index}`}
                        aria-current={index === currentBeatIndex ? "true" : undefined}
                      >
                        <span className="beat-map-number">{index + 1}</span>
                        <span className="beat-map-title">{beatTitle}</span>
                      </a>
                    ) : (
                      <span className={className}>
                        <span className="beat-map-number">{index + 1}</span>
                        <span className="beat-map-title">{beatTitle}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <article className="manuscript">
            <header>
              <p className="eyebrow">{state.premise}</p>
              <h1>{state.title}</h1>
            </header>
            {state.accepted.map((beat) => {
              const isActing = actionBeatIndex === beat.beat_index;
              const displayNarration =
                isActing && actionKind === "regenerate" && actionStreamed ? actionStreamed : beat.narration;
              return (
                <section className={`beat ${isActing ? "writing" : ""}`} id={`beat-${beat.beat_index}`} key={beat.beat_index}>
                  <span className="beat-number">{String(beat.beat_index + 1).padStart(2, "0")}</span>
                  {displayNarration.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                  {isActing && (
                    <div className="beat-action-status" role="status" aria-live="polite">
                      <i />
                      <span>{actionStatus}</span>
                    </div>
                  )}
                  {isActing && actionReasoning && (
                    <details className="reasoning-trace" open>
                      <summary>Reasoning <span>live</span></summary>
                      <pre>{actionReasoning}</pre>
                    </details>
                  )}
                  <div className="beat-review-actions">
                    <button className="secondary" disabled={busy} onClick={() => void regenerateBeat(state, beat.beat_index)}>Regenerate</button>
                    <button className="secondary" disabled={busy} onClick={() => openReview(beat.beat_index)}>Review</button>
                  </div>
                  {reviewBeatIndex === beat.beat_index && <div className="review-focus">
                    <input
                      aria-label={`Review focus for beat ${beat.beat_index + 1}`}
                      autoFocus
                      placeholder="Optional review focus"
                      value={reviewInstruction}
                      onChange={(event) => setReviewInstruction(event.target.value)}
                    />
                    <button className="secondary" onClick={() => setReviewBeatIndex(undefined)}>Cancel</button>
                    <button className="primary" onClick={() => void reviewBeat(state, beat.beat_index)}>Start review</button>
                  </div>}
                  {visibleReviews.has(beat.beat_index) && beat.review && <section className={`beat-review ${beat.review.narration === beat.narration ? "keep" : "replace"}`}>
                    <strong>
                      {beat.review.narration === beat.narration ? "Review passed" : "Revision suggested"}
                      {beat.review.narration !== beat.narration && beat.review.verdict && beat.review.verdict !== "valid" &&
                        <span className="review-verdict"> ({REVISION_VERDICT_LABELS[beat.review.verdict]})</span>}
                    </strong>
                    {beat.review.narration !== beat.narration && <>
                      <div className="review-prose">{beat.review.narration}</div>
                      <div className="beat-review-actions">
                        <button className="secondary" disabled={busy} onClick={() => void dismissReview(state, beat.beat_index)}>Keep original</button>
                        <button className="primary" disabled={busy} onClick={() => void applyReview(state, beat.beat_index)}>Apply revision</button>
                      </div>
                    </>}
                  </section>}
                </section>
              );
            })}
            {currentDisplayNarration && state.status === "active" && (
              <section className={`beat current ${busy ? "writing" : ""}`} id={`beat-${state.beat_index}`}>
                <span className="beat-number current-number">
                  {String(state.beat_index + 1).padStart(2, "0")}
                  <small>Current</small>
                </span>
                {currentDisplayNarration.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                {isActingCurrent && (
                  <div className="beat-action-status" role="status" aria-live="polite">
                    <i />
                    <span>{actionStatus}</span>
                  </div>
                )}
                {isActingCurrent && actionReasoning && (
                  <details className="reasoning-trace" open>
                    <summary>Reasoning <span>live</span></summary>
                    <pre>{actionReasoning}</pre>
                  </details>
                )}
                {!busy && state.current_draft && <div className="beat-review-actions">
                  <button className="secondary" onClick={() => void regenerateBeat(state, state.beat_index)}>Regenerate</button>
                  <button className="secondary" onClick={() => openReview(state.beat_index)}>Review</button>
                </div>}
                {reviewBeatIndex === state.beat_index && <div className="review-focus">
                  <input
                    aria-label={`Review focus for beat ${state.beat_index + 1}`}
                    autoFocus
                    placeholder="Optional review focus"
                    value={reviewInstruction}
                    onChange={(event) => setReviewInstruction(event.target.value)}
                  />
                  <button className="secondary" onClick={() => setReviewBeatIndex(undefined)}>Cancel</button>
                  <button className="primary" onClick={() => void reviewBeat(state, state.beat_index)}>Start review</button>
                </div>}
                {visibleReviews.has(state.beat_index) && state.current_draft?.review && <section className={`beat-review ${state.current_draft.review.narration === state.current_draft.narration ? "keep" : "replace"}`}>
                  <strong>
                    {state.current_draft.review.narration === state.current_draft.narration ? "Review passed" : "Revision suggested"}
                    {state.current_draft.review.narration !== state.current_draft.narration && state.current_draft.review.verdict && state.current_draft.review.verdict !== "valid" &&
                      <span className="review-verdict"> ({REVISION_VERDICT_LABELS[state.current_draft.review.verdict]})</span>}
                  </strong>
                  {state.current_draft.review.narration !== state.current_draft.narration && <>
                    <div className="review-prose">{state.current_draft.review.narration}</div>
                    <div className="beat-review-actions">
                      <button className="secondary" disabled={busy} onClick={() => void dismissReview(state, state.beat_index)}>Keep original</button>
                      <button className="primary" disabled={busy} onClick={() => void applyReview(state, state.beat_index)}>Apply revision</button>
                    </div>
                  </>}
                </section>}
              </section>
            )}
            {busy && !streamed && (generationStatus || actionStatus) && (
              <div className="generation-status" role="status" aria-live="polite">
                <i />
                <span>{generationStatus || actionStatus}</span>
              </div>
            )}
            {busy && (reasoning || actionReasoning) && (
              <details className="reasoning-trace">
                <summary>Reasoning <span>live</span></summary>
                <pre>{reasoning || actionReasoning}</pre>
              </details>
            )}
            {state.status === "completed" && <div className="fin">End</div>}          
            {error && <div className="error" role="alert">{error}</div>}
          </article>

          {state.status === "active" && (
            <footer className="controls">
              <div className="control-primary-row">
                <textarea
                  aria-label="Additional direction"
                  placeholder="Add a direction..."
                  rows={2}
                  value={instruction}
                  disabled={busy}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && state.current_draft && !busy) {
                      event.preventDefault();
                      act("next");
                    }
                  }}
                />
                <button
                  className={busy ? "danger" : "primary"}
                  onClick={() => busy
                    ? cancelGeneration()
                    : act(state.current_draft ? "next" : "regenerate")}
                >
                  {busy
                    ? "Stop"
                    : !state.current_draft
                      ? `Generate beat ${currentBeatIndex + 1}`
                      : state.beat_index + 1 === state.total_beats ? "Finish" : "Next"}
                </button>
              </div>
              <div className="control-options">
                <label>
                  <input
                    type="checkbox"
                    checked={reviewAfterGeneration}
                    onChange={(event) => setReviewAfterGeneration(event.target.checked)}
                  />
                  <span>Auto review</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={autoContinue}
                    onChange={(event) => setAutoContinue(event.target.checked)}
                  />
                  <span>Auto continue</span>
                </label>
              </div>
            </footer>
          )}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  location.pathname.startsWith("/author") ? <AuthoringApp /> : <App />
);