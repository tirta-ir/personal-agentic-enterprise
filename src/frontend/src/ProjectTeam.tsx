import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { post } from "./api";
import type { Agent } from "./bindings/Agent";
import type { Group } from "./bindings/Group";

export function ProjectTeam({ group, agents, onSaved, onAdd, onClose }: {
  group: Group; agents: Agent[]; onSaved: () => Promise<void>; onAdd: () => void; onClose: () => void;
}) {
  const [members, setMembers] = useState(group.project?.members ?? []);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = agents.filter(a => !a.project_id && !members.some(m => m.agent_id === a.id));
  async function saveTeam() {
    setBusy(true); setError("");
    try { await post("/groups", { ...group, project: { ...group.project, members }, chat_lead_id: members.some(m => m.agent_id === group.chat_lead_id) ? group.chat_lead_id : null }); await onSaved(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  }
  return <section className="project-team-editor" aria-label="Project team and reporting structure">
    <header><div><h2>Project team</h2><p>Bring in organization agents or create a dedicated project agent. Set reporting lines below.</p></div><Button variant="ghost" onClick={onClose}>Hide team editor</Button></header>
    <div className="project-team-add">
      <Label htmlFor="project-add-member">Organization agent</Label>
      <select id="project-add-member" value={chosen} disabled={busy} onChange={e => setChosen(e.target.value)}><option value="">Choose an agent</option>{available.map(a => <option key={a.id} value={a.id}>{a.name}{a.position ? ` · ${a.position}` : ""}</option>)}</select>
      <Button disabled={busy || !chosen} onClick={() => { setMembers([...members, { agent_id: chosen, manager_id: null }]); setChosen(""); }}><Plus size={14}/>Add to team</Button>
      <Button variant="outline" disabled={busy} onClick={async () => { if (await saveTeam()) onAdd(); }}>Create project agent</Button>
    </div>
    {members.length === 0 && <p className="project-team-empty">No agents yet. Add your first team member to begin.</p>}
    <div className="project-team-list">{members.map(member => {
      const agent = agents.find(a => a.id === member.agent_id);
      return <div className="project-team-row" key={member.agent_id}><div><strong>{agent?.name ?? member.agent_id}</strong><small>{agent?.position || "Agent"} · {agent?.project_id ? "Project agent" : "Organization agent"}</small></div>
        <label>Reports to<select aria-label={`Project manager for ${agent?.name ?? member.agent_id}`} value={member.manager_id ?? ""} disabled={busy} onChange={e => setMembers(members.map(m => m.agent_id === member.agent_id ? { ...m, manager_id: e.target.value || null } : m))}>
          <option value="">Organization owner</option>{members.filter(m => m.agent_id !== member.agent_id).map(m => <option key={m.agent_id} value={m.agent_id}>{agents.find(a => a.id === m.agent_id)?.name ?? m.agent_id}</option>)}
        </select></label>
        <Button variant="ghost" disabled={busy || !!agent?.project_id} title={agent?.project_id ? "Delete dedicated agents from their profile" : "Remove from project"} aria-label={`Remove ${agent?.name} from project`} onClick={() => setMembers(members.filter(m => m.agent_id !== member.agent_id).map(m => m.manager_id === member.agent_id ? { ...m, manager_id: null } : m))}><Trash2 size={15}/></Button>
      </div>;
    })}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <Button disabled={busy} onClick={() => void saveTeam()}>{busy ? "Saving…" : "Save team"}</Button>
  </section>;
}
