import { useEffect, useRef, useState } from "react";
import { Check, Sparkles, Trash2, X } from "lucide-react";
import type { Narration, ReaderState } from "../../src/reader-store";

export function VocalCues({ run, beatIndex, target, language, turbo, models, model, busy, onChange }: Readonly<{
  run: ReaderState;
  beatIndex: number;
  target: Pick<Narration, "narration" | "cue_proposal" | "vocal_cues" | "incomplete_reason" | "review">;
  language?: "en" | "nl";
  turbo: boolean;
  models: string[];
  model: string;
  busy: boolean;
  onChange: (state: ReaderState) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [cueModel, setCueModel] = useState(model || models[0] || "");
  const [english, setEnglish] = useState(language === "en");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), [run.run_id, beatIndex]);
  const eligible = turbo && language !== "nl" && !target.incomplete_reason && !(target.review && target.review.narration !== target.narration);
  const proposal = target.cue_proposal;
  const stale = proposal && proposal.source !== target.narration;
  const applied = target.vocal_cues?.source === target.narration;
  let proposalTitle = "No vocal cues suggested";
  if (proposal?.insertions.length) proposalTitle = "Suggested vocal cues";
  if (stale) proposalTitle = "Narration changed; run a new cue pass";

  function close() { abort.current?.abort(); setOpen(false); }

  async function request(action?: "apply" | "dismiss" | "remove") {
    setWorking(true); setError("");
    const controller = new AbortController(); abort.current = controller;
    try {
      const suffix = action ? "/" + action : "";
      const response = await fetch(`/api/runs/${run.run_id}/cues${suffix}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ story_path: run.story_path, beat_index: beatIndex,
          ...(!action ? { model: cueModel, english } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The vocal-cue pass failed.");
      onChange(result as ReaderState); setOpen(false);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (abort.current === controller) { abort.current = undefined; setWorking(false); } }
  }

  return <div className="vocal-cues">
    <div className="cue-actions">
      <button className="secondary" disabled={busy || working || !eligible} title={language === "nl" ? "English only: Dutch uses Multilingual, not Turbo" : "English vocal cues require Chatterbox Turbo"}
        aria-label={`Vocal cues for beat ${beatIndex + 1}`} onClick={() => { setOpen(true); setError(""); setCueModel(model || models[0] || ""); }}><Sparkles size={16} />Vocal cues</button>
      {target.vocal_cues && <><span className="cue-state">{applied ? "Cues applied" : "Outdated cues"}</span><button className="icon-button" title="Remove applied vocal cues" aria-label={`Remove vocal cues for beat ${beatIndex + 1}`} disabled={busy || working} onClick={() => void request("remove")}><Trash2 size={16} /></button></>}
    </div>
    {proposal && <section className="cue-proposal" aria-label={`Vocal cue proposal for beat ${beatIndex + 1}`}>
      <strong>{proposalTitle}</strong>
      <ul>{proposal.insertions.map((insertion) => <li key={insertion.offset}><code>[{insertion.tag}]</code> <q>{proposal.source.slice(insertion.offset, insertion.offset + 90)}</q></li>)}</ul>
      <details><summary>Audio text</summary><div className="cue-preview">{proposal.narration}</div></details>
      <div className="cue-actions"><button className="secondary" disabled={working} onClick={() => void request("dismiss")}>Keep original</button>
        <button className="primary" disabled={busy || working || !eligible || Boolean(stale) || proposal.insertions.length === 0} onClick={() => void request("apply")}><Check size={16} />Apply vocal cues</button></div>
    </section>}
    {open && <div className="modal-overlay"><section className="modal cue-modal" role="dialog" aria-modal="true" aria-label="English Turbo vocal cues" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <div className="modal-heading"><h2>Vocal cues</h2><button className="icon-button" aria-label="Close vocal cue pass" title="Close vocal cue pass" onClick={close}><X size={18} /></button></div>
      <label className="modal-field">Cue model<select aria-label="Vocal cue model" value={cueModel} disabled={working} onChange={(event) => setCueModel(event.target.value)}>{models.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="checkbox-field"><input type="checkbox" aria-label="Narration is English" checked={english} disabled={working || language === "en"} onChange={(event) => setEnglish(event.target.checked)} />Narration is English</label>
      <label className="modal-field">Source narration<textarea aria-label="Cue source narration" rows={8} readOnly value={target.narration} /></label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={working || !eligible || !english || !cueModel} onClick={() => void request()}><Sparkles size={16} />{working ? "Suggesting cues..." : "Suggest vocal cues"}</button></div>
    </section></div>}
    {!open && error && <div className="error" role="alert">{error}</div>}
  </div>;
}