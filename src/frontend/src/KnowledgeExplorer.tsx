import { useEffect, useState } from "react";
import {
  ChevronRight,
  Download,
  File,
  FileText,
  FolderOpen,
  Image,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Artifact } from "./bindings/Artifact";
import { api, post } from "./api";

const category = (file: Artifact) =>
  file.media_type.startsWith("image/")
    ? "Images"
    : file.media_type.startsWith("text/")
      ? "Documents"
      : "Other files";
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const status = (file: Artifact) =>
  ({
    stored: "Not searchable",
    indexing: "Preparing search…",
    indexed: "Searchable",
    failed: "Search failed",
  })[file.status] ?? file.status;

// Adapt the existing artifact upload/index/download flow to VS Code's
// explorer + single-file preview interaction. See UPSTREAM.md.
export function KnowledgeExplorer({
  readOnly = false,
  files,
  groupName,
  onUpload,
  onRefresh,
  perform,
}: {
  readOnly?: boolean;
  files: Artifact[];
  groupName: string;
  onUpload: () => void;
  onRefresh: () => Promise<void>;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [folder, setFolder] = useState("All files");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<"name" | "created_at" | "size">("name");
  const [ascending, setAscending] = useState(true);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(false);
  const file = files.find((f) => f.id === selected);
  const visible = files
    .filter(
      (f) =>
        (folder === "All files" || category(f) === folder) &&
        f.name.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (sort === "size"
          ? a.size - b.size
          : a[sort].localeCompare(b[sort], undefined, { numeric: true })) *
        (ascending ? 1 : -1),
    );
  useEffect(() => {
    if (!file?.media_type.startsWith("text/") || file.size > 256 * 1024) return;
    const controller = new AbortController();
    void fetch(`/api/artifacts/${file.id}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Unable to preview this file. Try opening it again.");
        const text = await response.text();
        if (!controller.signal.aborted) {
          setPreview(text);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPreviewError(
            error instanceof Error ? error.message : String(error),
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [file?.id, file?.media_type, file?.size]);
  function open(next: Artifact) {
    if (next.id === selected) return;
    setPreview("");
    setPreviewError("");
    setLoading(next.media_type.startsWith("text/") && next.size <= 256 * 1024);
    setSelected(next.id);
  }
  function sortBy(next: typeof sort) {
    setAscending(next === sort ? !ascending : true);
    setSort(next);
  }
  return (
    <section className="knowledge-explorer" aria-label="Knowledge files">
      <div className="explorer-toolbar">
        <div className="explorer-breadcrumb">
          <FolderOpen size={17} />
          <span>{groupName}</span>
          <ChevronRight size={14} />
          <strong>Knowledge</strong>
        </div>
        <Button disabled={readOnly} onClick={onUpload}>
          <Plus size={16} /> Upload files
        </Button>
      </div>
      <div className="explorer-layout">
        <nav className="explorer-folders" aria-label="File categories">
          <p>EXPLORER</p>
          {["All files", "Documents", "Images", "Other files"].map((name) => (
            <button
              key={name}
              className={folder === name ? "selected" : ""}
              aria-pressed={folder === name}
              onClick={() => {
                setFolder(name);
                setSelected(null);
              }}
            >
              {name === "Images" ? (
                <Image size={16} />
              ) : name === "Documents" ? (
                <FileText size={16} />
              ) : (
                <FolderOpen size={16} />
              )}
              <span>{name}</span>
              <small>
                {
                  files.filter(
                    (f) => name === "All files" || category(f) === name,
                  ).length
                }
              </small>
            </button>
          ))}
        </nav>
        <div className="explorer-content">
          <div className="explorer-filter">
            <Search size={16} />
            <Input
              aria-label="Filter files"
              placeholder="Find a file…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="file-table-scroll">
            <table className="file-table" aria-label="Files">
              <thead>
                <tr>
                  <th
                    aria-sort={
                      sort === "name"
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortBy("name")}>
                      Name {sort === "name" && (ascending ? "↑" : "↓")}
                    </button>
                  </th>
                  <th
                    aria-sort={
                      sort === "size"
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortBy("size")}>
                      Size {sort === "size" && (ascending ? "↑" : "↓")}
                    </button>
                  </th>
                  <th
                    aria-sort={
                      sort === "created_at"
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortBy("created_at")}>
                      Added {sort === "created_at" && (ascending ? "↑" : "↓")}
                    </button>
                  </th>
                  <th>Search</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr
                    key={item.id}
                    className={item.id === selected ? "selected" : ""}
                    onClick={() => open(item)}
                  >
                    <td>
                      <button
                        className="file-name"
                        onClick={() => open(item)}
                        title={item.name}
                        aria-pressed={item.id === selected}
                      >
                        {item.media_type.startsWith("image/") ? (
                          <Image size={16} />
                        ) : (
                          <FileText size={16} />
                        )}
                        <span>{item.name}</span>
                      </button>
                    </td>
                    <td>{size(item.size)}</td>
                    <td>
                      <time dateTime={item.created_at}>
                        {new Date(item.created_at).toLocaleDateString()}
                      </time>
                    </td>
                    <td>
                      <span className={`file-status ${item.status}`}>
                        {status(item)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div className="empty-state">
                <FolderOpen size={28} />
                <h3>{files.length ? "No matching files" : "No files yet"}</h3>
                <p>
                  {files.length
                    ? "Try another name or category."
                    : "Upload documents or images to keep them with this conversation."}
                </p>
              </div>
            )}
          </div>
          <div className="explorer-status">
            {visible.length} {visible.length === 1 ? "file" : "files"}
            {file && ` · ${file.name}`}
          </div>
        </div>
      </div>
      {file && (
        <section
          className="knowledge-preview"
          aria-label={`Preview ${file.name}`}
        >
          <header>
            <strong>
              <File size={15} />
              {file.name}
            </strong>
            <button
              aria-label="Close file preview"
              onClick={() => setSelected(null)}
            >
              <X size={17} />
            </button>
          </header>
          <div className="preview-content">
            {file.media_type.startsWith("image/") &&
            file.media_type !== "image/svg+xml" ? (
              <img src={`/api/artifacts/${file.id}`} alt={file.name} />
            ) : file.media_type.startsWith("text/") &&
              file.size <= 256 * 1024 ? (
              <pre>{loading ? "Loading…" : preview}</pre>
            ) : (
              <p className="muted">
                Download this file to open it in your preferred app.
              </p>
            )}
            {previewError && (
              <p role="alert" className="error">
                {previewError}
              </p>
            )}
            {file.error && (
              <p role="alert" className="error">
                {file.error}
              </p>
            )}
          </div>
          <footer>
            <a
              className="file-download"
              href={`/api/artifacts/${file.id}`}
              download={file.name}
            >
              <Download size={15} /> Download
            </a>
            {category(file) !== "Other files" && (
              <Button
                variant="outline"
                disabled={readOnly || file.status === "indexing"}
                onClick={() =>
                  void perform(async () => {
                    await post(`/artifacts/${file.id}/index`);
                    await onRefresh();
                  })
                }
              >
                {file.status === "indexing"
                  ? "Preparing search…"
                  : file.status === "indexed"
                    ? "Update search"
                    : "Make searchable"}
              </Button>
            )}
            <Button
              variant="ghost"
              aria-label={`Delete ${file.name}`}
              disabled={readOnly}
              onClick={() =>
                void perform(async () => {
                  await api(`/artifacts/${file.id}`, { method: "DELETE" });
                  setSelected(null);
                  await onRefresh();
                })
              }
            >
              <Trash2 size={15} /> Delete
            </Button>
          </footer>
        </section>
      )}
    </section>
  );
}
