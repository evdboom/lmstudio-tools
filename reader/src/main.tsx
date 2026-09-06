import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthoringApp } from "./authoring";
import { useScreenWakeLock } from "./wake-lock";
import "./styles.css";

type ContextMode = "full" | "blueprint" | "hybrid";
type ReasoningMode = "native" | "template_think" | "think" | "thinking";

const CONTEXT_MODE_LABELS: Record<ContextMode, string> = {
  full: "full context",
  blueprint: "beat events",
  hybrid: "recent prose + history",
};

interface StoryItem { path: string; title: string; premise: string; beats: number }
interface RunItem {
  run_id: string;
  story_path: string;
  model?: string;
  context_mode: ContextMode;
  reasoning_mode: ReasoningMode;
  beat_index: number;
  accepted_beats: number;
  has_current_draft: boolean;
  updated_at: string;
  status: "active" | "completed";
}
interface NarrationReview {
  narration: string;
  reasoning?: string;
  model: string;
  reviewed_at: string;
}
interface Narration { beat_index: number; narration: string; review?: NarrationReview }
interface ImagePlan {
  generated_at: string;
  planner_model: string;
  checkpoint_id: string;
  width: number;
  height: number;
  beats: Array<{
    beat_index: number;
    prompt: string;
    negative_prompt: string;
    framing: string;
    loras: Array<{ id: string; strength: number }>;
    pose: { source_id?: string; prompt: string };
  }>;
}
interface ReaderState {
  run_id: string;
  story_path: string;
  model?: string;
  context_mode: ContextMode;
  reasoning_mode: ReasoningMode;
  title: string;
  premise: string;
  beat_index: number;
  total_beats: number;
  accepted: Narration[];
  current_draft?: { narration: string; review?: NarrationReview };
  ongoing_instructions: string[];
  status: "active" | "completed";
  image_plan?: ImagePlan;
}

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
  const [contextMode, setContextMode] = useState<ContextMode>("full");
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>("native");
  const [state, setState] = useState<ReaderState>();
  const [streamed, setStreamed] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  useScreenWakeLock(busy);
  const [generationAction, setGenerationAction] = useState<
    "next" | "regenerate" | "regenerate_previous"
  >();
  const [generationStatus, setGenerationStatus] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [actionBeatIndex, setActionBeatIndex] = useState<number>();
  const [actionStatus, setActionStatus] = useState("");
  const [actionReasoning, setActionReasoning] = useState("");
  const [actionStreamed, setActionStreamed] = useState("");
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
  const generationAbort = useRef<AbortController>();

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
        if (type === "done") result = JSON.parse(data);
        if (type === "error") throw new Error(JSON.parse(data));
      }
      if (done) break;
    }
    if (!result) throw new Error("The stream ended without a result.");
    return result;
  }

  async function runReview(run: ReaderState, beatIndex: number, signal?: AbortSignal) {
    setActionBeatIndex(beatIndex);
    setActionStreamed("");
    setActionReasoning("");
    setActionStatus(`Reviewing beat ${beatIndex + 1}...`);
    const response = await fetch(`/api/runs/${run.run_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ story_path: run.story_path, model, beat_index: beatIndex }),
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

  async function reviewBeat(run: ReaderState, beatIndex: number) {
    setError("");
    setBusy(true);
    try {
      await runReview(run, beatIndex);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setActionBeatIndex(undefined);
      setActionStatus("");
      setActionStreamed("");
      setActionReasoning("");
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
    const hasLaterNarration = run.accepted.some((item) => item.beat_index > beatIndex)
      || Boolean(run.current_draft && run.beat_index > beatIndex);
    if (run.context_mode === "full" && hasLaterNarration &&
        !confirm("Regenerating this beat will discard every later beat so the story can continue from the new LM Studio branch. Continue?")) {
      return;
    }

    const abort = new AbortController();
    generationAbort.current = abort;
    setBusy(true);
    setActionBeatIndex(beatIndex);
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
      if (generationAbort.current === abort) generationAbort.current = undefined;
      setBusy(false);
      setActionBeatIndex(undefined);
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
      if (generationAbort.current === abort) generationAbort.current = undefined;
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
          context_mode: contextMode,
          reasoning_mode: reasoningMode,
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
      setContextMode(resumed.context_mode);
      setReasoningMode(resumed.reasoning_mode);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function planImages() {
    if (state?.status !== "completed" || !model) return;
    setBusy(true);
    setGenerationStatus("Planning images from the completed narration...");
    setError("");
    try {
      const planned = await json<ReaderState>(`/api/runs/${state.run_id}/plan-images`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ story_path: state.story_path, model }),
      });
      setState(planned);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setGenerationStatus("");
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
  const currentDisplayNarration = isActingCurrent && actionStreamed ? actionStreamed : currentNarration;
  const currentBeatIndex = state
    ? state.current_draft
      ? state.beat_index
      : Math.max(state.beat_index, state.accepted.length)
    : 0;
  let imagePlanActionLabel = "Plan images";
  if (busy) imagePlanActionLabel = "Planning...";
  else if (state?.image_plan) imagePlanActionLabel = "Regenerate plan";

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
              <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
                {models.map((item) => <option key={item}>{item}</option>)}
              </select>
              <select aria-label="Narration context" value={contextMode} onChange={(event) => setContextMode(event.target.value as ContextMode)}>
                <option value="hybrid">Recent prose + derived history</option>
                <option value="full">Full narration context</option>
                <option value="blueprint">Beat events only</option>
              </select>
              <select aria-label="Reasoning mode" value={reasoningMode} onChange={(event) => setReasoningMode(event.target.value as ReasoningMode)}>
                <option value="native">Native reasoning</option>
                <option value="template_think">Template /think ([THINK])</option>
                <option value="think">XML &lt;think&gt;</option>
                <option value="thinking">XML &lt;thinking&gt;</option>
              </select>
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
                    <span title={run.model}>{run.model ?? "Unknown model"} · {CONTEXT_MODE_LABELS[run.context_mode]} · {run.accepted_beats} accepted · {new Date(run.updated_at).toLocaleString()}</span>
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
          <article className="manuscript">
            <header>
              <p className="eyebrow">{state.premise}</p>
              <h1>{state.title}</h1>
            </header>
            {state.accepted.map((beat) => {
              const isActing = actionBeatIndex === beat.beat_index;
              const displayNarration = isActing && actionStreamed ? actionStreamed : beat.narration;
              return (
                <section className={`beat ${isActing ? "writing" : ""}`} key={beat.beat_index}>
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
                    <button className="secondary" disabled={busy} onClick={() => void reviewBeat(state, beat.beat_index)}>Review</button>
                  </div>
                  {visibleReviews.has(beat.beat_index) && beat.review && <section className={`beat-review ${beat.review.narration === beat.narration ? "keep" : "replace"}`}>
                    <strong>{beat.review.narration === beat.narration ? "Review passed" : "Revision suggested"}</strong>
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
              <section className={`beat current ${busy ? "writing" : ""}`}>
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
                  <button className="secondary" onClick={() => void reviewBeat(state, state.beat_index)}>Review</button>
                </div>}
                {visibleReviews.has(state.beat_index) && state.current_draft?.review && <section className={`beat-review ${state.current_draft.review.narration === state.current_draft.narration ? "keep" : "replace"}`}>
                  <strong>{state.current_draft.review.narration === state.current_draft.narration ? "Review passed" : "Revision suggested"}</strong>
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
            {state.status === "completed" && (
              <section className="image-planning">
                <div className="image-planning-heading">
                  <div>
                    <p className="eyebrow">ComfyUI</p>
                    <h2>Image plan</h2>
                  </div>
                  <button type="button" className="primary" disabled={busy || !model} onClick={() => void planImages()}>
                    {imagePlanActionLabel}
                  </button>
                </div>
                {busy && generationStatus && <p className="image-planning-status">{generationStatus}</p>}
                {state.image_plan && (
                  <>
                    <p className="image-plan-meta">
                      {state.image_plan.checkpoint_id} · {state.image_plan.width} × {state.image_plan.height} · {state.image_plan.planner_model}
                    </p>
                    {state.image_plan.beats.map((beat) => (
                      <article className="image-beat" key={beat.beat_index}>
                        <header>
                          <strong>Beat {beat.beat_index + 1}</strong>
                          <span>{beat.framing}</span>
                        </header>
                        <label>Prompt<textarea readOnly value={beat.prompt} /></label>
                        <label>Negative<textarea readOnly value={beat.negative_prompt} /></label>
                        <dl>
                          <dt>LoRAs</dt>
                          <dd>{beat.loras.length > 0
                            ? beat.loras.map((lora) => `${lora.id} @ ${lora.strength}`).join(", ")
                            : "None"}</dd>
                          <dt>Pose</dt>
                          <dd>{beat.pose.source_id ? `${beat.pose.source_id}: ` : ""}{beat.pose.prompt}</dd>
                        </dl>
                      </article>
                    ))}
                  </>
                )}
              </section>
            )}
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