import { useEffect, useState } from "react";

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
  narration_modes: Array<{ index: number; id: string; perspective: string; tense: string; rules: string[] }>;
  facts: Array<{ index: number; id: string; fact: string; subjects: string[] }>;
  beats: Array<{ index: number; location: Reference; characters: Reference[]; description: string; narration_mode?: string; facts: string[]; keywords: Array<{ type: string; word: string }>; narration_rules: string[] }>;
}
interface ChatMessage { role: "user" | "assistant"; text: string; reasoning?: string }

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
  copy.characters.forEach((item, index) => { item.index = index; });
  copy.locations.forEach((item, index) => { item.index = index; });
  copy.narration_modes.forEach((item, index) => { item.index = index; });
  copy.facts.forEach((item, index) => { item.index = index; });
  copy.beats.forEach((beat, index) => {
    beat.index = index;
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
  const [worldText, setWorldText] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [responseId, setResponseId] = useState<string>();
  const [chatBusy, setChatBusy] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("story-reader-theme", theme);
  }, [theme]);

  async function refreshList() {
    const result = await json<{ stories: StoryItem[] }>("/api/editor/stories");
    setStories(result.stories);
    return result.stories;
  }

  async function load(path: string, preserveChat = false) {
    const result = await json<{ story: Story }>(`/api/editor/story?story_path=${encodeURIComponent(path)}`);
    setStoryPath(path); setStory(result.story); setWorldText(JSON.stringify({ characters: result.story.characters, locations: result.story.locations, narration_modes: result.story.narration_modes, facts: result.story.facts }, null, 2));
    setIsNew(false); setDirty(false); setNotice(""); setError("");
    if (!preserveChat) { setMessages([]); setResponseId(undefined); }
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
  function beginNew() { const next = starter(); setStory(next); setStoryPath(""); setWorldText(JSON.stringify({ characters: [], locations: [], narration_modes: next.narration_modes, facts: [] }, null, 2)); setIsNew(true); setDirty(true); setMessages([]); setResponseId(undefined); }

  async function save() {
    if (!story) return;
    setError(""); setNotice("");
    try {
      const world = JSON.parse(worldText) as Pick<Story, "characters" | "locations" | "narration_modes" | "facts">;
      const path = storyPath.trim();
      if (!path) throw new Error("Choose a folder path before saving.");
      const complete = normalize({ ...story, ...world });
      const result = await json<{ story: Story }>("/api/editor/story", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ story_path: path, story: complete, create: isNew }) });
      setStory(result.story); setIsNew(false); setDirty(false); setNotice("Saved and validated."); await refreshList();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function addBeat() {
    if (!story || story.locations.length === 0) { setError("Add at least one location in World data first."); return; }
    update({ beats: [...story.beats, { index: story.beats.length, location: { id: story.locations[0].id, index: 0 }, characters: [], description: "", facts: [], keywords: [], narration_rules: [] }] });
  }

  function changeBeat(index: number, patch: Partial<Story["beats"][number]>) { if (!story) return; const beats = [...story.beats]; beats[index] = { ...beats[index], ...patch }; update({ beats }); }
  function moveBeat(index: number, offset: number) { if (!story) return; const beats = [...story.beats]; const target = index + offset; if (target < 0 || target >= beats.length) return; [beats[index], beats[target]] = [beats[target], beats[index]]; update({ beats }); }

  async function chat() {
    const input = chatInput.trim(); if (!input || !model) return;
    setChatInput(""); setChatBusy(true); setError(""); setMessages((current) => [...current, { role: "user", text: input }, { role: "assistant", text: "", reasoning: "" }]);
    try {
      const response = await fetch("/api/editor/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: storyPath ? `Work on story '${storyPath}'. ${input}` : input, previous_response_id: responseId }) });
      if (!response.ok || !response.body) throw new Error("Authoring chat could not start.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
        for (const raw of events) {
          const type = raw.match(/^event: (.+)$/m)?.[1]; const data = raw.match(/^data: (.+)$/m)?.[1]; if (!data) continue;
          if (type === "delta") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, text: last.text + JSON.parse(data) }; return next; });
          if (type === "reasoning") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + JSON.parse(data) }; return next; });
          if (type === "tool") setNotice(`Model is using ${JSON.parse(data)}...`);
          if (type === "done") setResponseId(JSON.parse(data).responseId);
          if (type === "error") throw new Error(JSON.parse(data));
        }
        if (done) break;
      }
      if (storyPath) await load(storyPath, true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChatBusy(false); }
  }

  return <main className="studio">
    <header className="topbar"><a className="wordmark" href="/">Folio</a><nav><a className="nav-link" href="/">Read</a><strong>Write</strong><button className="theme-toggle" aria-label={`Use ${theme === "light" ? "dark" : "light"} mode`} title={`Use ${theme === "light" ? "dark" : "light"} mode`} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>{theme === "light" ? "☾" : "☀"}</button></nav></header>
    <div className="studio-layout">
      <aside className="story-library"><div className="panel-heading"><h2>Stories</h2><button className="icon-button" title="New story" onClick={beginNew}>+</button></div>{stories.map((item) => <button key={item.path} className={item.path === storyPath ? "story-choice selected" : "story-choice"} onClick={() => void load(item.path)}><strong>{item.title}</strong><span>{item.status} · {item.beats} beats</span></button>)}</aside>
      <section className="blueprint-editor">
        {!story ? <p>Select or create a story.</p> : <>
          <div className="editor-title"><div><p className="eyebrow">Blueprint editor</p><h1>{story.title}</h1></div><div className="editor-actions"><select value={story.status} onChange={(event) => update({ status: event.target.value as Story["status"] })}><option value="draft">Draft</option><option value="final">Final</option></select><button className="primary" disabled={!dirty} onClick={() => void save()}>Save</button></div></div>
          {isNew && <label>Folder path<input value={storyPath} placeholder="stories/my-story" onChange={(event) => setStoryPath(event.target.value)} /></label>}
          <div className="metadata-grid"><label>Title<input value={story.title} onChange={(event) => update({ title: event.target.value })} /></label><label>Type<input value={story.story_type} onChange={(event) => update({ story_type: event.target.value })} /></label><label>Beat size<input value={story.beat_size} onChange={(event) => update({ beat_size: event.target.value })} /></label><label>Default mode<input value={story.default_narration_mode} onChange={(event) => update({ default_narration_mode: event.target.value })} /></label><label className="wide">Premise<textarea value={story.premise} onChange={(event) => update({ premise: event.target.value })} /></label></div>
          <details><summary>World data <span>characters, locations, modes, facts</span></summary><textarea className="json-editor" spellCheck={false} value={worldText} onChange={(event) => { setWorldText(event.target.value); setDirty(true); }} /></details>
          <section className="beats-editor"><div className="panel-heading"><h2>Beats</h2><button className="secondary" onClick={addBeat}>Add beat</button></div>{story.beats.map((beat, index) => <article className="beat-editor" key={index}><div className="beat-toolbar"><strong>{String(index + 1).padStart(2, "0")}</strong><select value={beat.location.id} onChange={(event) => changeBeat(index, { location: { id: event.target.value, index: 0 } })}>{story.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select><button className="icon-button" title="Move up" onClick={() => moveBeat(index, -1)}>↑</button><button className="icon-button" title="Move down" onClick={() => moveBeat(index, 1)}>↓</button><button className="icon-button danger" title="Delete beat" onClick={() => update({ beats: story.beats.filter((_, beatIndex) => beatIndex !== index) })}>×</button></div><textarea placeholder="Events to narrate" value={beat.description} onChange={(event) => changeBeat(index, { description: event.target.value })} /></article>)}</section>
          {notice && <div className="notice">{notice}</div>}{error && <div className="error">{error}</div>}
        </>}
      </section>
      <aside className="author-chat"><div className="panel-heading"><h2>Model collaborator</h2><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item}>{item}</option>)}</select></div><div className="chat-log">{messages.length === 0 && <p>Ask the model to create, inspect, or expand a story. Changes are applied through validated MCP tools.</p>}{messages.map((message, index) => <div key={index} className={`chat-message ${message.role}`}>{message.role === "assistant" && message.reasoning && <details className="collaborator-reasoning"><summary>Reasoning <span>{chatBusy && index === messages.length - 1 ? "live" : "trace"}</span></summary><pre>{message.reasoning}</pre></details>}<div className="chat-output">{message.text || "Working..."}</div></div>)}</div><div className="chat-input"><textarea value={chatInput} disabled={chatBusy} placeholder="Expand the midpoint with two escalating beats..." onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void chat(); } }} /><button className="primary" disabled={chatBusy || !chatInput.trim()} onClick={() => void chat()}>Send</button></div></aside>
    </div>
  </main>;
}
