import { useEffect, useRef, useState } from "react";
import { Check, Download, FileText, LibraryBig, PanelRightClose } from "lucide-react";
import { MessageMarkdown, type MarkdownFile } from "./MessageMarkdown";
import { Button } from "@/components/ui/button";
import type { Artifact } from "./bindings/Artifact";

const MAX_PREVIEW_BYTES = 1024 * 1024;

export function MarkdownPreview({ file, onClose, onPreview, onAddToKnowledge, artifacts, groupName, readOnly }: {
  file: MarkdownFile;
  onClose: () => void;
  onPreview: (file: MarkdownFile) => void;
  onAddToKnowledge: (file: MarkdownFile, source: Blob) => Promise<Artifact>;
  artifacts: Artifact[];
  groupName: string;
  readOnly: boolean;
}) {
  const [loaded, setLoaded] = useState<{ text: string; source: Blob } | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const saved = artifacts.find((artifact) => artifact.status !== "deleted" && artifact.id === savedId)
    ?? artifacts.find((artifact) => artifact.status !== "deleted" && file.url === `/api/artifacts/${artifact.id}`);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const controller = new AbortController();
    void fetch(file.url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try { detail = (JSON.parse(text) as { error?: string }).error ?? text; }
        catch { /* Preserve plain HTTP error messages. */ }
        throw new Error(detail || `Unable to open this report (${response.status}).`);
      }
      const tooLarge = "This report exceeds the 1 MiB preview limit. Download it to read the full file.";
      if (Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES) throw new Error(tooLarge);
      const source = await response.blob();
      if (source.size > MAX_PREVIEW_BYTES) throw new Error(tooLarge);
      const text = await source.text();
      if (!controller.signal.aborted) setLoaded({ text, source });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [file.url]);

  async function addToKnowledge() {
    if (!loaded || adding || readOnly) return;
    setAdding(true);
    setAddError("");
    try { setSavedId((await onAddToKnowledge(file, loaded.source)).id); }
    catch (error: unknown) { setAddError(error instanceof Error ? error.message : String(error)); }
    finally { setAdding(false); }
  }

  return <aside className="inspector markdown-preview" aria-label="Markdown preview"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="inspector-heading">
      <FileText size={18} aria-hidden="true" />
      <strong title={file.name}>{file.name}</strong>
      <a href={file.url} download={file.name} aria-label="Download Markdown report" title="Download report"><Download size={18} /></a>
      <button ref={close} aria-label="Close Markdown preview" title="Close preview (Esc)" onClick={onClose}><PanelRightClose size={18} /></button>
    </div>
    <div className="markdown-preview-actions">
      <Button variant="outline" size="sm" disabled={readOnly || !loaded || adding || saved?.status === "indexing" || saved?.status === "indexed"}
        onClick={() => void addToKnowledge()}>
        {saved?.status === "indexed" ? <Check size={15} /> : <LibraryBig size={15} />}
        {adding ? "Adding…" : saved?.status === "indexing" ? "Preparing knowledge…" : saved?.status === "indexed" ? "Added to knowledge" : saved?.status === "failed" ? "Retry indexing" : "Add to knowledge"}
      </Button>
      <span className="hint" role="status">{readOnly ? "Restore this group to add knowledge." : saved?.status === "indexed" ? `Searchable in ${groupName}.` : `Save to ${groupName}`}</span>
      {(addError || saved?.status === "failed") && <p role="alert" className="error">{addError || `Saved, but indexing failed: ${saved?.error ?? "Please retry."}`}</p>}
    </div>
    <div className="inspector-body" aria-busy={loaded === null && !error}>
      {error ? <p role="alert" className="error">{error}</p>
        : loaded === null ? <p role="status">Opening report…</p>
        : <div className="markdown"><MessageMarkdown runId={file.runId} basePath={file.path} onPreview={onPreview}>{loaded.text}</MessageMarkdown></div>}
    </div>
  </aside>;
}
