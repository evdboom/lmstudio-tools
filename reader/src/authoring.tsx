import { useEffect, useRef, useState } from "react";
import { useScreenWakeLock } from "./wake-lock";

interface StoryItem { path: string; title: string; status: "draft" | "final"; beats: number }
interface Reference { id: string; index: number }
interface Story {
  schema: "story-v2";
  status: "draft" | "final";
  title: string;
  premise: string;
  story_type: string;
  default_narration_mode: string;
  beat_size: string;
  characters: Array<{ index: number; id: string; name: string; description: string; appearance: string; relations: Array<{ to: string; kind: string }>; attributes: string[] }>;
  locations: Array<{ index: number; id: string; name: string; description: string; details: string[] }>;
  narration_modes: Array<{ index: number; id: string; perspective: string; tense: string; rules: string[]; kind?: "replace" | "supplemental" }>;
  facts: Array<{ index: number; id: string; fact: string; subjects: string[] }>;
  beats: Array<{ index: number; location: Reference; characters: Reference[]; description: string; narration_mode?: string; facts: string[]; keywords: Array<{ type: string; word: string }>; narration_rules: string[] }>;
}
interface ChatMessage { role: "user" | "assistant"; text: string; reasoning?: string; stopped?: boolean; failed?: boolean; noFinal?: boolean }
interface StoredChat { messages: ChatMessage[]; responseId?: string }

const AUTHOR_CHAT_KEY = "folio-author-chat";

function storedChat(): StoredChat {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTHOR_CHAT_KEY) ?? "null") as Partial<StoredChat> | null;
    return {
      messages: Array.isArray(saved?.messages) ? saved.messages : [],
      responseId: typeof saved?.responseId === "string" ? saved.responseId : undefined,
    };
  } catch {
    return { messages: [] };
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body as T;
}

function starter(title = "Untitled story"): Story {
  return {
    schema: "story-v2", status: "draft", title, premise: "", story_type: "fiction",
    default_narration_mode: "default", beat_size: "500 words", characters: [], locations: [],
    narration_modes: [{ index: 0, id: "default", perspective: "third-person limited", tense: "past", rules: ["Keep the viewpoint consistent."] }],
    facts: [], beats: [],
  };
}

function normalize(story: Story): Story {
  const copy = structuredClone(story);
  const cleanLines = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean);
  copy.characters.forEach((item, index) => { item.index = index; item.attributes = cleanLines(item.attributes); });
  copy.locations.forEach((item, index) => { item.index = index; item.details = cleanLines(item.details); });
  copy.narration_modes.forEach((item, index) => { item.index = index; item.rules = cleanLines(item.rules); });
  copy.facts.forEach((item, index) => { item.index = index; });
  copy.beats.forEach((beat, index) => {
    beat.index = index;
    beat.narration_rules = cleanLines(beat.narration_rules);
    const locationIndex = copy.locations.findIndex((item) => item.id === beat.location.id);
    beat.location.index = locationIndex;
    beat.characters = beat.characters.map(({ id }) => ({ id, index: copy.characters.findIndex((item) => item.id === id) }));
  });
  return copy;
}

export function AuthoringApp() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("story-reader-theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [stories, setStories] = useState<StoryItem[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [storyPath, setStoryPath] = useState("");
  const [story, setStory] = useState<Story>();
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [initialChat] = useState(storedChat);
  const [messages, setMessages] = useState<ChatMessage[]>(initialChat.messages);
  const [responseId, setResponseId] = useState<string | undefined>(initialChat.responseId);
  const [chatBusy, setChatBusy] = useState(false);
  useScreenWakeLock(chatBusy);
  const chatAbort = useRef<AbortController>();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("story-reader-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(AUTHOR_CHAT_KEY, JSON.stringify({ messages, responseId }));
  }, [messages, responseId]);

  async function refreshList() {
    const result = await json<{ stories: StoryItem[] }>("/api/editor/stories");
    setStories(result.stories);
    return result.stories;
  }

  async function load(path: string) {
    const result = await json<{ story: Story }>(`/api/editor/story?story_path=${encodeURIComponent(path)}`);
    setStoryPath(path); setStory(result.story);
    setIsNew(false); setDirty(false); setNotice(""); setError("");
  }

  useEffect(() => {
    refreshList().then((items) => {
      if (items[0]) void load(items[0].path);
    }).catch((reason) => setError(reason.message));
    json<{ models: string[] }>("/api/models").then((modelResult) => {
      setModels(modelResult.models);
      setModel(modelResult.models[0] ?? "");
    }).catch((reason) => setError(`LM Studio: ${reason.message}`));
  }, []);

  function update(patch: Partial<Story>) { setStory((current) => current ? { ...current, ...patch } : current); setDirty(true); }
  function beginNew() { setStory(starter()); setStoryPath(""); setIsNew(true); setDirty(true); }

  function beginNewChat() {
    if (chatBusy) return;
    setMessages([]);
    setResponseId(undefined);
    setNotice("");
    setError("");
  }

  async function save() {
    if (!story) return;
    setError(""); setNotice("");
    try {
      const path = storyPath.trim();
      if (!path) throw new Error("Choose a folder path before saving.");
      const complete = normalize(story);
      const result = await json<{ story: Story }>("/api/editor/story", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ story_path: path, story: complete, create: isNew }) });
      setStory(result.story); setIsNew(false); setDirty(false); setNotice("Saved and validated."); await refreshList();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function changeCharacter(index: number, patch: Partial<Story["characters"][number]>) {
    if (!story) return;
    const oldId = story.characters[index].id; const nextId = patch.id ?? oldId;
    update({
      characters: story.characters.map((item, itemIndex) => ({
        ...(itemIndex === index ? { ...item, ...patch } : item),
        relations: item.relations.map((relation) => relation.to === oldId ? { ...relation, to: nextId } : relation),
      })),
      facts: story.facts.map((fact) => ({ ...fact, subjects: fact.subjects.map((id) => id === oldId ? nextId : id) })),
      beats: story.beats.map((beat) => ({ ...beat, characters: beat.characters.map((reference) => reference.id === oldId ? { ...reference, id: nextId } : reference) })),
    });
  }
  function removeCharacter(index: number) {
    if (!story) return; const id = story.characters[index].id;
    update({
      characters: story.characters.filter((_, itemIndex) => itemIndex !== index).map((item) => ({ ...item, relations: item.relations.filter((relation) => relation.to !== id) })),
      facts: story.facts.map((fact) => ({ ...fact, subjects: fact.subjects.filter((subject) => subject !== id) })),
      beats: story.beats.map((beat) => ({ ...beat, characters: beat.characters.filter((reference) => reference.id !== id) })),
    });
  }
  function changeLocation(index: number, patch: Partial<Story["locations"][number]>) {
    if (!story) return; const oldId = story.locations[index].id; const nextId = patch.id ?? oldId;
    update({
      locations: story.locations.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
      facts: story.facts.map((fact) => ({ ...fact, subjects: fact.subjects.map((id) => id === oldId ? nextId : id) })),
      beats: story.beats.map((beat) => beat.location.id === oldId ? { ...beat, location: { ...beat.location, id: nextId } } : beat),
    });
  }
  function removeLocation(index: number) {
    if (!story) return; const id = story.locations[index].id; const locations = story.locations.filter((_, itemIndex) => itemIndex !== index); const fallback = locations[0];
    update({
      locations,
      facts: story.facts.map((fact) => ({ ...fact, subjects: fact.subjects.filter((subject) => subject !== id) })),
      beats: story.beats.map((beat) => beat.location.id === id && fallback ? { ...beat, location: { id: fallback.id, index: 0 } } : beat),
    });
  }
  function changeMode(index: number, patch: Partial<Story["narration_modes"][number]>) {
    if (!story) return; const oldId = story.narration_modes[index].id; const nextId = patch.id ?? oldId;
    update({
      narration_modes: story.narration_modes.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
      default_narration_mode: story.default_narration_mode === oldId ? nextId : story.default_narration_mode,
      beats: story.beats.map((beat) => beat.narration_mode === oldId ? { ...beat, narration_mode: nextId } : beat),
    });
  }
  function removeMode(index: number) {
    if (!story || story.narration_modes.length === 1) return; const id = story.narration_modes[index].id; const modes = story.narration_modes.filter((_, itemIndex) => itemIndex !== index); const fallback = modes[0].id;
    update({ narration_modes: modes, default_narration_mode: story.default_narration_mode === id ? fallback : story.default_narration_mode, beats: story.beats.map((beat) => beat.narration_mode === id ? { ...beat, narration_mode: undefined } : beat) });
  }
  function changeFact(index: number, patch: Partial<Story["facts"][number]>) {
    if (!story) return; const oldId = story.facts[index].id; const nextId = patch.id ?? oldId;
    update({ facts: story.facts.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item), beats: story.beats.map((beat) => ({ ...beat, facts: beat.facts.map((id) => id === oldId ? nextId : id) })) });
  }
  function removeFact(index: number) {
    if (!story) return; const id = story.facts[index].id;
    update({ facts: story.facts.filter((_, itemIndex) => itemIndex !== index), beats: story.beats.map((beat) => ({ ...beat, facts: beat.facts.filter((factId) => factId !== id) })) });
  }

  function addBeat() {
    if (!story || story.locations.length === 0) { setError("Add at least one location in World data first."); return; }
    update({ beats: [...story.beats, { index: story.beats.length, location: { id: story.locations[0].id, index: 0 }, characters: [], description: "", facts: [], keywords: [], narration_rules: [] }] });
  }

  function changeBeat(index: number, patch: Partial<Story["beats"][number]>) { if (!story) return; const beats = [...story.beats]; beats[index] = { ...beats[index], ...patch }; update({ beats }); }
  function toggleBeatReference(index: number, field: "characters" | "facts", id: string, checked: boolean) {
    if (!story) return;
    const beat = story.beats[index];
    if (field === "characters") {
      const ids = beat.characters.map((reference) => reference.id);
      const next = checked ? [...ids, id] : ids.filter((item) => item !== id);
      changeBeat(index, { characters: next.map((item) => ({ id: item, index: 0 })) });
      return;
    }
    changeBeat(index, { facts: checked ? [...beat.facts, id] : beat.facts.filter((item) => item !== id) });
  }
  function moveBeat(index: number, offset: number) { if (!story) return; const beats = [...story.beats]; const target = index + offset; if (target < 0 || target >= beats.length) return; [beats[index], beats[target]] = [beats[target], beats[index]]; update({ beats }); }

  async function chat(inputOverride?: string) {
    const input = (inputOverride ?? chatInput).trim(); if (!input || !model) return;
    const abort = new AbortController();
    chatAbort.current = abort;
    setChatInput(""); setChatBusy(true); setError(""); setMessages((current) => [...current, { role: "user", text: input }, { role: "assistant", text: "", reasoning: "" }]);
    try {
      const directOutput = /\b(output|show|print|return|give me)\b.{0,30}\b(draft|answer|result|response)\b/i.test(input);
      const instruction = directOutput
        ? `DIRECT OUTPUT MODE: Begin the final answer immediately. Do not analyze, plan, revise, summarize, or call tools. Reproduce the complete answer already drafted in the preceding reasoning.\n\n${input}`
        : input;
      const response = await fetch("/api/editor/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: storyPath ? `Work on story '${storyPath}'. ${instruction}` : instruction, previous_response_id: responseId }), signal: abort.signal });
      if (!response.ok || !response.body) throw new Error("Authoring chat could not start.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
        for (const raw of events) {
          const type = raw.match(/^event: (.+)$/m)?.[1]; const data = raw.match(/^data: (.+)$/m)?.[1]; if (!data) continue;
          if (type === "delta") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, text: last.text + JSON.parse(data) }; return next; });
          if (type === "reasoning") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + JSON.parse(data) }; return next; });
          if (type === "tool") setNotice(`Model is using ${JSON.parse(data)}...`);
          if (type === "done") {
            const result = JSON.parse(data) as { message: string; responseId: string };
            setResponseId(result.responseId);
            if (!result.message) setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, noFinal: true }; return next; });
          }
          if (type === "error") throw new Error(JSON.parse(data));
        }
        if (done) break;
      }
      if (storyPath) await load(storyPath);
    } catch (reason) {
      if (abort.signal.aborted) {
        setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, stopped: true }; return next; });
      } else {
        setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, failed: true }; return next; });
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally { if (chatAbort.current === abort) chatAbort.current = undefined; setChatBusy(false); }
  }

  function cancelChat() {
    chatAbort.current?.abort();
  }

  return <main className="studio">
    <header className="topbar"><a className="wordmark" href="/">Folio</a><nav><a className="nav-link" href="/">Read</a><strong>Write</strong><button className="theme-toggle" aria-label={`Use ${theme === "light" ? "dark" : "light"} mode`} title={`Use ${theme === "light" ? "dark" : "light"} mode`} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>{theme === "light" ? "☾" : "☀"}</button></nav></header>
    <div className="studio-layout">
      <aside className="story-library"><div className="panel-heading"><h2>Stories</h2><button className="icon-button" title="New story" onClick={beginNew}>+</button></div>{stories.map((item) => <button key={item.path} className={item.path === storyPath ? "story-choice selected" : "story-choice"} onClick={() => void load(item.path)}><strong>{item.title}</strong><span>{item.status} · {item.beats} beats</span></button>)}</aside>
      <section className="blueprint-editor">
        {!story ? <p>Select or create a story.</p> : <>
          <div className="editor-title"><div><p className="eyebrow">Blueprint editor</p><h1>{story.title}</h1></div><div className="editor-actions"><select value={story.status} onChange={(event) => update({ status: event.target.value as Story["status"] })}><option value="draft">Draft</option><option value="final">Final</option></select><button className="primary" disabled={!dirty} onClick={() => void save()}>Save</button></div></div>
          {isNew && <label>Folder path<input value={storyPath} placeholder="stories/my-story" onChange={(event) => setStoryPath(event.target.value)} /></label>}
          <div className="metadata-grid"><label>Title<input value={story.title} onChange={(event) => update({ title: event.target.value })} /></label><label>Type<input value={story.story_type} onChange={(event) => update({ story_type: event.target.value })} /></label><label>Beat size<input value={story.beat_size} onChange={(event) => update({ beat_size: event.target.value })} /></label><label>Default mode<select value={story.default_narration_mode} onChange={(event) => update({ default_narration_mode: event.target.value })}>{story.narration_modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.id}: {mode.perspective}, {mode.tense}</option>)}</select></label><label className="wide">Premise<textarea value={story.premise} onChange={(event) => update({ premise: event.target.value })} /></label></div>
          <section className="world-editor"><div className="panel-heading"><h2>World</h2><span>Characters, locations, narration, and canon</span></div>
            <details open><summary>Characters <span>{story.characters.length}</span></summary><div className="world-list">{story.characters.map((character, index) => <article className="world-item" key={index}>
              <div className="world-item-heading"><strong>{character.name || character.id || `Character ${index + 1}`}</strong><button className="icon-button danger" title="Delete character" onClick={() => removeCharacter(index)}>×</button></div>
              <div className="world-fields"><label>ID<input value={character.id} onChange={(event) => changeCharacter(index, { id: event.target.value })} /></label><label>Name<input value={character.name} onChange={(event) => changeCharacter(index, { name: event.target.value })} /></label><label className="wide">Description<textarea value={character.description} onChange={(event) => changeCharacter(index, { description: event.target.value })} /></label><label className="wide">Appearance<textarea value={character.appearance} onChange={(event) => changeCharacter(index, { appearance: event.target.value })} /></label><label className="wide">Attributes<textarea value={character.attributes.join("\n")} placeholder="One attribute per line" onChange={(event) => changeCharacter(index, { attributes: event.target.value.split("\n") })} /></label>
                <fieldset className="wide"><legend>Relations</legend>{character.relations.map((relation, relationIndex) => <div className="relation-row" key={relationIndex}><select aria-label="Related character" value={relation.to} onChange={(event) => changeCharacter(index, { relations: character.relations.map((item, itemIndex) => itemIndex === relationIndex ? { ...item, to: event.target.value } : item) })}>{story.characters.filter((_, itemIndex) => itemIndex !== index).map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select><input aria-label="Relation kind" value={relation.kind} placeholder="Relation" onChange={(event) => changeCharacter(index, { relations: character.relations.map((item, itemIndex) => itemIndex === relationIndex ? { ...item, kind: event.target.value } : item) })} /><button className="icon-button danger" title="Delete relation" onClick={() => changeCharacter(index, { relations: character.relations.filter((_, itemIndex) => itemIndex !== relationIndex) })}>×</button></div>)}<button className="compact-button" disabled={story.characters.length < 2} onClick={() => changeCharacter(index, { relations: [...character.relations, { to: story.characters.find((_, itemIndex) => itemIndex !== index)!.id, kind: "" }] })}>Add relation</button></fieldset>
              </div></article>)}<button className="secondary add-world-item" onClick={() => update({ characters: [...story.characters, { index: story.characters.length, id: `character-${story.characters.length + 1}`, name: "", description: "", appearance: "", relations: [], attributes: [] }] })}>Add character</button></div></details>
            <details open><summary>Locations <span>{story.locations.length}</span></summary><div className="world-list">{story.locations.map((location, index) => <article className="world-item" key={index}><div className="world-item-heading"><strong>{location.name || location.id || `Location ${index + 1}`}</strong><button className="icon-button danger" title="Delete location" onClick={() => removeLocation(index)}>×</button></div><div className="world-fields"><label>ID<input value={location.id} onChange={(event) => changeLocation(index, { id: event.target.value })} /></label><label>Name<input value={location.name} onChange={(event) => changeLocation(index, { name: event.target.value })} /></label><label className="wide">Description<textarea value={location.description} onChange={(event) => changeLocation(index, { description: event.target.value })} /></label><label className="wide">Details<textarea value={location.details.join("\n")} placeholder="One detail per line" onChange={(event) => changeLocation(index, { details: event.target.value.split("\n") })} /></label></div></article>)}<button className="secondary add-world-item" onClick={() => update({ locations: [...story.locations, { index: story.locations.length, id: `location-${story.locations.length + 1}`, name: "", description: "", details: [] }] })}>Add location</button></div></details>
            <details><summary>Narration modes <span>{story.narration_modes.length}</span></summary><div className="world-list">{story.narration_modes.map((mode, index) => <article className="world-item" key={index}><div className="world-item-heading"><strong>{mode.id || `Mode ${index + 1}`}</strong><button className="icon-button danger" disabled={story.narration_modes.length === 1} title="Delete narration mode" onClick={() => removeMode(index)}>×</button></div><div className="world-fields"><label>ID<input value={mode.id} onChange={(event) => changeMode(index, { id: event.target.value })} /></label><label>Perspective<input value={mode.perspective} onChange={(event) => changeMode(index, { perspective: event.target.value })} /></label><label>Tense<input value={mode.tense} onChange={(event) => changeMode(index, { tense: event.target.value })} /></label><label>Kind<select value={mode.kind ?? "replace"} disabled={mode.id === story.default_narration_mode} onChange={(event) => changeMode(index, { kind: event.target.value as "replace" | "supplemental" })}><option value="replace">Replace default rules</option><option value="supplemental">Add to default rules</option></select></label><label className="wide">Rules<textarea value={mode.rules.join("\n")} placeholder="One rule per line" onChange={(event) => changeMode(index, { rules: event.target.value.split("\n") })} /></label></div></article>)}<button className="secondary add-world-item" onClick={() => update({ narration_modes: [...story.narration_modes, { index: story.narration_modes.length, id: `mode-${story.narration_modes.length + 1}`, perspective: "third-person limited", tense: "past", rules: ["Keep the viewpoint consistent."], kind: "replace" }] })}>Add mode</button></div></details>
            <details><summary>Hard canon facts <span>{story.facts.length}</span></summary><div className="world-list">{story.facts.map((fact, index) => <article className="world-item" key={index}><div className="world-item-heading"><strong>{fact.id || `Fact ${index + 1}`}</strong><button className="icon-button danger" title="Delete fact" onClick={() => removeFact(index)}>×</button></div><div className="world-fields"><label>ID<input value={fact.id} onChange={(event) => changeFact(index, { id: event.target.value })} /></label><label className="wide">Fact<textarea value={fact.fact} onChange={(event) => changeFact(index, { fact: event.target.value })} /></label><fieldset className="wide"><legend>Subjects</legend><div className="reference-options">{[...story.characters, ...story.locations].map((subject) => <label key={subject.id}><input type="checkbox" checked={fact.subjects.includes(subject.id)} onChange={(event) => changeFact(index, { subjects: event.target.checked ? [...fact.subjects, subject.id] : fact.subjects.filter((id) => id !== subject.id) })} />{"name" in subject ? subject.name || subject.id : subject.id}</label>)}</div></fieldset></div></article>)}<button className="secondary add-world-item" onClick={() => update({ facts: [...story.facts, { index: story.facts.length, id: `fact-${story.facts.length + 1}`, fact: "", subjects: [] }] })}>Add fact</button></div></details>
          </section>
          <section className="beats-editor"><div className="panel-heading"><h2>Beats</h2><button className="secondary" onClick={addBeat}>Add beat</button></div>{story.beats.map((beat, index) => <article className="beat-editor" key={index}>
            <div className="beat-toolbar"><strong>{String(index + 1).padStart(2, "0")}</strong><select aria-label="Location" value={beat.location.id} onChange={(event) => changeBeat(index, { location: { id: event.target.value, index: 0 } })}>{story.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select><button className="icon-button" title="Move up" onClick={() => moveBeat(index, -1)}>↑</button><button className="icon-button" title="Move down" onClick={() => moveBeat(index, 1)}>↓</button><button className="icon-button danger" title="Delete beat" onClick={() => update({ beats: story.beats.filter((_, beatIndex) => beatIndex !== index) })}>×</button></div>
            <div className="beat-fields">
              <label className="wide">Events to narrate<textarea value={beat.description} onChange={(event) => changeBeat(index, { description: event.target.value })} /></label>
              <label>Narration mode<select value={beat.narration_mode ?? ""} onChange={(event) => changeBeat(index, { narration_mode: event.target.value || undefined })}><option value="">Story default</option>{story.narration_modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.id}: {mode.perspective}, {mode.tense}</option>)}</select></label>
              <fieldset><legend>Characters</legend><div className="reference-options">{story.characters.length === 0 ? <span>None defined</span> : story.characters.map((character) => <label key={character.id}><input type="checkbox" checked={beat.characters.some((reference) => reference.id === character.id)} onChange={(event) => toggleBeatReference(index, "characters", character.id, event.target.checked)} />{character.name}</label>)}</div></fieldset>
              <fieldset className="wide"><legend>Required facts</legend><div className="reference-options">{story.facts.length === 0 ? <span>None defined</span> : story.facts.map((fact) => <label key={fact.id}><input type="checkbox" checked={beat.facts.includes(fact.id)} onChange={(event) => toggleBeatReference(index, "facts", fact.id, event.target.checked)} />{fact.id}: {fact.fact}</label>)}</div></fieldset>
              <details className="beat-advanced"><summary>Advanced guidance <span>keywords and narration rules</span></summary>
                <label>Keywords<textarea value={beat.keywords.map((keyword) => `${keyword.type}: ${keyword.word}`).join("\n")} placeholder={"motif: broken mirror\ntone: uneasy"} onChange={(event) => changeBeat(index, { keywords: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const separator = line.indexOf(":"); return separator < 0 ? { type: "keyword", word: line } : { type: line.slice(0, separator).trim(), word: line.slice(separator + 1).trim() }; }).filter((keyword) => keyword.type && keyword.word) })} /></label>
                <label>Narration rules<textarea value={beat.narration_rules.join("\n")} placeholder="One rule per line" onChange={(event) => changeBeat(index, { narration_rules: event.target.value.split("\n") })} /></label>
              </details>
            </div>
          </article>)}</section>
          {notice && <div className="notice">{notice}</div>}{error && <div className="error">{error}</div>}
        </>}
      </section>
      <aside className="author-chat"><div className="panel-heading"><h2>Model collaborator</h2><div className="chat-heading-actions"><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item}>{item}</option>)}</select><button className="icon-button" disabled={chatBusy || messages.length === 0} title="New chat" aria-label="New chat" onClick={beginNewChat}>+</button></div></div><div className="chat-log">{messages.length === 0 && <p>Ask the model to create, inspect, or expand a story. Changes are applied through validated MCP tools.</p>}{messages.map((message, index) => <div key={index} className={`chat-message ${message.role}`}>{message.role === "assistant" && message.reasoning && <details className="collaborator-reasoning"><summary>Reasoning <span>{chatBusy && index === messages.length - 1 ? "live" : "trace"}</span></summary><pre>{message.reasoning}</pre></details>}<div className="chat-output">{message.text || (message.stopped ? "Stopped." : message.failed ? "Request failed." : message.noFinal ? "Reasoning finished without a final answer." : "Working...")}</div>{message.noFinal && index === messages.length - 1 && !chatBusy && <button className="secondary output-draft" onClick={() => void chat("Output the complete draft answer.")}>Output draft</button>}</div>)}</div><div className="chat-input"><textarea value={chatInput} disabled={chatBusy} placeholder="Expand the midpoint with two escalating beats..." onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void chat(); } }} />{chatBusy ? <button className="danger stop-button" onClick={cancelChat}>Stop</button> : <button className="primary" disabled={!chatInput.trim()} onClick={() => void chat()}>Send</button>}</div></aside>
    </div>
  </main>;
}
