import { useEffect, useRef, useState } from "react";
import { Download, Play, RefreshCw, Square, Volume2 } from "lucide-react";
import { splitSpeechText } from "../../src/reader-audio-text";

interface AudioConfig {
  enabled: boolean;
  profile: string;
  model: string;
  voice: string;
}

export function useReaderAudio(options: {
  runId?: string;
  busy: boolean;
  narrations: Array<{ beat_index: number; narration: string }>;
}) {
  const [config, setConfig] = useState<AudioConfig>();
  const [voice, setVoice] = useState("");
  const [voices, setVoices] = useState<string[]>([]);
  const [rate, setRate] = useState(1);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [activeBeat, setActiveBeat] = useState<number>();
  const [rendering, setRendering] = useState(false);
  const [clipUrl, setClipUrl] = useState("");
  const player = useRef<HTMLAudioElement>(null);
  const abort = useRef<AbortController | undefined>(undefined);
  const objectUrl = useRef("");
  const sequence = useRef(0);
  const nextClip = useRef<() => void>(() => {});
  const sourceKey = JSON.stringify(options.narrations);

  function stop() {
    sequence.current += 1;
    abort.current?.abort();
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
      setVoice(saved || settings.voice);
      const savedRate = Number(localStorage.getItem("folio-audio-rate") ?? "1");
      setRate(Number.isFinite(savedRate) && savedRate >= 0.5 && savedRate <= 2 ? savedRate : 1);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    stop();
  }, [options.runId, options.busy, sourceKey]);

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
      const response = await fetch("/api/audio/voices");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setVoices(result.voices);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function readBeat(beatIndex: number, narration: string) {
    stop();
    setError("");
    if (!config?.enabled || !voice.trim() || options.busy) return;
    const chunks = splitSpeechText(narration);
    if (!chunks.length) return;
    const currentSequence = sequence.current;
    const label = beatIndex < 0 ? "Voice preview" : `Beat ${beatIndex + 1}`;
    setActiveBeat(beatIndex);
    async function loadClip(index: number) {
      if (sequence.current !== currentSequence) return;
      setRendering(true);
      setStatus(`Rendering ${label.toLowerCase()}, clip ${index + 1} of ${chunks.length}`);
      const controller = new AbortController();
      abort.current = controller;
      try {
        const response = await fetch("/api/audio/speech", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: chunks[index], voice: voice.trim() }), signal: controller.signal,
        });
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error ?? `Audio failed (${response.status}).`);
        }
        const blob = await response.blob();
        if (sequence.current !== currentSequence || !player.current) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(blob);
        player.current.src = objectUrl.current;
        setClipUrl(objectUrl.current);
        setRendering(false);
        setStatus(`${label}, clip ${index + 1} of ${chunks.length}`);
        nextClip.current = index + 1 < chunks.length ? () => void loadClip(index + 1) : () => {
          setStatus(`${label} complete`);
          setActiveBeat(undefined);
        };
        try {
          await player.current.play();
        } catch {
          if (sequence.current === currentSequence) setError("Playback paused. Press play in the audio player to continue.");
        }
      } catch (reason) {
        if (sequence.current !== currentSequence) return;
        stop();
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    void loadClip(0);
  }

  const panel = <section className="audio-panel" aria-label="Story audio">
    <div className="audio-settings">
      <span className="audio-profile"><Volume2 size={18} aria-hidden="true" />{config?.enabled ? config.profile : "Audio off"}</span>
      {config?.enabled && <>
        <label className="audio-voice">Voice
          <input aria-label="Narrator voice" list="folio-voices" value={voice} maxLength={200} onChange={(event) => {
            stop();
            setVoice(event.target.value);
            localStorage.setItem(`folio-audio-voice:${config.profile}:${config.model}`, event.target.value);
          }} />
          <datalist id="folio-voices">{voices.map((item) => <option key={item} value={item} />)}</datalist>
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
        if (objectUrl.current) { stop(); setError("The browser could not decode this audio clip."); }
      }} />
      <button className="audio-icon" disabled={activeBeat === undefined && !clipUrl} aria-label="Stop audio" title="Stop audio" onClick={stop}><Square size={18} /></button>
      {clipUrl && <a className="audio-icon" href={clipUrl} download="folio-clip.wav" aria-label="Download current audio clip" title="Download current audio clip"><Download size={18} /></a>}
    </div>
    {status && <div className="audio-status" role="status" aria-live="polite">{rendering && <span className="audio-pulse" />}{status}</div>}
    {error && <div className="audio-error" role="alert">{error}</div>}
  </section>;

  return { panel, enabled: Boolean(config?.enabled && voice.trim()), readBeat, activeBeat };
}