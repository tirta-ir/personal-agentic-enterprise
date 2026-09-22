import { useEffect, useState } from "react";
import { Archive, RotateCcw, Trash2, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { GroupInvites } from "./GroupInvites";
import { RuntimeSelect } from "./RuntimeSettings";
import { WorkstationSelect } from "./WorkstationSelect";
import type { Workstation } from "./bindings/Workstation";
import { FolderPicker } from "./FolderPicker";
import { api, post } from "./api";
import type { Group } from "./bindings/Group";
import type { Agent } from "./bindings/Agent";

export function GroupDialog({ controllerAccess, group, agents, workstations, onClose, onSaved }: {
  controllerAccess: boolean; group: Group; agents: Agent[]; workstations: Workstation[]; onClose: () => void; onSaved: (group: Group) => Promise<void>;
}) {
  const [draft, setDraft] = useState(group);
  const [people, setPeople] = useState<{user:string;role:string}[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(()=>{void api<{user:string;role:string}[]>("/people").then(setPeople,e=>setError(String(e)));},[]);
  const closed = !!(group.archived_at || group.deleted_at);
  const available = agents.filter(a => draft.project ? !a.project_id || a.project_id === draft.id : !a.project_id);
  const members = available.filter(a => !draft.project || draft.project.members.some(m=>m.agent_id===a.id)).map((agent) => {
    let level = 1;
    let manager = draft.project ? draft.project.members.find(m=>m.agent_id===agent.id)?.manager_id : agent.reports_to;
    const seen = new Set([agent.id]);
    while (manager && !seen.has(manager)) {
      seen.add(manager); level++;
      manager = draft.project ? draft.project.members.find(m=>m.agent_id===manager)?.manager_id : agents.find((person) => person.id === manager)?.reports_to ?? null;
    }
    return { agent, level };
  });
  const selected = new Set(draft.member_ids ?? members.filter(m => !draft.scope_levels || draft.scope_levels.includes(m.level)).map(m => m.agent.id));
  async function perform(action: () => Promise<Group>) {
    setBusy(true); setError("");
    try { await onSaved(await action()); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="group-settings-dialog">
      <DialogHeader>
        <DialogTitle>{confirm ? `${confirm === "archive" ? "Archive" : "Delete"} group?` : group.id ? (draft.project ? "Manage project" : "Manage group") : (draft.project ? "Create a project" : "Create a group")}</DialogTitle>
        <DialogDescription>{confirm
          ? confirm === "archive" ? `${group.name} will move to Archived groups beside Sign out. Conversations, files, sessions and runs are kept. Scheduled tasks pause. You can restore it anytime.`
            : `${group.name} will be hidden from the platform. Its stored history is retained and scheduled tasks pause. Deleted groups are not listed in the archive.`
          : closed ? "This group is read-only. Restore it to continue. Scheduled tasks stay paused until you resume them."
          : draft.project && !group.id ? "Choose a name and workdir. Set up the team after creating the project."
          : "Invite people and agents to this room. Only included agents can receive work."}</DialogDescription>
      </DialogHeader>
      {error && <p className="banner error" role="alert">{error}</p>}
      {confirm ? <div className="group-lifecycle-actions">
        <Button variant="outline" disabled={busy} onClick={() => { setConfirm(null); setError(""); }}>Cancel</Button>
        <Button variant={confirm === "delete" ? "destructive" : "default"} disabled={busy}
          onClick={() => void perform(() => confirm === "delete"
            ? api<Group>(`/groups/${group.id}`, { method: "DELETE" })
            : post<Group>(`/groups/${group.id}/archive`))}>
          {confirm === "delete" ? "Delete group" : "Archive group"}
        </Button>
      </div> : <>
        <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (!closed) void perform(() => post<Group>("/groups", !group.id && draft.project ? { ...draft, project: { ...draft.project, members: [] }, chat_lead_id: null, scope_levels: null } : { ...draft, member_ids: draft.project ? undefined : [...selected], scope_levels:null, chat_lead_id:null })); }}>
          <Label htmlFor="group-name">Name</Label>
          <Input id="group-name" value={draft.name} disabled={busy || closed} required maxLength={80}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Label htmlFor="group-description">Description</Label>
          <Input id="group-description" value={draft.description} disabled={busy || closed}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          {draft.project && <>
            <RuntimeSelect disabled={busy || closed} allowController={controllerAccess} required={!controllerAccess} value={draft.project.workdir.runtime_id ?? ""} onChange={id=>setDraft({...draft,project:{...draft.project!,workdir:{...draft.project!.workdir,runtime_id:id||undefined,ssh_host:null,path:"",canonical_path:""}}})}/>
            {controllerAccess && !draft.project.workdir.runtime_id && <WorkstationSelect id="project-host" value={draft.project.workdir.ssh_host ?? ""} workstations={workstations} disabled={busy || closed}
              onChange={host => setDraft({ ...draft, project: { ...draft.project!, workdir: { ...draft.project!.workdir, ssh_host: host || null, path: "", canonical_path: "", git_root: null } } })}/> }
            <Label htmlFor="project-workdir">Project workdir</Label>
            <div className="project-workdir-row"><Input id="project-workdir" required value={draft.project.workdir.path} disabled={busy||closed} onChange={e=>setDraft({...draft,project:{...draft.project!,workdir:{...draft.project!.workdir,path:e.target.value}}})}/><Button type="button" variant="outline" disabled={busy||closed||(!draft.project.workdir.runtime_id&&!controllerAccess)} onClick={()=>setFolderOpen(true)}><FolderOpen size={15}/>Browse</Button></div>
            <p className="hint">Every project run uses this workdir and workstation, overriding each agent's default. Sessions remain separate from other chats.</p>
            <p className="hint">{group.id ? "Manage agents and reporting lines in the project's Structure tab." : "Your project starts with an empty team. Next, configure agents in the Structure tab."}</p>
          </>}
          <GroupInvites agents={draft.project ? [] : available} people={people} memberIds={[...selected]} humanIds={draft.human_ids}
            disabled={busy || closed} onChange={(member_ids, human_ids) => setDraft({...draft, member_ids, human_ids, scope_levels:null, chat_lead_id:null})}/>
          {!closed && <Button type="submit" disabled={busy || draft.scope_levels?.length === 0}>{draft.project ? group.id ? "Save project" : "Create project" : "Save group"}</Button>}
        </form>
        {!!group.id && <div className="group-lifecycle-actions">
          {closed ? <Button disabled={busy} onClick={() => void perform(() => post<Group>(`/groups/${group.id}/restore`))}><RotateCcw size={15} /> Restore group</Button>
            : <Button variant="outline" disabled={busy} onClick={() => setConfirm("archive")}><Archive size={15} /> Archive group</Button>}
          {!group.deleted_at && <Button variant="destructive" disabled={busy} onClick={() => setConfirm("delete")}><Trash2 size={15} /> Delete group</Button>}
        </div>}
      </>}
      {folderOpen&&draft.project&&<FolderPicker runtimeId={draft.project.workdir.runtime_id??undefined} initialPath={draft.project.workdir.path} sshHost={draft.project.workdir.ssh_host??undefined} onClose={()=>setFolderOpen(false)} onSelect={path=>{setDraft({...draft,project:{...draft.project!,workdir:{...draft.project!.workdir,path}}});setFolderOpen(false);}}/>}
    </DialogContent>
  </Dialog>;
}
