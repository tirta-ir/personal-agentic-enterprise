import { useEffect, useState } from "react";
import { ArrowLeft, Folder, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "./api";
import type { DirectoryView } from "./bindings/DirectoryView";

// Folder browsing follows VS Code's web file-dialog flow; selection uses the existing workdir API.
export function FolderPicker({
  initialPath,
  sshHost,
  runtimeId,
  onSelect,
  onClose,
}: {
  initialPath: string;
  sshHost?: string;
  runtimeId?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<DirectoryView | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [request, setRequest] = useState({ path: initialPath });
  function browse(path: string) {
    setRequest({ path });
    setLoading(true);
    setError("");
    setFilter("");
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<DirectoryView>(
      runtimeId ? `/runtimes/${encodeURIComponent(runtimeId)}/directories` : `/workspaces/directories?path=${encodeURIComponent(request.path)}${sshHost ? `&ssh_host=${encodeURIComponent(sshHost)}` : ""}`,
      { signal: controller.signal, ...(runtimeId ? {method: "POST", body: JSON.stringify({path: request.path})} : {}) },
    ).then(
      (next) => {
        if (!controller.signal.aborted) {
          setView(next);
          setLoading(false);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [request, sshHost, runtimeId]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="folder-picker">
        <DialogHeader>
          <DialogTitle>Choose a workdir</DialogTitle>
          <DialogDescription>
            Browse folders on {runtimeId ? "the selected runtime" : sshHost || "this machine"}, then select the codebase your agent
            will use.
          </DialogDescription>
        </DialogHeader>
        <div className="folder-toolbar">
          <Button
            variant="outline"
            aria-label="Parent folder"
            disabled={loading || !view?.parent}
            onClick={() => view?.parent && void browse(view.parent)}
          >
            <ArrowLeft size={16} />
          </Button>
          <span title={view?.path}>
            {view?.path ?? "Folders on this machine"}
          </span>
        </div>
        <div className="folder-browser">
          <nav aria-label="Folder locations">
            <button onClick={() => void browse("")}>
              <Folder size={16} />
              {runtimeId ? "Runtime root" : "Project folder"}
            </button>
            {view?.roots
              .filter((r) => r.name !== "Project folder" && r.name !== "Runtime root")
              .map((root) => (
                <button key={root.path} onClick={() => void browse(root.path)}>
                  <HardDrive size={16} />
                  {root.name}
                </button>
              ))}
          </nav>
          <div className="folder-list">
            <Input
              aria-label="Filter folders"
              placeholder="Filter folders"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div role="status">
              {loading
                ? "Loading folders…"
                : error
                  ? ""
                  : `${view?.folders.length ?? 0} folders`}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
                <button onClick={() => void browse("")}>
                  Open {runtimeId ? "runtime root" : "project folder"}
                </button>
              </p>
            )}
            {!loading &&
              !error &&
              view?.folders
                .filter((folder) =>
                  folder.name.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((folder) => (
                  <button
                    className="folder-row"
                    key={folder.path}
                    onClick={() => void browse(folder.path)}
                  >
                    <Folder size={18} />
                    <span>{folder.name}</span>
                  </button>
                ))}
          </div>
        </div>
        <div className="folder-footer">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={loading || !!error || !view}
            onClick={() => {
              if (view) onSelect(view.path);
            }}
          >
            Select folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
