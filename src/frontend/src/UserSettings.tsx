import { RuntimeSettings } from "./RuntimeSettings";
import { useState } from "react";
import { Monitor, Plus, Server, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, post } from "./api";
import type { Workstation } from "./bindings/Workstation";
import type { Connection } from "./bindings/Connection";

const empty: Workstation = { id: "", name: "", hostname: "", host_ip: "", port: 22, username: "", auth: "key", ssh_alias: "", ssh_key_path: "", secret_saved: false };
export function UserSettings({ controllerAccess, workstations, onRefresh }: { controllerAccess: boolean; workstations: Workstation[]; onRefresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<Workstation | null>(null);
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [remove, setRemove] = useState(false);
  const [saved, setSaved] = useState(true);
  const [fingerprints, setFingerprints] = useState<string[]>([]);
  function edit(host: Workstation) { setFingerprints([]); setDraft({ ...host }); setSecret(""); setClearSecret(false); setRemove(false); setError(""); setMessage(""); setSaved(true); }
  function change(patch: Partial<Workstation>) { setFingerprints([]); setDraft(draft ? { ...draft, ...patch } : null); setSaved(false); setMessage(""); }
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if (!controllerAccess) return <section className="user-settings"><RuntimeSettings/></section>;
  return <section className="user-settings">
    <RuntimeSettings/>
    <header><div><h1>User settings</h1><p>Save workstations once, then choose them in an agent or project.</p></div><Button onClick={() => edit(empty)}><Plus size={16}/>Add workstation</Button></header>
    <div className="workstation-settings-layout"><nav aria-label="Saved workstations">
      <div className="workstation-local"><Monitor size={18}/><span><strong>Local</strong><small>This machine</small></span></div>
      {workstations.map(host => <button key={host.id} className={draft?.id === host.id ? "selected" : ""} onClick={() => edit(host)}><Server size={18}/><span><strong>{host.name}</strong><small>{host.username}@{host.host_ip || host.hostname}:{host.port}</small></span></button>)}
      <form className="form-stack workstation-import" onSubmit={e => { e.preventDefault(); void perform(async () => { const host = await post<Workstation>("/workstations/import", { alias: alias.trim() }); await onRefresh(); edit(host); setAlias(""); setMessage("SSH settings imported."); }); }}>
        <Label htmlFor="import-ssh-alias">Import existing SSH alias</Label><Input id="import-ssh-alias" value={alias} onChange={e => setAlias(e.target.value)} placeholder="e.g. tencent-personal"/><Button type="submit" variant="outline" disabled={busy || !alias.trim()}>Import alias</Button>
      </form>
    </nav>
    <div>{draft ? <form className="form-stack workstation-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
      const host = await post<Workstation>("/workstations", { workstation: draft, secret: secret || null, clear_secret: clearSecret });
      await onRefresh(); edit(host); setMessage("Workstation saved. Test the connection before attaching a workdir.");
    }); }}>
      <h2>{draft.id ? draft.name : "New workstation"}</h2>
      <fieldset disabled={busy} className="form-stack">
        <Label htmlFor="host-name">Display name</Label><Input id="host-name" required maxLength={100} value={draft.name} onChange={e => change({ name: e.target.value })}/>
        <div className="settings-fields"><div><Label htmlFor="host-hostname">Hostname</Label><Input id="host-hostname" required value={draft.hostname} placeholder="workstation.example.com" onChange={e => change({ hostname: e.target.value })}/></div><div><Label htmlFor="host-ip">Host IP (optional)</Label><Input id="host-ip" value={draft.host_ip} placeholder="Use instead of DNS" onChange={e => change({ host_ip: e.target.value })}/></div></div>
        <div className="settings-fields"><div><Label htmlFor="host-port">SSH port</Label><Input id="host-port" type="number" min={1} max={65535} required value={draft.port} onChange={e => change({ port: Number(e.target.value) })}/></div><div><Label htmlFor="host-user">Username</Label><Input id="host-user" required autoComplete="off" value={draft.username} onChange={e => change({ username: e.target.value })}/></div></div>
        <Label htmlFor="host-auth">Authentication</Label><select id="host-auth" value={draft.auth} onChange={e => { change({ auth: e.target.value }); setSecret(""); setClearSecret(true); }}><option value="key">SSH key</option><option value="password">Password</option><option value="ssh_config">Existing SSH config / agent</option></select>
        {draft.auth === "ssh_config" && <><Label htmlFor="host-alias">SSH config alias</Label><Input id="host-alias" required value={draft.ssh_alias} onChange={e => change({ ssh_alias: e.target.value })}/><p className="hint">Keeps this alias's existing keys, host-key identity and jump-host settings.</p></>}
        {draft.auth === "key" && <><Label htmlFor="host-key">SSH private-key path</Label><Input id="host-key" required value={draft.ssh_key_path} onChange={e => change({ ssh_key_path: e.target.value })} placeholder="Absolute key-file path on this machine"/></>}
        {draft.auth !== "ssh_config" && <><Label htmlFor="host-secret">{draft.auth === "password" ? "Password" : "Key passphrase (optional)"}</Label><Input id="host-secret" type="password" autoComplete="new-password" value={secret} required={draft.auth === "password" && (!draft.secret_saved || clearSecret)} placeholder={draft.secret_saved ? "Saved · leave blank to keep" : ""} onChange={e => { setSecret(e.target.value); setSaved(false); }}/><p className="hint">Encrypted for the Windows account running the platform. Never included in agent profiles or exports.</p>{draft.secret_saved && draft.auth === "key" && <label className="settings-checkbox"><input type="checkbox" checked={clearSecret} onChange={e => { setClearSecret(e.target.checked); setSaved(false); }}/>Remove saved passphrase</label>}</>}
      </fieldset>
      <div className="settings-actions"><Button type="submit" disabled={busy}>{busy ? "Working…" : "Save workstation"}</Button>{draft.id && <Button type="button" variant="outline" disabled={busy || !saved} onClick={() => void perform(async () => {
        const result = await post<{ connection: Connection; home: string }>(`/workstations/${draft.id}/test`);
        if (result.connection.status !== "online") throw Error(result.connection.message || "Codex is not ready on this workstation");
        setMessage(`Connected · ${result.connection.os} · ${result.connection.version} · ${result.home}`);
      })}>Test connection</Button>}</div>
      {draft.id && draft.auth !== "ssh_config" && <div className="host-key-review">
        <Button type="button" variant="outline" disabled={busy || !saved} onClick={() => void perform(async () => { const result = await api<{ fingerprints: string[] }>(`/workstations/${draft.id}/host-keys`); setFingerprints(result.fingerprints); })}>Review host keys</Button>
        {fingerprints.length > 0 && <><p className="hint">Compare these fingerprints with the workstation's SSH host keys before trusting this connection.</p><pre>{fingerprints.join("\n")}</pre><Button type="button" variant="outline" disabled={busy} onClick={() => void perform(async () => { await post(`/workstations/${draft.id}/trust`, { fingerprints }); setFingerprints([]); setMessage("Host keys trusted. You can test the connection now."); })}>Trust these host keys</Button></>}
      </div>}
      <p className="hint">Linux/macOS workstations need Python 3.11+, Git and a signed-in Codex CLI. SSH config imports keep their existing host trust.</p>
      {draft.id && <div className="settings-actions">{remove ? <><span>Remove this saved connection?</span><Button type="button" variant="destructive" disabled={busy} onClick={() => void perform(async () => { await api(`/workstations/${draft.id}`, { method: "DELETE" }); await onRefresh(); setDraft(null); setMessage("Workstation removed."); })}>Confirm remove</Button><Button type="button" variant="ghost" onClick={() => setRemove(false)}>Cancel</Button></> : <Button type="button" variant="ghost" onClick={() => setRemove(true)}><Trash2 size={14}/>Remove workstation</Button>}</div>}
    </form> : <div className="empty-state"><Server size={30}/><h2>Your workstations</h2><p>Select a saved workstation or add a new connection.</p></div>}
    {error && <p className="banner error" role="alert">{error}</p>}{message && <p className="banner" role="status">{message}</p>}
    </div></div>
  </section>;
}
