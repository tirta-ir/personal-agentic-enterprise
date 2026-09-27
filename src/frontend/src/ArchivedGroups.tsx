import { useState } from "react";
import { Archive, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { Group } from "./bindings/Group";
import { post } from "./api";

export function ArchivedGroups({ open, onClose, groups, onOpen, onRefresh }: {
  open: boolean; onClose: () => void; groups: Group[]; onOpen: (id: string) => void; onRefresh: () => Promise<void>;
}) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const archived = groups.filter((g) => g.archived_at && !g.deleted_at).sort((a, b) => a.name.localeCompare(b.name));
  async function restore(group: Group) {
    setRestoring(group.id); setError(""); setNotice("");
    try { await post(`/groups/${group.id}/restore`); await onRefresh(); setNotice(`${group.name} restored. Scheduled tasks remain paused.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRestoring(null); }
  }
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent className="archive-dialog"><DialogHeader><DialogTitle>Archived groups</DialogTitle>
      <DialogDescription>Preview saved conversations or restore a group. Its scheduled tasks stay paused until you resume them.</DialogDescription>
    </DialogHeader>
      {error && <p role="alert" className="schedule-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ul className="archived-group-list">
        {archived.map((group) => <li key={group.id}>
          <Archive size={18} /><div><strong>{group.name}</strong><p>{group.description}</p><small>Archived {new Date(group.archived_at!).toLocaleDateString()} · Can be restored</small></div>
          <div className="archive-actions"><Button size="sm" variant="ghost" onClick={() => { onOpen(group.id); onClose(); }}>Preview {group.name}</Button>
            <Button size="sm" variant="outline" disabled={!!restoring} onClick={() => void restore(group)}><RotateCcw size={14} />{restoring === group.id ? "Restoring…" : `Restore ${group.name}`}</Button></div>
        </li>)}
      </ul>
      {!archived.length && <p className="muted">No archived groups.</p>}
    </DialogContent>
  </Dialog>;
}
