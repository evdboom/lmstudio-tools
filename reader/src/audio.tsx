import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Play, RefreshCw, Square, Volume2 } from "lucide-react";
import type { SavedBeatAudio } from "../../src/reader-audio-store";
import type { AudioJob, AudioLibraryBeat } from "../../src/reader-audio-jobs";
import type { CuePass } from "../../src/reader-cues";

interface AudioConfig {
  enabled: boolean;
  profile: string;
  model: string;
  voice: string;
  response_format: "wav" | "mp3";
  supports_vocal_cues: boolean;
}

interface AudioVoice {
  id: string;
  label: string;
}

function audioJobLabel(job: AudioJob): string {
  if (job.status !== "running") return `${job.status}: ${job.completed_beats} generated, ${job.skipped_beats} skipped`;
  const clip = job.clip_index === undefined ? "" : `, clip ${job.clip_index + 1} of ${job.clip_count}`;
  return `Generating beat ${(job.beat_index ?? 0) + 1}${clip}`;
}

function audioBeatLabel(beat: AudioLibraryBeat): string {
  let state = "not generated";
  if (beat.audio) state = beat.audio.ready ? "ready" : "partial";
  if (beat.outdated) state = "outdated";
  return `${beat.beat_index + 1}. ${beat.title} (${state})`;
}

async function fetchAudioVoices(): Promise<AudioVoice[]> {
  const response = await fetch("/api/audio/voices");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Cannot load TTS voices.");
  return (result.voices as AudioVoice[]).filter((item) => item && typeof item.id === "string" && typeof item.label === "string");
}

async function requestSpeech(payload: object, signal: AbortSignal): Promise<Blob> {
  const response = await fetch("/api/audio/speech", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload), signal,
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error ?? `Audio failed (${response.status}).`);
  }
  return response.blob();
}

export function useReaderAudio(options: {
  runId?: string;
  storyPath?: string;
  busy: boolean;
  narrations: Array<{ beat_index: number; narration: string; vocal_cues?: CuePass }>;
}) {
  const [config, setConfig] = useState<AudioConfig>();
  const [voice, setVoice] = useState("");
  const [voices, setVoices] = useState<AudioVoice[]>([]);
  const [rate, setRate] = useState(1);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [activeBeat, setActiveBeat] = useState<number>();
  const [rendering, setRendering] = useState(false);
  const [clipUrl, setClipUrl] = useState("");
  const [savedAudio, setSavedAudio] = useState<SavedBeatAudio>();
  const [beats, setBeats] = useState<AudioLibraryBeat[]>([]);
  const [job, setJob] = useState<AudioJob>();
  const [starting, setStarting] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const abort = useRef<AbortController | undefined>(undefined);
  const objectUrl = useRef("");
  const sequence = useRef(0);
  const nextClip = useRef<() => void>(() => {});
  const playlist = useRef<SavedBeatAudio | undefined>(undefined);
  const library = useRef<AudioLibraryBeat[]>([]);
  const waitingBeat = useRef<number | undefined>(undefined);
  const jobRunning = starting || job?.status === "running" || job?.status === "stopping";
  const sourceKey = JSON.stringify(options.narrations.map(({ beat_index, narration, vocal_cues }) => ({ beat_index, narration, vocal_cues })));

  function stop() {
    sequence.current += 1;
    abort.current?.abort();
    waitingBeat.current = undefined;
    nextClip.current = () => {};
    if (player.current) {
      player.current.pause();
      player.current.removeAttribute("src");
      player.current.load();
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    setClipUrl("");
    setActiveBeat(undefined);
    setRendering(false);
    setStatus("");
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/audio/config", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Cannot load audio settings.");
      const settings = await response.json() as AudioConfig;
      if (controller.signal.aborted) return;
      setConfig(settings);
      const saved = localStorage.getItem(`folio-audio-voice:${settings.profile}:${settings.model}`);
      const preferred = saved || settings.voice;
      setVoice(preferred);
      if (settings.profile === "chatterbox" || settings.profile === "desktop") {
        try {
          const available = await fetchAudioVoices();
          if (controller.signal.aborted) return;
          setVoices(available);
          const chosen = available.some((item) => item.id === preferred) ? preferred : available[0]?.id ?? preferred;
          setVoice(chosen);
          if (chosen) localStorage.setItem(`folio-audio-voice:${settings.profile}:${settings.model}`, chosen);
        } catch (reason) {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
      const savedRate = Number(localStorage.getItem("folio-audio-rate") ?? "1");
      setRate(Number.isFinite(savedRate) && savedRate >= 0.5 && savedRate <= 2 ? savedRate : 1);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);

  useEffect(() => { stop(); }, [options.busy, sourceKey]);

  useEffect(() => {
    stop();
    playlist.current = undefined;
    setSavedAudio(undefined);
    setBeats([]);
    library.current = [];
    setJob(undefined);
  }, [options.runId]);

  async function refreshLibrary(signal?: AbortSignal) {
    if (!options.runId || !options.storyPath || !voice.trim()) return;
    const query = new URLSearchParams({ story_path: options.storyPath, run_id: options.runId, voice: voice.trim() });
    const response = await fetch(`/api/audio/library?${query}`, { signal });
    const result = await response.json() as { beats: AudioLibraryBeat[]; job?: AudioJob; error?: string };
    if (signal?.aborted) return;
    if (!response.ok) throw new Error(result.error ?? "Cannot load saved audio.");
    library.current = result.beats;
    setBeats(result.beats);
    setJob(result.job);
    const desired = waitingBeat.current;
    if (desired !== undefined && result.beats.some((beat) => beat.beat_index === desired && beat.audio?.ready && !beat.outdated)) {
      selectBeat(desired);
    } else if (!playlist.current) {
      const stored = localStorage.getItem(`folio-audio-beat:${options.runId}`);
      const selected = result.beats.find((beat) => beat.audio?.ready && String(beat.beat_index) === stored);
      if (selected) selectBeat(selected.beat_index, false);
    }
  }

  useEffect(() => {
    if (!options.runId || !options.storyPath || !voice.trim() || options.busy) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try { await refreshLibrary(controller.signal); } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 750);
    return () => { controller.abort(); clearInterval(timer); };
  }, [options.runId, options.storyPath, voice, sourceKey, options.busy]);

  useEffect(() => () => {
    sequence.current += 1;
    abort.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  useEffect(() => {
    if (player.current) player.current.playbackRate = rate;
    localStorage.setItem("folio-audio-rate", String(rate));
  }, [rate, clipUrl]);

  async function refreshVoices() {
    setError("");
    try {
      const configResponse = await fetch("/api/audio/config");
      if (configResponse.ok) setConfig(await configResponse.json() as AudioConfig);
      setVoices(await fetchAudioVoices());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function rememberAudio(audio: SavedBeatAudio) {
    playlist.current = audio;
    setSavedAudio(audio);
    localStorage.setItem(`folio-audio-beat:${audio.run_id}`, String(audio.beat_index));
  }

  function selectBeat(index: number, autoplay = true) {
    const entry = library.current.find((beat) => beat.beat_index === index);
    const audio = entry?.audio;
    if (!audio?.ready || !player.current) return;
    waitingBeat.current = undefined;
    rememberAudio(audio);
    setActiveBeat(audio.beat_index);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    const url = `/api/audio/beats/${audio.run_id}/${audio.beat_index}/play?revision=${audio.revision}`;
    player.current.src = url;
    setClipUrl(url);
    setStatus(`Beat ${audio.beat_index + 1}: ${entry.title}${entry.outdated ? " (earlier version)" : ""}`);
    nextClip.current = () => {
      const next = library.current.find((beat) => beat.beat_index > index && beat.audio?.ready);
      if (next) selectBeat(next.beat_index);
    };
    if (autoplay) {
      const currentSequence = sequence.current;
      void player.current.play().catch(() => {
        if (sequence.current === currentSequence) setError("Playback paused. Press play in the audio player to continue.");
      });
    }
  }

  async function generateAudio(indices?: number[], autoplay = false) {
    if (!options.runId || !options.storyPath || !voice.trim() || jobRunning) return;
    setStarting(true);
    setError("");
    try {
      const payload = { story_path: options.storyPath, run_id: options.runId, voice: voice.trim(), beat_indices: indices };
      const start = (replace = false) => fetch("/api/audio/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, replace }) });
      let response = await start();
      let result = await response.json() as { job: AudioJob; changed?: boolean; beats?: AudioLibraryBeat[]; error?: string };
      if (response.status === 409 && result.changed) {
        const titles = result.beats?.map((beat) => `${beat.beat_index + 1}. ${beat.title}`).join("\n") ?? "";
        if (!window.confirm(`Replace saved audio for these changed beats?\n${titles}\nCancel keeps the earlier audio.`)) {
          await refreshLibrary();
          if (autoplay && indices) selectBeat(indices[0]);
          return;
        }
        response = await start(true);
        result = await response.json();
      }
      if (!response.ok) throw new Error(result.error ?? "Cannot generate audio.");
      setJob(result.job);
      if (autoplay && indices) waitingBeat.current = indices[0];
      await refreshLibrary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setStarting(false); }
  }

  async function previewVoice(text: string, currentSequence: number, controller: AbortController) {
    playlist.current = undefined;
    setSavedAudio(undefined);
    setActiveBeat(-1);
    setRendering(true);
    setStatus("Rendering voice preview");
    try {
      const blob = await requestSpeech({ text, voice: voice.trim() }, controller.signal);
      if (sequence.current !== currentSequence || !player.current) return;
      objectUrl.current = URL.createObjectURL(blob);
      player.current.src = objectUrl.current;
      setClipUrl(objectUrl.current);
      setStatus("Voice preview");
      nextClip.current = () => { setActiveBeat(undefined); setStatus("Voice preview complete"); };
      try { await player.current.play(); } catch {
        if (sequence.current === currentSequence) setError("Playback paused. Press play in the audio player to continue.");
      }
    } catch (reason) {
      if (sequence.current === currentSequence) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence.current === currentSequence) setRendering(false);
    }
  }

  async function stopGeneration() {
    if (!job) return;
    waitingBeat.current = undefined;
    try {
      const response = await fetch(`/api/audio/jobs/${job.id}/stop`, { method: "POST" });
      if (!response.ok) throw new Error("Cannot stop audio generation.");
      setJob((await response.json()).job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function readBeat(beatIndex: number, narration: string) {
    if (!config?.enabled || !voice.trim() || options.busy) return;
    if (beatIndex >= 0) {
      const existing = library.current.find((beat) => beat.beat_index === beatIndex);
      if (jobRunning) {
        if (existing?.audio?.ready) selectBeat(beatIndex);
        return;
      }
      stop();
      await generateAudio([beatIndex], true);
      return;
    }
    stop();
    setError("");
    const currentSequence = sequence.current;
    const controller = new AbortController();
    abort.current = controller;
    await previewVoice(narration, currentSequence, controller);
  }

  const readyBeats = beats.filter((beat) => beat.audio?.ready);
  const selectedIndex = readyBeats.findIndex((beat) => beat.beat_index === savedAudio?.beat_index);

  const panel = <section className="audio-panel" aria-label="Story audio">
    <div className="audio-settings">
      <span className="audio-profile"><Volume2 size={18} aria-hidden="true" />{config?.enabled ? config.profile : "Audio off"}</span>
      {config?.enabled && <>
        <label className="audio-voice">Voice
          {voices.length > 0 ? <select aria-label="Narrator voice" value={voice} onChange={(event) => {
            stop();
            setVoice(event.target.value);
            localStorage.setItem(`folio-audio-voice:${config.profile}:${config.model}`, event.target.value);
          }}>{voices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : <input aria-label="Narrator voice" value={voice} maxLength={200} onChange={(event) => {
            stop();
            setVoice(event.target.value);
            localStorage.setItem(`folio-audio-voice:${config.profile}:${config.model}`, event.target.value);
          }} />}
        </label>
        <button className="audio-icon" aria-label="Refresh voices" title="Refresh voices" onClick={() => void refreshVoices()}><RefreshCw size={18} /></button>
        <button className="audio-icon" disabled={options.busy || jobRunning || !voice.trim()} aria-label="Preview narrator voice" title="Preview narrator voice" onClick={() => readBeat(-1, "The library was quiet, except for the rain against the windows. She paused at the doorway, then smiled. There was still time for one more story.")}><Play size={18} /></button>
        <label className="audio-rate">Speed <output>{rate.toFixed(1)}x</output>
          <input aria-label="Audio playback speed" type="range" min="0.5" max="2" step="0.1" value={rate} onChange={(event) => setRate(Number(event.target.value))} />
        </label>
      </>}
    </div>
    {config?.enabled && options.runId && <div className="audio-generation">
      <button className="audio-command" disabled={options.busy || jobRunning || !voice.trim() || !options.narrations.length} onClick={() => void generateAudio()}><Volume2 size={18} />Generate audio</button>
      {jobRunning && <button className="audio-command" onClick={() => void stopGeneration()} disabled={!job || job.status === "stopping"}><Square size={18} />Stop generation</button>}
      {job && <output className="audio-job">{audioJobLabel(job)}</output>}
    </div>}
    {beats.length > 0 && <div className="audio-beats">
      <button className="audio-icon" disabled={selectedIndex <= 0} aria-label="Previous audio beat" title="Previous audio beat" onClick={() => selectBeat(readyBeats[selectedIndex - 1].beat_index)}><ChevronLeft size={18} /></button>
      <select aria-label="Audio beat" value={savedAudio?.beat_index ?? ""} onChange={(event) => selectBeat(Number(event.target.value))}>
        <option value="" disabled>Select beat</option>
        {beats.map((beat) => <option key={beat.beat_index} value={beat.beat_index} disabled={!beat.audio?.ready}>{audioBeatLabel(beat)}</option>)}
      </select>
      <button className="audio-icon" disabled={selectedIndex < 0 || selectedIndex + 1 >= readyBeats.length} aria-label="Next audio beat" title="Next audio beat" onClick={() => selectBeat(readyBeats[selectedIndex + 1].beat_index)}><ChevronRight size={18} /></button>
    </div>}
    <div className="audio-playback" hidden={!config?.enabled}>
      <audio ref={player} aria-label="Story audio player" controls preload="metadata" onEnded={() => nextClip.current()} onError={() => {
        if (player.current?.getAttribute("src")) { stop(); setError("The browser could not decode this audio clip."); }
      }} />
      <div className="audio-actions"><button className="audio-icon" disabled={activeBeat === undefined && !clipUrl} aria-label="Stop audio" title="Stop audio" onClick={stop}><Square size={18} /></button>
      {savedAudio?.ready && <a className="audio-icon" href={`/api/audio/beats/${savedAudio.run_id}/${savedAudio.beat_index}/download?revision=${savedAudio.revision}`} download={savedAudio.filename} aria-label="Download complete beat audio" title="Download complete beat audio"><Download size={18} /></a>}</div>
    </div>
    {status && <div className="audio-status" role="status" aria-live="polite">{rendering && <span className="audio-pulse" />}{status}</div>}
    {error && <div className="audio-error" role="alert">{error}</div>}
    {job?.error && <div className="audio-error" role="alert">{job.error}</div>}
  </section>;

  return {
    panel,
    enabled: Boolean(config?.enabled && voice.trim()),
    supportsVocalCues: Boolean(config?.enabled && config.supports_vocal_cues),
    readBeat,
    activeBeat,
  };
}