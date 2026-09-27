import { useState } from "react";
import { Archive, RotateCcw, Trash2, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorkstationSelect } from "./WorkstationSelect";
import type { Workstation } from "./bindings/Workstation";
import { FolderPicker } from "./FolderPicker";
import { api, post } from "./api";
import type { Group } from "./bindings/Group";
import type { Agent } from "./bindings/Agent";

export function GroupDialog({ group, agents, workstations, onClose, onSaved }: {
  group: Group; agents: Agent[]; workstations: Workstation[]; onClose: () => void; onSaved: (group: Group) => Promise<void>;
}) {
  const [draft, setDraft] = useState(group);
  const [folderOpen, setFolderOpen] = useState(false);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const levels = [...new Set([...members.map((member) => member.level), ...(draft.scope_levels ?? []), 1])].sort((a, b) => a - b);
  const participants = members.filter(({ level }) => draft.scope_levels === null || draft.scope_levels.includes(level));
  const workers = members.filter(({ level }) => draft.scope_levels !== null && !draft.scope_levels.includes(level) && draft.scope_levels.some((selected) => selected < level));
  function setLevels(selected: number[] | null) {
    const lead = members.find(({ agent }) => agent.id === draft.chat_lead_id);
    setDraft({ ...draft, scope_levels: selected, chat_lead_id: lead && (selected === null || selected.includes(lead.level)) ? draft.chat_lead_id : null });
  }
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
          : "Choose who participates in this conversation. Lower levels can still receive delegated work."}</DialogDescription>
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
        <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (!closed) void perform(() => post<Group>("/groups", !group.id && draft.project ? { ...draft, project: { ...draft.project, members: [] }, chat_lead_id: null, scope_levels: null } : draft)); }}>
          <Label htmlFor="group-name">Name</Label>
          <Input id="group-name" value={draft.name} disabled={busy || closed} required maxLength={80}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Label htmlFor="group-description">Description</Label>
          <Input id="group-description" value={draft.description} disabled={busy || closed}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          {draft.project && <>
            <WorkstationSelect id="project-host" value={draft.project.workdir.ssh_host ?? ""} workstations={workstations} disabled={busy || closed}
              onChange={host => setDraft({ ...draft, project: { ...draft.project!, workdir: { ...draft.project!.workdir, ssh_host: host || null, path: "", canonical_path: "", git_root: null } } })}/>
            <Label htmlFor="project-workdir">Project workdir</Label>
            <div className="project-workdir-row"><Input id="project-workdir" required value={draft.project.workdir.path} disabled={busy||closed} onChange={e=>setDraft({...draft,project:{...draft.project!,workdir:{...draft.project!.workdir,path:e.target.value}}})}/><Button type="button" variant="outline" disabled={busy||closed} onClick={()=>setFolderOpen(true)}><FolderOpen size={15}/>Browse</Button></div>
            <p className="hint">Every project run uses this workdir and workstation, overriding each agent's default. Sessions remain separate from other chats.</p>
            <p className="hint">{group.id ? "Manage agents and reporting lines in the project's Structure tab." : "Your project starts with an empty team. Next, configure agents in the Structure tab."}</p>
          </>}
          {(!draft.project || !!group.id) && <fieldset className="group-scope" disabled={busy || closed}>
            <legend>Chat permissions</legend>
            <Label htmlFor="group-scope-mode">Who can join the chat</Label>
            <select id="group-scope-mode" value={draft.scope_levels === null ? "all" : "levels"}
              onChange={(e) => setLevels(e.target.value === "all" ? null : [1])}>
              <option value="all">{draft.project?"Entire project team":"Entire organization"}</option>
              <option value="levels">{draft.project?"Selected project levels":"Selected organization levels"}</option>
            </select>
            {draft.scope_levels !== null && <div className="scope-levels">
              {levels.map((level) => <label className="scope-level" key={level}>
                <input type="checkbox" aria-label={`Level ${level}`} checked={draft.scope_levels?.includes(level) ?? false}
                  onChange={(e) => setLevels(e.target.checked ? [...(draft.scope_levels ?? []), level].sort((a, b) => a - b) : (draft.scope_levels ?? []).filter((value) => value !== level))} />
                <span><strong>Level {level}</strong><small>{level === 1 ? "Directly under you" : `Under Level ${level - 1}`}</small></span>
                <span className="muted">{members.filter((member) => member.level === level).length}</span>
              </label>)}
            </div>}
            <div className="scope-preview" aria-label="Group scope preview">
              <strong>{participants.length} chat {participants.length === 1 ? "participant" : "participants"}</strong>
              <p>{participants.map(({ agent }) => agent.name).join(", ") || "Choose at least one level with agents."}</p>
              {draft.scope_levels !== null && <p>{workers.length} lower-level {workers.length === 1 ? "agent can" : "agents can"} receive delegated work. Their results return privately to the assigning agent, who reports to this group.</p>}
            </div>
            <Label htmlFor="group-chat-lead">Group chat lead</Label>
            <select id="group-chat-lead" value={draft.chat_lead_id ?? ""}
              onChange={(e) => setDraft({ ...draft, chat_lead_id: e.target.value || null })}>
              <option value="">Automatic</option>
              {draft.chat_lead_id && !participants.some(({ agent }) => agent.id === draft.chat_lead_id && agent.enabled) && <option value={draft.chat_lead_id} disabled>Current lead is unavailable or outside this scope</option>}
              {participants.filter(({ agent }) => agent.enabled).map(({ agent }) => <option key={agent.id} value={agent.id}>{agent.name}{agent.position ? ` · ${agent.position}` : ""}</option>)}
            </select>
            <p className="hint">Automatic uses your organization chat lead when included, otherwise an agent at the highest included level. A workdir is required to run.</p>
          </fieldset>}
          {!closed && <Button type="submit" disabled={busy || draft.scope_levels?.length === 0}>{draft.project ? group.id ? "Save project" : "Create project" : "Save group"}</Button>}
        </form>
        {!!group.id && <div className="group-lifecycle-actions">
          {closed ? <Button disabled={busy} onClick={() => void perform(() => post<Group>(`/groups/${group.id}/restore`))}><RotateCcw size={15} /> Restore group</Button>
            : <Button variant="outline" disabled={busy} onClick={() => setConfirm("archive")}><Archive size={15} /> Archive group</Button>}
          {!group.deleted_at && <Button variant="destructive" disabled={busy} onClick={() => setConfirm("delete")}><Trash2 size={15} /> Delete group</Button>}
        </div>}
      </>}
      {folderOpen&&draft.project&&<FolderPicker initialPath={draft.project.workdir.path} sshHost={draft.project.workdir.ssh_host??undefined} onClose={()=>setFolderOpen(false)} onSelect={path=>{setDraft({...draft,project:{...draft.project!,workdir:{...draft.project!.workdir,path}}});setFolderOpen(false);}}/>}
    </DialogContent>
  </Dialog>;
}
