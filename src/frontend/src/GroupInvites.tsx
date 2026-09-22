import { useEffect, useId, useRef, useState } from "react";
import { Bot, Check, Search, Users, X, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Agent } from "./bindings/Agent";

type Invite = { id: string; name: string; detail: string; kind: "agent" | "team" | "person"; ids: string[] };

export function GroupInvites({ agents, people, memberIds, humanIds, disabled, onChange }: {
  agents: Agent[]; people: { user: string; role: string }[]; memberIds: string[];
  humanIds: string[] | undefined; disabled: boolean;
  onChange: (members: string[], humans: string[] | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Invite[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const invited = new Set(memberIds);
  const included = new Set(memberIds);
  for (const id of memberIds) {
    let parent = agents.find(a => a.id === id)?.reports_to;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent); included.add(parent);
      parent = agents.find(a => a.id === parent)?.reports_to;
    }
  }
  function branch(id: string) {
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of agents) if (a.reports_to && ids.has(a.reports_to) && !ids.has(a.id)) { ids.add(a.id); changed = true; }
    }
    return [...ids];
  }
  const candidates: Invite[] = agents.flatMap(a => {
    const team = branch(a.id);
    const options: Invite[] = [];
    if (team.length === 1 && !included.has(a.id)) options.push({ id: `agent:${a.id}`, name: a.name, detail: a.position || "Agent", kind: "agent", ids: [a.id] });
    if (team.length > 1 && team.some(id => !included.has(id))) options.push({ id: `team:${a.id}`, name: `${a.name}'s team`, detail: `${team.length} agents · includes nested teams`, kind: "team", ids: team });
    return options;
  });
  if (humanIds != null) for (const p of people) if (p.role !== "owner" && !humanIds.includes(p.user)) {
    candidates.push({ id: `person:${p.user}`, name: p.user.split(":")[0].replace(/^@/, ""), detail: p.user, kind: "person", ids: [p.user] });
  }
  const results = candidates.filter(c => !pending.some(p => p.id === c.id) && `${c.name} ${c.detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listId]);
  const visiblePeople = people.filter(p => p.role === "owner" || humanIds == null || humanIds.includes(p.user));
  function choose(option: Invite) {
    setPending([...pending, option]); setQuery(""); setActive(0); input.current?.focus();
  }
  function invite() {
    const members = new Set(memberIds), humans = new Set(humanIds);
    for (const option of pending) for (const id of option.ids) (option.kind === "person" ? humans : members).add(id);
    onChange([...members], humanIds == null ? undefined : [...humans]);
    setPending([]); setQuery(""); setOpen(false); input.current?.focus();
  }
  return <section className="group-invites" aria-label="Room invitations">
    <label htmlFor={`${listId}-input`} className="invite-heading">Invite people, agents, or teams</label>
    <div className="invite-picker" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <div className="invite-entry">
        <div className="invite-input-wrap">
          {pending.map(p => <span className="invite-chip" key={p.id}>{p.kind === "team" ? <Users size={13}/> : p.kind === "agent" ? <Bot size={13}/> : <UserRound size={13}/>}<span>{p.name}</span><button type="button" disabled={disabled} aria-label={`Remove pending ${p.name}`} onClick={() => setPending(pending.filter(v => v.id !== p.id))}><X size={13}/></button></span>)}
          <div className="invite-search"><Search size={15} aria-hidden="true"/><input ref={input} id={`${listId}-input`} role="combobox" autoComplete="off" disabled={disabled} placeholder="Search people, agents, or teams…" value={query}
            aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && results.length ? `${listId}-${activeIndex}` : undefined}
            onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true); }}
            onKeyDown={e => {
              if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive(Math.max(0, Math.min(results.length - 1, activeIndex + (e.key === "ArrowDown" ? 1 : -1)))); }
              if (e.key === "Enter") { e.preventDefault(); if (open && results[activeIndex]) choose(results[activeIndex]); else if (pending.length) invite(); }
            }}/></div>
        </div>
        <Button type="button" disabled={disabled || !pending.length} onClick={invite}>Invite</Button>
      </div>
      {open && !disabled && <div className="invite-results" id={listId} role="listbox" aria-label="Invitation suggestions">
        <p className="invite-list-label" role="presentation">Not invited to this room</p>
        {results.map((option, index) => <button type="button" role="option" aria-selected={index === activeIndex} tabIndex={-1} id={`${listId}-${index}`} key={option.id} className="invite-option" onMouseDown={e => e.preventDefault()} onClick={() => choose(option)}>
          <span className={`invite-avatar ${option.kind}`}>{option.kind === "team" ? <Users size={17}/> : option.kind === "agent" ? <Bot size={17}/> : option.name.slice(0, 1).toUpperCase()}</span>
          <span className="invite-person"><strong>{option.name}</strong><small>{option.detail}</small></span><span className="invite-kind">{option.kind}</span>
        </button>)}
        {!results.length && <p className="invite-empty">{query ? "No matches. Try another name." : "Everyone available has been selected or already has access."}</p>}
      </div>}
    </div>
    <p className="hint">Invite adds your selections below. Save {agents.length ? "group" : "changes"} to apply them.</p>
    <div className="invite-access-heading"><h3>Who has access</h3><select aria-label="Human access" disabled={disabled} value={humanIds == null ? "everyone" : "invited"} onChange={e => onChange(memberIds, e.target.value === "everyone" ? undefined : people.filter(p => p.role !== "owner").map(p => p.user))}><option value="invited">Invited people</option><option value="everyone">Everyone in workspace</option></select></div>
    <div className="invite-members">
      {visiblePeople.map(p => <div className="invite-member" key={p.user}><span className="invite-avatar person"><UserRound size={17}/></span><span className="invite-person"><strong>{p.user.split(":")[0].replace(/^@/, "")}</strong><small>{p.user}</small></span>{p.role === "owner" ? <span className="invite-kind"><Check size={12}/> Owner</span> : humanIds == null ? <span className="invite-kind">Workspace</span> : <button type="button" className="invite-remove" disabled={disabled} aria-label={`Remove ${p.user}`} onClick={() => onChange(memberIds, humanIds.filter(id => id !== p.user))}><X size={15}/></button>}</div>)}
      {agents.filter(a => included.has(a.id)).map(a => <div className="invite-member" key={a.id}><span className="invite-avatar agent"><Bot size={17}/></span><span className="invite-person"><strong>{a.name}</strong><small>{invited.has(a.id) ? a.position || "Agent" : "Included manager"}</small></span><button type="button" className="invite-remove" disabled={disabled} aria-label={`Remove ${a.name} and their team`} title="Remove this agent and their team" onClick={() => { const removed = new Set(branch(a.id)); onChange(memberIds.filter(id => !removed.has(id)), humanIds); }}><X size={15}/></button></div>)}
    </div>
    <p className="hint">Inviting a team includes its branches. Managers of invited agents join automatically. Workspace owners always have access.</p>
  </section>;
}
