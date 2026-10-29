import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, Trash2, Upload, X } from "lucide-react";
import type { ReaderState } from "../../src/reader-store";

type Language = "en" | "nl";
interface Chapter {
  key: string;
  filename: string;
  markdown: string;
  title: string;
  language: "" | Language;
  word_count?: number;
  preview?: string;
}

export function BookImport({ onClose, onImported }: { onClose: () => void; onImported: (state: ReaderState) => void }) {
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [error, setError] = useState("");

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(""); setPreviewed(false);
    try {
      const sorted = Array.from(files).sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
      if (chapters.length + sorted.length > 200) throw new Error("Select at most 200 chapter files.");
      const added = await Promise.all(sorted.map(async (file): Promise<Chapter> => {
        if (file.size > 2_000_000) throw new Error(`${file.name} exceeds the 2 MB chapter limit.`);
        if (!/\.(md|markdown)$/i.test(file.name)) throw new Error("Select Markdown chapter files.");
        return { key: crypto.randomUUID(), filename: file.name, markdown: await file.text(), title: "", language: "" };
      }));
      setChapters((current) => [...current, ...added]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function move(index: number, direction: number) {
    const next = [...chapters];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setChapters(next); setPreviewed(false);
  }

  async function submit(preview: boolean) {
    setBusy(true); setError("");
    try {
      const response = await fetch(preview ? "/api/books/preview" : "/api/books/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, language, chapters: chapters.map((chapter) => ({
          filename: chapter.filename, markdown: chapter.markdown,
          ...(chapter.title.trim() ? { title: chapter.title.trim() } : {}),
          ...(chapter.language ? { language: chapter.language } : {}),
        })) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cannot import book.");
      if (!preview) { onImported(result as ReaderState); return; }
      setChapters((current) => current.map((chapter, index) => ({ ...chapter, title: result.chapters[index].title,
        word_count: result.chapters[index].word_count, preview: result.chapters[index].preview })));
      setPreviewed(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <div className="modal-overlay" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}>
    <section className="modal book-import" role="dialog" aria-modal="true" aria-label="Import Markdown book">
      <div className="modal-heading"><h2>Import book</h2><button className="icon-button" aria-label="Close book import" title="Close book import" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <div className="book-import-fields">
        <label className="modal-field">Book title<input autoFocus aria-label="Book title" value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="modal-field">Book language<select aria-label="Book language" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">English</option><option value="nl">Nederlands</option></select></label>
      </div>
      <label className="modal-field">Chapters<input type="file" aria-label="Chapter Markdown files" accept=".md,.markdown,text/markdown" multiple disabled={busy} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} /></label>
      <ol className="import-chapters">{chapters.map((chapter, index) => <li key={chapter.key}>
        <div className="import-chapter-heading"><strong>{index + 1}. {chapter.filename}</strong><div className="import-chapter-actions">
          <button className="icon-button" aria-label={`Move chapter ${index + 1} up`} title="Move chapter up" disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
          <button className="icon-button" aria-label={`Move chapter ${index + 1} down`} title="Move chapter down" disabled={busy || index + 1 === chapters.length} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
          <button className="icon-button danger" aria-label={`Remove chapter ${index + 1}`} title="Remove chapter" disabled={busy} onClick={() => { setChapters((current) => current.filter((item) => item.key !== chapter.key)); setPreviewed(false); }}><Trash2 size={16} /></button>
        </div></div>
        <div className="book-import-fields">
          <label className="modal-field">Title<input aria-label={`Chapter ${index + 1} title`} value={chapter.title} maxLength={300} disabled={busy} placeholder={chapter.filename.replace(/\.(md|markdown)$/i, "")} onChange={(event) => setChapters((current) => current.map((item) => item.key === chapter.key ? { ...item, title: event.target.value } : item))} /></label>
          <label className="modal-field">Language<select aria-label={`Chapter ${index + 1} language`} value={chapter.language} disabled={busy} onChange={(event) => setChapters((current) => current.map((item) => item.key === chapter.key ? { ...item, language: event.target.value as Chapter["language"] } : item))}><option value="">Book language</option><option value="en">English</option><option value="nl">Nederlands</option></select></label>
        </div>
        {chapter.preview && <details><summary>{chapter.word_count} words</summary><p className="chapter-preview">{chapter.preview}</p></details>}
      </li>)}</ol>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="secondary" disabled={busy || !title.trim() || !chapters.length} onClick={() => void submit(true)}><Eye size={18} />Preview chapters</button><button className="primary" disabled={busy || !previewed || !title.trim() || !chapters.length} onClick={() => void submit(false)}><Upload size={18} />{busy ? "Working..." : "Import book"}</button></div>
    </section>
  </div>;
}