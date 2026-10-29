import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileDown, Play, RefreshCw, Square, Volume2 } from "lucide-react";
import { splitSpeechParagraphs } from "../../src/reader-audio-text";
import type { SavedBeatAudio } from "../../src/reader-audio-store";

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

async function prepareBeatAudio(payload: { run_id: string; beat_index: number; narration: string; voice: string }, signal: AbortSignal) {
  const prepare = async (replace = false) => {
    const response = await fetch("/api/audio/beats", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, replace }), signal,
    });
    const result = await response.json() as { audio: SavedBeatAudio; changed?: boolean; error?: string };
    signal.throwIfAborted();
    return { response, result };
  };
  let { response, result } = await prepare();
  if (response.status === 409 && result.changed) {
    if (!window.confirm("This beat's prose or voice settings have changed. Delete its saved beat audio and render the updated version? Cancel keeps and opens the saved audio.")) {
      return { audio: result.audio, render: false };
    }
    ({ response, result } = await prepare(true));
  }
  if (!response.ok) throw new Error(result.error ?? "Cannot prepare beat audio.");
  return { audio: result.audio, render: true };
}

export function useReaderAudio(options: {
  runId?: string;
  busy: boolean;
  narrations: Array<{ beat_index: number; narration: string }>;
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
  const [clipIndex, setClipIndex] = useState(0);
  const player = useRef<HTMLAudioElement>(null);
  const abort = useRef<AbortController | undefined>(undefined);
  const objectUrl = useRef("");
  const sequence = useRef(0);
  const nextClip = useRef<() => void>(() => {});
  const playlist = useRef<SavedBeatAudio | undefined>(undefined);
  const waitingClip = useRef<number | undefined>(undefined);
  const sourceKey = JSON.stringify(options.narrations);

  function stop() {
    sequence.current += 1;
    abort.current?.abort();
    waitingClip.current = undefined;
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
    if (!options.runId) return;
    const stored = localStorage.getItem(`folio-audio-beat:${options.runId}`);
    if (stored === null || !/^\d+$/.test(stored)) return;
    const controller = new AbortController();
    const currentSequence = sequence.current;
    fetch(`/api/audio/beats/${options.runId}/${stored}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return;
      const { audio } = await response.json() as { audio: SavedBeatAudio };
      if (sequence.current !== currentSequence || controller.signal.aborted) return;
      rememberAudio(audio);
      setStatus(`Saved beat ${audio.beat_index + 1}, ${audio.available.length} of ${audio.clip_count} clips ready`);
      if (audio.available.length) selectClip(audio.available[0], false);
    }).catch(() => {});
    return () => controller.abort();
  }, [options.runId]);

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
    if (playlist.current?.revision !== audio.revision) setClipIndex(0);
    playlist.current = audio;
    setSavedAudio(audio);
    localStorage.setItem(`folio-audio-beat:${audio.run_id}`, String(audio.beat_index));
  }

  function selectClip(index: number, autoplay = true) {
    const audio = playlist.current;
    if (!audio || !audio.available.includes(index) || !player.current) return;
    waitingClip.current = undefined;
    setClipIndex(index);
    setActiveBeat(audio.beat_index);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    const url = `/api/audio/beats/${audio.run_id}/${audio.beat_index}/clips/${index}?revision=${audio.revision}`;
    player.current.src = url;
    setClipUrl(url);
    nextClip.current = () => {
      const current = playlist.current;
      if (current?.revision !== audio.revision || index + 1 >= current.clip_count) return;
      if (current.available.includes(index + 1)) selectClip(index + 1);
      else waitingClip.current = index + 1;
    };
    if (autoplay) {
      const currentSequence = sequence.current;
      void player.current.play().catch(() => {
        if (sequence.current === currentSequence) setError("Playback paused. Press play in the audio player to continue.");
      });
    }
  }

  async function renderBeat(audio: SavedBeatAudio, chunks: string[], currentSequence: number, controller: AbortController) {
    setRendering(true);
    waitingClip.current = 0;
    if (audio.available.includes(0)) selectClip(0);
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        controller.signal.throwIfAborted();
        if (playlist.current?.available.includes(index)) continue;
        setStatus(`Rendering beat ${audio.beat_index + 1}, clip ${index + 1} of ${chunks.length}`);
        await requestSpeech({ text: chunks[index], voice: audio.voice, beat: {
            run_id: audio.run_id, beat_index: audio.beat_index, revision: audio.revision, clip_index: index,
        } }, controller.signal);
        controller.signal.throwIfAborted();
        const current = playlist.current!;
        rememberAudio({ ...current, available: [...current.available, index].sort((left, right) => left - right) });
        if (waitingClip.current === index) selectClip(index);
      }
      setStatus(`Beat ${audio.beat_index + 1} complete, ${chunks.length} clips saved`);
    } catch (reason) {
      if (sequence.current === currentSequence) {
        setStatus(`Beat ${audio.beat_index + 1}, rendering stopped`);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    if (sequence.current === currentSequence) setRendering(false);
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

  async function openBeatAudio(runId: string, beatIndex: number, narration: string, chunks: string[], currentSequence: number, controller: AbortController) {
    try {
      const result = await prepareBeatAudio({ run_id: runId, beat_index: beatIndex, narration, voice: voice.trim() }, controller.signal);
      if (sequence.current !== currentSequence) return;
      rememberAudio(result.audio);
      if (!result.render) {
        setStatus(`Saved beat ${beatIndex + 1}, ${result.audio.available.length} of ${result.audio.clip_count} clips ready (earlier version)`);
        if (result.audio.available.length) selectClip(result.audio.available[0]);
        return;
      }
      setActiveBeat(beatIndex);
      await renderBeat(result.audio, chunks, currentSequence, controller);
    } catch (reason) {
      if (sequence.current === currentSequence) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function readBeat(beatIndex: number, narration: string) {
    stop();
    setError("");
    if (!config?.enabled || !voice.trim() || options.busy) return;
    let chunks: string[];
    try {
      chunks = splitSpeechParagraphs(narration);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (!chunks.length) return;
    const currentSequence = sequence.current;
    const controller = new AbortController();
    abort.current = controller;
    if (beatIndex >= 0 && options.runId) {
      await openBeatAudio(options.runId, beatIndex, narration, chunks, currentSequence, controller);
      return;
    }
    if (beatIndex < 0) await previewVoice(narration, currentSequence, controller);
  }

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
        <button className="audio-icon" disabled={options.busy || !voice.trim()} aria-label="Preview narrator voice" title="Preview narrator voice" onClick={() => readBeat(-1, "The library was quiet, except for the rain against the windows. She paused at the doorway, then smiled. There was still time for one more story.")}><Play size={18} /></button>
        <label className="audio-rate">Speed <output>{rate.toFixed(1)}x</output>
          <input aria-label="Audio playback speed" type="range" min="0.5" max="2" step="0.1" value={rate} onChange={(event) => setRate(Number(event.target.value))} />
        </label>
      </>}
    </div>
    <div className="audio-playback" hidden={!config?.enabled}>
      <audio ref={player} aria-label="Story audio player" controls preload="metadata" onEnded={() => nextClip.current()} onError={() => {
        if (player.current?.getAttribute("src")) { stop(); setError("The browser could not decode this audio clip."); }
      }} />
      <div className="audio-actions"><button className="audio-icon" disabled={activeBeat === undefined && !clipUrl} aria-label="Stop audio" title="Stop audio" onClick={stop}><Square size={18} /></button>
      {clipUrl && <a className="audio-icon" href={clipUrl} download={`folio-clip-${clipIndex + 1}.${savedAudio?.format ?? config?.response_format ?? "wav"}`} aria-label="Download current audio clip" title="Download current audio clip"><FileDown size={18} /></a>}
      {savedAudio && (savedAudio.available.length === savedAudio.clip_count
        ? <a className="audio-icon" href={`/api/audio/beats/${savedAudio.run_id}/${savedAudio.beat_index}/download?revision=${savedAudio.revision}`} download={`folio-beat-${savedAudio.beat_index + 1}.${savedAudio.format}`} aria-label="Download complete beat audio" title="Download complete beat audio"><Download size={18} /></a>
        : <button className="audio-icon" disabled aria-label="Download complete beat audio" title="Render every clip to download the complete beat"><Download size={18} /></button>)}</div>
    </div>
    {savedAudio && <div className="audio-clips">
      <button className="audio-icon" disabled={options.busy || !savedAudio.available.includes(clipIndex - 1)} aria-label="Previous audio clip" title="Previous audio clip" onClick={() => selectClip(clipIndex - 1)}><ChevronLeft size={18} /></button>
      <select aria-label="Audio clip" value={clipIndex} disabled={options.busy} onChange={(event) => selectClip(Number(event.target.value))}>
        {Array.from({ length: savedAudio.clip_count }, (_item, index) => <option key={index} value={index} disabled={!savedAudio.available.includes(index)}>Clip {index + 1} of {savedAudio.clip_count}{savedAudio.available.includes(index) ? "" : " (not ready)"}</option>)}
      </select>
      <button className="audio-icon" disabled={options.busy || !savedAudio.available.includes(clipIndex + 1)} aria-label="Next audio clip" title="Next audio clip" onClick={() => selectClip(clipIndex + 1)}><ChevronRight size={18} /></button>
    </div>}
    {status && <div className="audio-status" role="status" aria-live="polite">{rendering && <span className="audio-pulse" />}{status}</div>}
    {error && <div className="audio-error" role="alert">{error}</div>}
  </section>;

  return {
    panel,
    enabled: Boolean(config?.enabled && voice.trim()),
    supportsVocalCues: Boolean(config?.enabled && config.supports_vocal_cues),
    readBeat,
    activeBeat,
  };
}