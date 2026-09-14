import { Fragment, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useScreenWakeLock } from "./wake-lock";

interface StoryItem { path: string; title: string; status: "draft" | "final"; beats: number }
/** A transient property of a character or location, bounded by beat ids. */
interface State { id: string; state: string; from: string; until?: string }
interface Character { id: string; name: string; description: string; appearance: string; relations: Array<{ to: string; kind: string }>; attributes: string[]; states: State[] }
interface Location { id: string; name: string; description: string; details: string[]; states: State[] }
interface NarrationExample { description: string; text: string }
interface Story {
  schema: "story-v3";
  status: "draft" | "final";
  title: string;
  premise: string;
  story_type: string;
  default_narration_mode: string;
  beat_budget: { min_words: number; max_words: number };
  characters: Character[];
  locations: Location[];
  narration_modes: Array<{ id: string; perspective: string; tense: string; rules: string[]; positive_examples?: NarrationExample[]; negative_examples?: NarrationExample[]; kind?: "replace" | "supplemental" }>;
  facts: Array<{ id: string; fact: string; from?: string; until?: string; beats: string[]; subjects: string[] }>;
  beats: Array<{ id: string; title?: string; location: string; characters: string[]; time?: string; events: string[]; narration_mode?: string; keywords: Array<{ type: string; word: string }>; narration_rules: string[] }>;
}
type SubjectKind = "characters" | "locations";
interface ChatMessage { role: "user" | "assistant"; text: string; reasoning?: string; tools?: string[]; stopped?: boolean; failed?: boolean; noFinal?: boolean }
interface StoredChat { messages: ChatMessage[]; responseId?: string }
type Keyword = Story["beats"][number]["keywords"][number];
type ReasoningMode = "native" | "template_think" | "think" | "thinking";

const AUTHOR_CHAT_KEY = "folio-author-chat";
const CHAT_WIDTH_KEY = "folio-author-chat-width";
const CHAT_WIDTH_DEFAULT = 390;
const CHAT_WIDTH_MIN = 280;
const CHAT_WIDTH_MAX = 640;

function formatKeywords(keywords: Keyword[]): string {
  return keywords.map((keyword) => `${keyword.type}: ${keyword.word}`).join("\n");
}

function parseKeywords(value: string): Keyword[] {
  return value.split("\n").map((line) => {
    const separator = line.indexOf(":");
    return separator < 0 ? undefined : {
      type: line.slice(0, separator).trim(),
      word: line.slice(separator + 1).trim(),
    };
  }).filter((keyword): keyword is Keyword => Boolean(keyword?.type && keyword.word));
}

function KeywordsEditor({ keywords, onChange }: Readonly<{ keywords: Keyword[]; onChange: (keywords: Keyword[]) => void }>) {
  const formatted = formatKeywords(keywords);
  const [draft, setDraft] = useState(formatted);
  const lastStored = useRef(formatted);

  useEffect(() => {
    if (formatted !== lastStored.current) setDraft(formatted);
    lastStored.current = formatted;
  }, [formatted]);

  return <textarea value={draft} placeholder={"One per line: type: word(s)\nmotif: broken mirror"} onChange={(event) => {
    const value = event.target.value;
    const parsed = parseKeywords(value);
    setDraft(value);
    lastStored.current = formatKeywords(parsed);
    onChange(parsed);
  }} />;
}

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
    schema: "story-v3", status: "draft", title, premise: "", story_type: "fiction",
    default_narration_mode: "default", beat_budget: { min_words: 300, max_words: 600 }, characters: [], locations: [],
    narration_modes: [{ id: "default", perspective: "third-person limited", tense: "past", rules: ["Keep the viewpoint consistent."], positive_examples: [], negative_examples: [] }],
    facts: [], beats: [],
  };
}

/**
 * Next free `bNN` beat id.
 *
 * Ordinal ids are only a convention -- beat order is the array order -- but they
 * make a state or fact window readable without cross-referencing the beat list.
 */
function nextBeatId(story: Story): string {
  for (let candidate = story.beats.length + 1; ; candidate += 1) {
    const id = `b${String(candidate).padStart(2, "0")}`;
    if (!story.beats.some((beat) => beat.id === id)) return id;
  }
}

function nextStateId(states: State[]): string {
  for (let candidate = states.length + 1; ; candidate += 1) {
    const id = `state-${candidate}`;
    if (!states.some((state) => state.id === id)) return id;
  }
}

function normalize(story: Story): Story {
  const copy = structuredClone(story);
  const cleanLines = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean);
  copy.characters.forEach((item) => { item.attributes = cleanLines(item.attributes); });
  copy.locations.forEach((item) => { item.details = cleanLines(item.details); });
  copy.narration_modes.forEach((item) => {
    item.rules = cleanLines(item.rules);
    const cleanExamples = (examples: NarrationExample[]) => examples
      .map((example) => ({ description: example.description.trim(), text: example.text.trim() }))
      .filter((example) => example.description && example.text);
    item.positive_examples = cleanExamples(item.positive_examples ?? []);
    item.negative_examples = cleanExamples(item.negative_examples ?? []);
  });
  // Nothing is renumbered on save: beat order is the array order, and every
  // reference is an id.
  copy.beats.forEach((beat) => {
    beat.events = cleanLines(beat.events);
    beat.narration_rules = cleanLines(beat.narration_rules);
    beat.time = beat.time?.trim() || undefined;
    beat.title = beat.title?.trim() || undefined;
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
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>("native");
  const [chatInput, setChatInput] = useState("");
  const [initialChat] = useState(storedChat);
  const [messages, setMessages] = useState<ChatMessage[]>(initialChat.messages);
  const [responseId, setResponseId] = useState<string | undefined>(initialChat.responseId);
  const [chatBusy, setChatBusy] = useState(false);
  const [designAtIndex, setDesignAtIndex] = useState<number>();
  const [beatDesignInput, setBeatDesignInput] = useState("");
  const [designingBeat, setDesigningBeat] = useState(false);
  const [designEntityKind, setDesignEntityKind] = useState<"character" | "location">();
  const [entityDesignInput, setEntityDesignInput] = useState("");
  const [designingEntity, setDesigningEntity] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; sourceId: string; type: string; content: string }>>([]);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return saved >= CHAT_WIDTH_MIN && saved <= CHAT_WIDTH_MAX ? saved : CHAT_WIDTH_DEFAULT;
  });
  useScreenWakeLock(chatBusy);
  const chatAbort = useRef<AbortController>();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("story-reader-theme", theme);
  }, [theme]);

  function beginChatResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatWidth;
    function onMove(moveEvent: MouseEvent) {
      const next = Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, startWidth - (moveEvent.clientX - startX)));
      setChatWidth(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setChatWidth((current) => { localStorage.setItem(CHAT_WIDTH_KEY, String(current)); return current; });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function nudgeChatWidth(delta: number) {
    setChatWidth((current) => {
      const next = Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, current + delta));
      localStorage.setItem(CHAT_WIDTH_KEY, String(next));
      return next;
    });
  }

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

  function changeCharacter(index: number, patch: Partial<Character>) {
    if (!story) return;
    const oldId = story.characters[index].id; const nextId = patch.id ?? oldId;
    update({
      characters: story.characters.map((item, itemIndex) => {
        const next = itemIndex === index ? { ...item, ...patch } : item;
        return { ...next, relations: next.relations.map((relation) => relation.to === oldId ? { ...relation, to: nextId } : relation) };
      }),
      beats: story.beats.map((beat) => ({ ...beat, characters: beat.characters.map((id) => id === oldId ? nextId : id) })),
    });
  }
  function removeCharacter(index: number) {
    if (!story) return; const id = story.characters[index].id;
    update({
      characters: story.characters.filter((_, itemIndex) => itemIndex !== index).map((item) => ({ ...item, relations: item.relations.filter((relation) => relation.to !== id) })),
      beats: story.beats.map((beat) => ({ ...beat, characters: beat.characters.filter((characterId) => characterId !== id) })),
    });
  }
  function changeLocation(index: number, patch: Partial<Location>) {
    if (!story) return; const oldId = story.locations[index].id; const nextId = patch.id ?? oldId;
    update({
      locations: story.locations.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
      beats: story.beats.map((beat) => beat.location === oldId ? { ...beat, location: nextId } : beat),
    });
  }
  function removeLocation(index: number) {
    if (!story) return; const id = story.locations[index].id; const locations = story.locations.filter((_, itemIndex) => itemIndex !== index); const fallback = locations[0];
    update({
      locations,
      beats: story.beats.map((beat) => beat.location === id && fallback ? { ...beat, location: fallback.id } : beat),
    });
  }

  // States live on their subject, so renaming a subject carries them along and
  // only a renamed beat needs the windows rebound.
  function changeStates(kind: SubjectKind, index: number, states: State[]) {
    if (kind === "characters") changeCharacter(index, { states });
    else changeLocation(index, { states });
  }
  function changeState(kind: SubjectKind, index: number, stateIndex: number, patch: Partial<State>) {
    if (!story) return;
    changeStates(kind, index, story[kind][index].states.map((state, itemIndex) => itemIndex === stateIndex ? { ...state, ...patch } : state));
  }
  function addState(kind: SubjectKind, index: number) {
    if (!story) return;
    const first = story.beats[0];
    if (!first) { setError("Add a beat first: a state needs a beat to begin in."); return; }
    const subject = story[kind][index];
    changeStates(kind, index, [...subject.states, { id: nextStateId(subject.states), state: "", from: first.id }]);
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
  function changeModeExample(index: number, kind: "positive_examples" | "negative_examples", exampleIndex: number, patch: Partial<NarrationExample>) {
    if (!story) return;
    const examples = [...(story.narration_modes[index][kind] ?? [])];
    examples[exampleIndex] = { ...examples[exampleIndex], ...patch };
    changeMode(index, { [kind]: examples });
  }
  function examplesEditor(index: number, kind: "positive_examples" | "negative_examples", label: string) {
    if (!story) return null;
    const examples = story.narration_modes[index][kind] ?? [];
    return <fieldset className="wide narration-examples"><legend>{label}</legend>
      {examples.map((example, exampleIndex) => <div className="example-row" key={exampleIndex}>
        <div className="example-fields"><input aria-label={`${label} ${exampleIndex + 1} description`} value={example.description} placeholder="Dialogue pacing" onChange={(event) => changeModeExample(index, kind, exampleIndex, { description: event.target.value })} /><textarea aria-label={`${label} ${exampleIndex + 1} text`} value={example.text} placeholder="Paste a multiline prose example" onChange={(event) => changeModeExample(index, kind, exampleIndex, { text: event.target.value })} /></div>
        <button className="icon-button danger" title={`Delete ${label.toLowerCase()} ${exampleIndex + 1}`} onClick={() => changeMode(index, { [kind]: examples.filter((_, itemIndex) => itemIndex !== exampleIndex) })}>×</button>
      </div>)}
      <button className="compact-button" onClick={() => changeMode(index, { [kind]: [...examples, { description: "", text: "" }] })}>Add example</button>
    </fieldset>;
  }
  function changeFact(index: number, patch: Partial<Story["facts"][number]>) {
    if (!story) return;
    update({ facts: story.facts.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }

  /**
   * A fact selects by pinned beats, by subjects, or by nothing at all. Switching
   * clears the other selector so the file never says two things at once.
   */
  function changeFactSelector(index: number, selector: "beats" | "subjects" | "always") {
    if (!story) return;
    // Pinning also drops the window, since a pin ignores it.
    changeFact(index, selector === "beats"
      ? { beats: [], subjects: [], from: undefined, until: undefined }
      : { beats: [], subjects: [] });
  }

  function factSelector(fact: Story["facts"][number]): "beats" | "subjects" | "always" {
    if (fact.beats.length > 0) return "beats";
    if (fact.subjects.length > 0) return "subjects";
    return "always";
  }

  function toggleFactBeat(index: number, beatId: string, checked: boolean) {
    if (!story) return;
    const fact = story.facts[index];
    // Keep the pins in beat order so the list reads like the story.
    const pinned = new Set(fact.beats);
    if (checked) pinned.add(beatId); else pinned.delete(beatId);
    changeFact(index, {
      beats: story.beats.filter((beat) => pinned.has(beat.id)).map((beat) => beat.id),
      from: undefined,
      until: undefined,
      subjects: [],
    });
  }

  function toggleFactSubject(index: number, subjectId: string, checked: boolean) {
    if (!story) return;
    const fact = story.facts[index];
    changeFact(index, {
      subjects: checked ? [...fact.subjects, subjectId] : fact.subjects.filter((id) => id !== subjectId),
      beats: [],
    });
  }
  function removeFact(index: number) {
    if (!story) return;
    update({ facts: story.facts.filter((_, itemIndex) => itemIndex !== index) });
  }

  function addBeat() {
    if (!story || story.locations.length === 0) { setError("Add at least one location in World data first."); return; }
    update({ beats: [...story.beats, { id: nextBeatId(story), location: story.locations[0].id, characters: [], events: [""], keywords: [], narration_rules: [] }] });
  }

  /**
   * A single structured call, not a chat turn: it sends the whole in-progress
   * blueprint plus a short instruction and the target position, and gets
   * exactly one JSON beat back to splice in there, pre-filled by the model.
   * Anything the beat implies but doesn't encode comes back as `suggested`
   * text for the writer to act on manually; nothing is applied automatically.
   */
  async function designBeat(index: number) {
    if (!story || !model) return;
    const instruction = beatDesignInput.trim();
    if (!instruction) return;
    setDesigningBeat(true); setError("");
    try {
      const result = await json<{ beat: {
        id?: string; title?: string; location: string; characters: string[]; time?: string;
        narration_mode?: string; events: string[]; keywords: Keyword[]; narration_rules: string[];
        suggested: Array<{ type: string; content: string }>;
      } }>("/api/editor/design-beat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, instruction, insert_index: index, story: normalize(story) }),
      });
      const beat = result.beat;
      const id = beat.id ?? nextBeatId(story);
      const beats = [...story.beats];
      beats.splice(index, 0, {
        id, title: beat.title, location: beat.location, characters: beat.characters,
        time: beat.time, events: beat.events, narration_mode: beat.narration_mode,
        keywords: beat.keywords, narration_rules: beat.narration_rules,
      });
      update({ beats });
      addSuggestions(id, beat.suggested);
      setBeatDesignInput(""); setDesignAtIndex(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDesigningBeat(false);
    }
  }

  /** Follow-ups any design call flags but doesn't apply itself; the writer reviews and dismisses them from the panel. */
  function addSuggestions(sourceId: string, items: Array<{ type: string; content: string }>) {
    if (items.length === 0) return;
    setSuggestions((current) => [
      ...current,
      ...items.map((item, itemIndex) => ({ id: `${sourceId}-${itemIndex}-${Date.now()}`, sourceId, type: item.type, content: item.content })),
    ]);
  }

  function dismissSuggestion(id: string) {
    setSuggestions((current) => current.filter((item) => item.id !== id));
  }

  /** Same single-shot pattern as `designBeat`, for the two entity kinds that don't need an insertion position. */
  async function designEntity(kind: "character" | "location") {
    if (!story || !model) return;
    const instruction = entityDesignInput.trim();
    if (!instruction) return;
    setDesigningEntity(true); setError("");
    try {
      if (kind === "character") {
        const result = await json<{ character: {
          id?: string; name: string; description: string; appearance: string;
          attributes: string[]; relations: Array<{ to: string; kind: string }>;
          suggested: Array<{ type: string; content: string }>;
        } }>("/api/editor/design-character", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, instruction, story: normalize(story) }),
        });
        const character = result.character;
        const id = character.id ?? `character-${story.characters.length + 1}`;
        update({ characters: [...story.characters, {
          id, name: character.name, description: character.description, appearance: character.appearance,
          attributes: character.attributes, relations: character.relations, states: [],
        }] });
        addSuggestions(id, character.suggested);
      } else {
        const result = await json<{ location: {
          id?: string; name: string; description: string; details: string[];
          suggested: Array<{ type: string; content: string }>;
        } }>("/api/editor/design-location", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, instruction, story: normalize(story) }),
        });
        const location = result.location;
        const id = location.id ?? `location-${story.locations.length + 1}`;
        update({ locations: [...story.locations, { id, name: location.name, description: location.description, details: location.details, states: [] }] });
        addSuggestions(id, location.suggested);
      }
      setEntityDesignInput(""); setDesignEntityKind(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDesigningEntity(false);
    }
  }

  /** Toggleable inline designer next to a world section's "Add" button; characters and locations have no order, so there is only one slot per kind. */
  function entityDesigner(kind: "character" | "location") {
    const open = designEntityKind === kind;
    return <span className="entity-designer-slot">
      <button className="secondary" disabled={!model} onClick={() => { setDesignEntityKind(open ? undefined : kind); setEntityDesignInput(""); }}>{open ? "Cancel" : `Design ${kind}`}</button>
      {open && <div className="beat-designer">
        <textarea value={entityDesignInput} disabled={designingEntity} placeholder={kind === "character" ? "Describe the character: role, personality, how they fit the story..." : "Describe the location: purpose, mood, key details..."} onChange={(event) => setEntityDesignInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void designEntity(kind); } }} />
        <div className="beat-designer-actions">{designingEntity ? <span>Designing...</span> : <button className="primary" disabled={!entityDesignInput.trim()} onClick={() => void designEntity(kind)}>Generate</button>}</div>
      </div>}
    </span>;
  }

  /** One entry point per gap in the beat list: before the first beat, between every pair, and after the last. */
  function beatSlot(index: number) {
    const open = designAtIndex === index;
    return <div className="beat-slot" key={`slot-${index}`}>
      <button className="compact-button beat-slot-button" disabled={!model} onClick={() => { setDesignAtIndex(open ? undefined : index); setBeatDesignInput(""); }}>{open ? "Cancel" : "+ Design beat here"}</button>
      {open && <div className="beat-designer">
        <textarea value={beatDesignInput} disabled={designingBeat} placeholder="Describe the beat: what should happen, who is involved, any escalation..." onChange={(event) => setBeatDesignInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void designBeat(index); } }} />
        <div className="beat-designer-actions">{designingBeat ? <span>Designing...</span> : <button className="primary" disabled={!beatDesignInput.trim()} onClick={() => void designBeat(index)}>Generate</button>}</div>
      </div>}
    </div>;
  }

  function changeBeat(index: number, patch: Partial<Story["beats"][number]>) { if (!story) return; const beats = [...story.beats]; beats[index] = { ...beats[index], ...patch }; update({ beats }); }

  /** A renamed beat has to be followed by every state and fact window pointing at it. */
  function renameBeat(index: number, nextId: string) {
    if (!story) return;
    const oldId = story.beats[index].id;
    const rebind = (id?: string) => id === oldId ? nextId : id;
    const rebindStates = (subject: Character): Character => ({
      ...subject,
      states: subject.states.map((state) => ({ ...state, from: rebind(state.from) as string, until: rebind(state.until) })),
    });
    update({
      beats: story.beats.map((beat, beatIndex) => beatIndex === index ? { ...beat, id: nextId } : beat),
      characters: story.characters.map(rebindStates),
      locations: story.locations.map((location) => ({
        ...location,
        states: location.states.map((state) => ({ ...state, from: rebind(state.from) as string, until: rebind(state.until) })),
      })),
      facts: story.facts.map((fact) => ({
        ...fact,
        from: rebind(fact.from),
        until: rebind(fact.until),
        beats: fact.beats.map((id) => rebind(id) as string),
      })),
    });
  }

  function toggleBeatCharacter(index: number, id: string, checked: boolean) {
    if (!story) return;
    const beat = story.beats[index];
    changeBeat(index, { characters: checked ? [...beat.characters, id] : beat.characters.filter((item) => item !== id) });
  }
  function moveBeat(index: number, offset: number) { if (!story) return; const beats = [...story.beats]; const target = index + offset; if (target < 0 || target >= beats.length) return; [beats[index], beats[target]] = [beats[target], beats[index]]; update({ beats }); }

  /** Beat options for a window control, labelled by position so order is visible. */
  function beatOptions() {
    return (story?.beats ?? []).map((beat, index) => <option key={beat.id} value={beat.id}>{index + 1}. {beat.id}</option>);
  }

  /** Shared state editor for a character or a location. */
  function statesEditor(kind: SubjectKind, index: number, states: State[]) {
    return <fieldset className="wide"><legend>States</legend>
      <p className="field-hint">Anything true for the whole story belongs above. A state changes: it begins during one beat and may end during a later one.</p>
      {states.map((state, stateIndex) => <div className="state-row" key={stateIndex}>
        <input aria-label="State ID" value={state.id} placeholder="wounded" onChange={(event) => changeState(kind, index, stateIndex, { id: event.target.value })} />
        <input aria-label="State" value={state.state} placeholder="Shoulder bandaged, arm in a sling" onChange={(event) => changeState(kind, index, stateIndex, { state: event.target.value })} />
        <select aria-label="Begins during" value={state.from} onChange={(event) => changeState(kind, index, stateIndex, { from: event.target.value })}>{beatOptions()}</select>
        <select aria-label="Ends during" value={state.until ?? ""} onChange={(event) => changeState(kind, index, stateIndex, { until: event.target.value || undefined })}><option value="">stays true</option>{beatOptions()}</select>
        <button className="icon-button danger" title="Delete state" onClick={() => changeStates(kind, index, states.filter((_, itemIndex) => itemIndex !== stateIndex))}>×</button>
      </div>)}
      <button className="compact-button" onClick={() => addState(kind, index)}>Add state</button>
    </fieldset>;
  }

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
      const response = await fetch("/api/editor/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: storyPath ? `Work on story '${storyPath}'. ${instruction}` : instruction, previous_response_id: responseId, reasoning_mode: reasoningMode }), signal: abort.signal });
      if (!response.ok || !response.body) throw new Error("Authoring chat could not start.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
        for (const raw of events) {
          const type = raw.match(/^event: (.+)$/m)?.[1]; const data = raw.match(/^data: (.+)$/m)?.[1]; if (!data) continue;
          if (type === "delta") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, text: last.text + JSON.parse(data) }; return next; });
          if (type === "reasoning") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + JSON.parse(data) }; return next; });
          if (type === "tool") setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, tools: [...(last.tools ?? []), JSON.parse(data)] }; return next; });
          if (type === "done") {
            const result = JSON.parse(data) as { message: string; responseId: string };
            setResponseId(result.responseId);
            if (!result.message) setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; next[next.length - 1] = { ...last, noFinal: true }; return next; });
          }
          if (type === "error") throw new Error(JSON.parse(data));
        }
        if (done) break;
      }
      await refreshList();
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
    <div className="studio-layout" style={{ "--chat-width": `${chatWidth}px` } as CSSProperties}>
      <aside className="story-library"><div className="panel-heading"><h2>Stories</h2><button className="icon-button" title="New story" onClick={beginNew}>+</button></div>{stories.map((item) => <button key={item.path} className={item.path === storyPath ? "story-choice selected" : "story-choice"} onClick={() => void load(item.path)}><strong>{item.title}</strong><span>{item.status} · {item.beats} beats</span></button>)}</aside>
      <section className="blueprint-editor">
        {!story ? <p>Select or create a story.</p> : <>
          <div className="editor-title"><div><p className="eyebrow">Blueprint editor</p><h1>{story.title}</h1></div><div className="editor-actions"><select value={story.status} onChange={(event) => update({ status: event.target.value as Story["status"] })}><option value="draft">Draft</option><option value="final">Final</option></select><button className="primary" disabled={!dirty} onClick={() => void save()}>Save</button></div></div>
          {isNew && <label>Folder path<input value={storyPath} placeholder="stories/my-story" onChange={(event) => setStoryPath(event.target.value)} /></label>}
          <div className="metadata-grid"><label>Title<input value={story.title} onChange={(event) => update({ title: event.target.value })} /></label><label>Type<input value={story.story_type} onChange={(event) => update({ story_type: event.target.value })} /></label><label>Min words<input type="number" min={1} value={story.beat_budget.min_words} onChange={(event) => update({ beat_budget: { ...story.beat_budget, min_words: Number(event.target.value) } })} /></label><label>Max words<input type="number" min={1} value={story.beat_budget.max_words} onChange={(event) => update({ beat_budget: { ...story.beat_budget, max_words: Number(event.target.value) } })} /></label><label>Default mode<select value={story.default_narration_mode} onChange={(event) => update({ default_narration_mode: event.target.value })}>{story.narration_modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.id}: {mode.perspective}, {mode.tense}</option>)}</select></label><label className="wide">Premise<textarea value={story.premise} onChange={(event) => update({ premise: event.target.value })} /></label></div>
          <section className="world-editor"><div className="panel-heading"><h2>World</h2><span>Characters, locations, narration, and canon</span></div>
            <details open><summary>Characters <span>{story.characters.length}</span></summary><div className="world-list">{story.characters.map((character, index) => <article className="world-item" key={index}>
              <div className="world-item-heading"><strong>{character.name || character.id || `Character ${index + 1}`}</strong><button className="icon-button danger" title="Delete character" onClick={() => removeCharacter(index)}>×</button></div>
              <div className="world-fields"><label>ID<input value={character.id} onChange={(event) => changeCharacter(index, { id: event.target.value })} /></label><label>Name<input value={character.name} onChange={(event) => changeCharacter(index, { name: event.target.value })} /></label><label className="wide">Description<textarea value={character.description} onChange={(event) => changeCharacter(index, { description: event.target.value })} /></label><label className="wide">Appearance<textarea value={character.appearance} onChange={(event) => changeCharacter(index, { appearance: event.target.value })} /></label><label className="wide">Attributes<textarea value={character.attributes.join("\n")} placeholder="One attribute per line" onChange={(event) => changeCharacter(index, { attributes: event.target.value.split("\n") })} /></label>
                {statesEditor("characters", index, character.states)}
                <fieldset className="wide"><legend>Relations</legend>{character.relations.map((relation, relationIndex) => <div className="relation-row" key={relationIndex}><select aria-label="Related character" value={relation.to} onChange={(event) => changeCharacter(index, { relations: character.relations.map((item, itemIndex) => itemIndex === relationIndex ? { ...item, to: event.target.value } : item) })}>{story.characters.filter((_, itemIndex) => itemIndex !== index).map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select><input aria-label="Relation kind" value={relation.kind} placeholder="Relation" onChange={(event) => changeCharacter(index, { relations: character.relations.map((item, itemIndex) => itemIndex === relationIndex ? { ...item, kind: event.target.value } : item) })} /><button className="icon-button danger" title="Delete relation" onClick={() => changeCharacter(index, { relations: character.relations.filter((_, itemIndex) => itemIndex !== relationIndex) })}>×</button></div>)}<button className="compact-button" disabled={story.characters.length < 2} onClick={() => changeCharacter(index, { relations: [...character.relations, { to: story.characters.find((_, itemIndex) => itemIndex !== index)!.id, kind: "" }] })}>Add relation</button></fieldset>
              </div></article>)}<button className="secondary add-world-item" onClick={() => update({ characters: [...story.characters, { id: `character-${story.characters.length + 1}`, name: "", description: "", appearance: "", relations: [], attributes: [], states: [] }] })}>Add character</button>{entityDesigner("character")}</div></details>
            <details open><summary>Locations <span>{story.locations.length}</span></summary><div className="world-list">{story.locations.map((location, index) => <article className="world-item" key={index}><div className="world-item-heading"><strong>{location.name || location.id || `Location ${index + 1}`}</strong><button className="icon-button danger" title="Delete location" onClick={() => removeLocation(index)}>×</button></div><div className="world-fields"><label>ID<input value={location.id} onChange={(event) => changeLocation(index, { id: event.target.value })} /></label><label>Name<input value={location.name} onChange={(event) => changeLocation(index, { name: event.target.value })} /></label><label className="wide">Description<textarea value={location.description} onChange={(event) => changeLocation(index, { description: event.target.value })} /></label><label className="wide">Details<textarea value={location.details.join("\n")} placeholder="One detail per line" onChange={(event) => changeLocation(index, { details: event.target.value.split("\n") })} /></label>{statesEditor("locations", index, location.states)}</div></article>)}<button className="secondary add-world-item" onClick={() => update({ locations: [...story.locations, { id: `location-${story.locations.length + 1}`, name: "", description: "", details: [], states: [] }] })}>Add location</button>{entityDesigner("location")}</div></details>
            <details><summary>Narration modes <span>{story.narration_modes.length}</span></summary><div className="world-list">{story.narration_modes.map((mode, index) => <article className="world-item" key={index}><div className="world-item-heading"><strong>{mode.id || `Mode ${index + 1}`}</strong><button className="icon-button danger" disabled={story.narration_modes.length === 1} title="Delete narration mode" onClick={() => removeMode(index)}>×</button></div><div className="world-fields"><label>ID<input value={mode.id} onChange={(event) => changeMode(index, { id: event.target.value })} /></label><label>Perspective<input value={mode.perspective} onChange={(event) => changeMode(index, { perspective: event.target.value })} /></label><label>Tense<input value={mode.tense} onChange={(event) => changeMode(index, { tense: event.target.value })} /></label><label>Kind<select value={mode.kind ?? "replace"} disabled={mode.id === story.default_narration_mode} onChange={(event) => changeMode(index, { kind: event.target.value as "replace" | "supplemental" })}><option value="replace">Replace default rules</option><option value="supplemental">Add to default rules</option></select></label><label className="wide">Rules<textarea value={mode.rules.join("\n")} placeholder="One rule per line" onChange={(event) => changeMode(index, { rules: event.target.value.split("\n") })} /></label>{examplesEditor(index, "positive_examples", "Positive examples")}{examplesEditor(index, "negative_examples", "Negative examples")}</div></article>)}<button className="secondary add-world-item" onClick={() => update({ narration_modes: [...story.narration_modes, { id: `mode-${story.narration_modes.length + 1}`, perspective: "third-person limited", tense: "past", rules: ["Keep the viewpoint consistent."], positive_examples: [], negative_examples: [], kind: "replace" }] })}>Add mode</button></div></details>
            <details><summary>Hard canon facts <span>{story.facts.length}</span></summary><div className="world-list">
              <p className="field-hint">World and plot canon only. Canon about one character or location belongs on that subject: permanent traits in its description, anything that changes in a state.</p>
              {story.facts.map((fact, index) => { const selector = factSelector(fact); return <article className="world-item" key={index}>
                <div className="world-item-heading"><strong>{fact.id || `Fact ${index + 1}`}</strong><button className="icon-button danger" title="Delete fact" onClick={() => removeFact(index)}>×</button></div>
                <div className="world-fields">
                  <label>ID<input value={fact.id} onChange={(event) => changeFact(index, { id: event.target.value })} /></label>
                  <label>Applies to<select value={selector} onChange={(event) => changeFactSelector(index, event.target.value as "beats" | "subjects" | "always")}>
                    <option value="always">Every beat in its window</option>
                    <option value="beats">Only the beats I pick</option>
                    <option value="subjects">Beats where a subject is present</option>
                  </select></label>
                  <label className="wide">Fact<textarea value={fact.fact} onChange={(event) => changeFact(index, { fact: event.target.value })} /></label>
                  {selector === "beats"
                    ? <fieldset className="wide"><legend>Pinned beats</legend>
                        <p className="field-hint">Pick each beat this matters in. Nothing in between is affected, and the window below does not apply.</p>
                        <div className="reference-options">{story.beats.length === 0 ? <span>No beats yet</span> : story.beats.map((beat, beatIndex) => <label key={beat.id}><input type="checkbox" checked={fact.beats.includes(beat.id)} onChange={(event) => toggleFactBeat(index, beat.id, event.target.checked)} />{beatIndex + 1}. {beat.id}</label>)}</div>
                      </fieldset>
                    : <>
                        {selector === "subjects" && <fieldset className="wide"><legend>Subjects</legend>
                          <p className="field-hint">Applies wherever any of these is on stage, including beats not written yet.</p>
                          <div className="reference-options">{[...story.characters, ...story.locations].map((subject) => <label key={subject.id}><input type="checkbox" checked={fact.subjects.includes(subject.id)} onChange={(event) => toggleFactSubject(index, subject.id, event.target.checked)} />{subject.name || subject.id}</label>)}</div>
                        </fieldset>}
                        <label>Known from<select value={fact.from ?? ""} onChange={(event) => changeFact(index, { from: event.target.value || undefined })}><option value="">the first beat</option>{beatOptions()}</select></label>
                        <label>Stops applying<select value={fact.until ?? ""} onChange={(event) => changeFact(index, { until: event.target.value || undefined })}><option value="">never</option>{beatOptions()}</select></label>
                      </>}
                </div></article>; })}<button className="secondary add-world-item" onClick={() => update({ facts: [...story.facts, { id: `fact-${story.facts.length + 1}`, fact: "", beats: [], subjects: [] }] })}>Add fact</button></div></details>
          </section>
          <section className="beats-editor"><div className="panel-heading"><h2>Beats</h2><button className="secondary" onClick={addBeat}>Add beat</button></div>
          {suggestions.length > 0 && <div className="beat-suggestions"><strong>Suggestions from designed beats</strong>{suggestions.map((item) => <div className="suggestion-row" key={item.id}><span className="suggestion-type">{item.type}</span><span className="suggestion-content">{item.content}</span><button className="icon-button" title="Dismiss suggestion" onClick={() => dismissSuggestion(item.id)}>×</button></div>)}</div>}
          {beatSlot(0)}
          {story.beats.map((beat, index) => <Fragment key={beat.id}><article className="beat-editor">
            <div className="beat-toolbar"><strong>{String(index + 1).padStart(2, "0")}</strong><input className="beat-id" aria-label="Beat ID" value={beat.id} title="State and fact windows refer to this id" onChange={(event) => renameBeat(index, event.target.value)} /><select aria-label="Location" value={beat.location} onChange={(event) => changeBeat(index, { location: event.target.value })}>{story.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select><button className="icon-button" title="Move up" onClick={() => moveBeat(index, -1)}>↑</button><button className="icon-button" title="Move down" onClick={() => moveBeat(index, 1)}>↓</button><button className="icon-button danger" title="Delete beat" onClick={() => update({ beats: story.beats.filter((_, beatIndex) => beatIndex !== index) })}>×</button></div>
            <div className="beat-fields">
              <label className="wide">Title<input value={beat.title ?? ""} placeholder="Shown only in the reader's beat map, never in the prose" onChange={(event) => changeBeat(index, { title: event.target.value })} /></label>
              <label className="wide">Outcomes<textarea value={beat.events.join("\n")} placeholder={"One per line. Each must be true when the beat ends,\nnot a script of how it happens."} onChange={(event) => changeBeat(index, { events: event.target.value.split("\n") })} /></label>
              <label>Time<input value={beat.time ?? ""} placeholder="Three weeks later" title="Fill this in whenever the beat does not open where the previous one stopped" onChange={(event) => changeBeat(index, { time: event.target.value })} /></label>
              <label>Narration mode<select value={beat.narration_mode ?? ""} onChange={(event) => changeBeat(index, { narration_mode: event.target.value || undefined })}><option value="">Story default</option>{story.narration_modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.id}: {mode.perspective}, {mode.tense}</option>)}</select></label>
              <fieldset className="wide"><legend>Characters</legend><div className="reference-options">{story.characters.length === 0 ? <span>None defined</span> : story.characters.map((character) => <label key={character.id}><input type="checkbox" checked={beat.characters.includes(character.id)} onChange={(event) => toggleBeatCharacter(index, character.id, event.target.checked)} />{character.name || character.id}</label>)}</div></fieldset>
              <details className="beat-advanced"><summary>Advanced guidance <span>keywords and narration rules</span></summary>
                <label>Keywords<KeywordsEditor keywords={beat.keywords} onChange={(keywords) => changeBeat(index, { keywords })} /></label>
                <label>Narration rules<textarea value={beat.narration_rules.join("\n")} placeholder="One rule per line" onChange={(event) => changeBeat(index, { narration_rules: event.target.value.split("\n") })} /></label>
              </details>
            </div>
          </article>{beatSlot(index + 1)}</Fragment>)}
          <div className="panel-heading"><button className="secondary" onClick={addBeat}>Add beat</button><button className="primary" disabled={!dirty} onClick={() => void save()}>Save</button></div></section>
          {notice && <div className="notice">{notice}</div>}{error && <div className="error">{error}</div>}
        </>}
      </section>
      <div className="chat-resizer" role="separator" aria-orientation="vertical" aria-label="Resize model collaborator panel" tabIndex={0} onMouseDown={beginChatResize} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); nudgeChatWidth(20); } else if (event.key === "ArrowRight") { event.preventDefault(); nudgeChatWidth(-20); } }} />
      <aside className="author-chat"><div className="panel-heading"><h2>Model collaborator</h2><div className="chat-heading-actions"><select aria-label="Reasoning mode" value={reasoningMode} onChange={(event) => setReasoningMode(event.target.value as ReasoningMode)}><option value="native">Native reasoning</option><option value="template_think">Template /think ([THINK])</option><option value="think">XML &lt;think&gt;</option><option value="thinking">XML &lt;thinking&gt;</option></select><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item}>{item}</option>)}</select><button className="icon-button" disabled={chatBusy || messages.length === 0} title="New chat" aria-label="New chat" onClick={beginNewChat}>+</button></div></div><div className="chat-log">{messages.length === 0 && <p>Ask the model to create, inspect, or expand a story. Changes are applied through validated MCP tools.</p>}{messages.map((message, index) => <div key={index} className={`chat-message ${message.role}`}>{message.role === "assistant" && message.reasoning && <details className="collaborator-reasoning"><summary>Reasoning <span>{chatBusy && index === messages.length - 1 ? "live" : "trace"}</span></summary><pre>{message.reasoning}</pre></details>}{message.tools && message.tools.length > 0 && <div className="chat-tools">{message.tools.map((tool, toolIndex) => <span className="tool-chip" key={toolIndex}>{tool}</span>)}</div>}<div className="chat-output">{message.text || (message.stopped ? "Stopped." : message.failed ? "Request failed." : message.noFinal ? "Reasoning finished without a final answer." : "Working...")}</div>{message.noFinal && index === messages.length - 1 && !chatBusy && <button className="secondary output-draft" onClick={() => void chat("Output the complete draft answer.")}>Output draft</button>}</div>)}</div><div className="chat-input"><textarea value={chatInput} disabled={chatBusy} placeholder="Expand the midpoint with two escalating beats..." onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void chat(); } }} />{chatBusy ? <button className="danger stop-button" onClick={cancelChat}>Stop</button> : <button className="primary" disabled={!chatInput.trim()} onClick={() => void chat()}>Send</button>}</div></aside>
    </div>
  </main>;
}
