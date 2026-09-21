import { useEffect, useState } from "react";
import { api, post, put, ApiFailure } from "./api";
import App from "./App";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ArrowRight, Eye, EyeOff, LoaderCircle, Settings2, Plus, Users, Building2, ArrowLeft } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./components/ui/dialog";
import "./platform-settings.css";
type Tenant = { id: string; name: string; deleted: boolean; role: string };
type Person = { user: string; role: string };
export function WorkspaceGate() {
  const [user, setUser] = useState<string | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selected, setSelected] = useState(() => document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("ae_workspace="))?.split("=")[1] ?? "default");
  const [ready, setReady] = useState(false);
  const [matrix, setMatrix] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [owner, setOwner] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [manage, setManage] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workspace = tenants.find(t => t.id === selected && !t.deleted);
  function choose(id: string) { document.cookie = `ae_workspace=${id}; Path=/; SameSite=Strict`; setSelected(id); setManage(false); }
  async function refresh() {
    const me = await api<{ user: string; matrix: boolean }>("/me"); setUser(me.user); setMatrix(me.matrix);
    const values = await api<Tenant[]>("/tenants"); setTenants(values);
    if (!values.some(t => t.id === selected && !t.deleted)) { const next = values.find(t => !t.deleted); if (next) choose(next.id); }
  }
  async function act(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  useEffect(() => { void (async () => { try {
    const config = await api<{matrix:boolean}>("/auth"); setMatrix(config.matrix);
    const token = new URLSearchParams(location.hash.slice(1)).get("key");
    if(token){history.replaceState(null,"",location.pathname+location.search);await post("/login",{token});}
    await refresh();
  } catch(e) { if (!(e instanceof ApiFailure && e.status === 401)) setError(e instanceof Error ? e.message : String(e)); } finally {setReady(true);} })(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if(manage && workspace?.role === "owner") void api<Person[]>(`/tenants/${selected}/members`).then(setPeople,e=>setError(String(e))); }, [manage, selected, workspace?.role]);
  if(!ready) return <main className="login-page"><p className="login-loading" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" size={20}/>Connecting to your workspace…</p></main>;
  if(!user) return <main className="login-page"><section className="login-card" aria-labelledby="login-title">
    <div className="login-brand"><img src="/agentic-enterprise-logo.png" alt="" width={36} height={36}/><span>Agentic Enterprise</span></div>
    <h1 id="login-title">{owner||!matrix ? "Administrator sign in" : "Welcome back"}</h1>
    <p>{owner||!matrix ? "Use your owner key to manage this platform." : "Sign in to your workspace. Your team and agents are here."}</p>
    <form aria-label="Sign in" aria-busy={busy} onSubmit={e=>{e.preventDefault();void act(async()=>{
      try { await post("/login", matrix&&!owner ? {username:username.trim(),password}:{token:password.trim()}); }
      catch(e) {
        if(e instanceof ApiFailure && e.status===401) throw new Error(matrix&&!owner ? "The username or password is incorrect. Please try again." : "That owner key is not valid. Check your key and try again.");
        throw e;
      }
      setPassword("");setShowPassword(false);await refresh();
    });}}>
      <fieldset disabled={busy}>
        {matrix&&!owner&&<div className="login-field"><label htmlFor="login-username">Username</label><Input id="login-username" name="username" required autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby="login-account-help" value={username} onChange={e=>setUsername(e.target.value)}/><p id="login-account-help" className="login-hint">Use the Matrix account provided by your workspace administrator.</p></div>}
        <div className="login-field"><label htmlFor="login-password">{matrix&&!owner?"Password":"Owner key"}</label><div className="login-secret"><Input id="login-password" name="password" required type={showPassword?"text":"password"} autoComplete={matrix&&!owner?"current-password":"off"} value={password} onChange={e=>setPassword(e.target.value)}/><Button type="button" variant="ghost" className="login-reveal" aria-label={showPassword?"Hide password":"Show password"} aria-pressed={showPassword} onClick={()=>setShowPassword(v=>!v)}>{showPassword?<EyeOff aria-hidden="true"/>:<Eye aria-hidden="true"/>}</Button></div></div>
        {error&&<p className="login-error" role="alert">{error}</p>}
        <Button type="submit" className="login-submit" disabled={busy}>{busy?<><LoaderCircle className="animate-spin" aria-hidden="true"/>Signing in…</>:<>Sign in<ArrowRight aria-hidden="true"/></>}</Button>
      </fieldset>
    </form>
    <p className="login-help">{owner||!matrix ? "Your deployment administrator can provide the owner key." : "Need access or help signing in? Contact your workspace administrator."}</p>
    {matrix&&<div className="login-alternate"><Button type="button" variant="link" disabled={busy} onClick={()=>{setOwner(v=>!v);setPassword("");setShowPassword(false);setError("");}}>{owner?"Back to account sign in":"Administrator sign in"}</Button></div>}
  </section></main>;
  return <div className="platform-shell">
    <header className="workspace-bar">
      <Building2 size={18} aria-hidden="true"/>
      <label className="workspace-switcher"><span>Workspace</span><select aria-label="Workspace" value={workspace?.id??""} onChange={e=>choose(e.target.value)}><option value="" disabled>Select workspace</option>{tenants.filter(t=>!t.deleted).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      {workspace&&<span className="settings-badge">{workspace.role === "owner" ? "Owner" : "Member"}</span>}
      <Button variant="ghost" className="workspace-manage" aria-label="Manage workspaces" onClick={()=>setManage(true)}><Settings2 size={16}/><span>Manage workspaces</span></Button>
    </header>
    {error&&!manage&&<p role="alert" className="banner error">{error}</p>}
    <Dialog open={manage||!workspace} onOpenChange={setManage}>
      <DialogContent className="workspace-dialog">
        <DialogHeader><DialogTitle>Workspaces</DialogTitle><DialogDescription>Each workspace has its own people, agents, and conversations.</DialogDescription></DialogHeader>
        {error&&<p role="alert" className="banner error">{error}</p>}
        <section className="settings-card">
          <div className="settings-section-title"><Plus size={18}/><h2>Create a workspace</h2></div>
          <form className="settings-inline-form" onSubmit={e=>{e.preventDefault();void act(async()=>{const t=await post<Tenant>("/tenants",{name:name.trim()});setName("");await refresh();choose(t.id);});}}><label htmlFor="new-workspace">New workspace<Input id="new-workspace" required maxLength={80} placeholder="e.g. Engineering" value={name} onChange={e=>setName(e.target.value)}/></label><Button type="submit" disabled={busy||!name.trim()}>Create workspace</Button></form>
        </section>
        {workspace&&<section className="settings-card">
          <div className="settings-section-title"><Building2 size={18}/><h2>{workspace.name}</h2><span className="settings-badge">{workspace.role}</span></div>
          {workspace.role==="owner"?<>
            <form className="settings-inline-form" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void act(async()=>{await put(`/tenants/${selected}`,{name:form.get("name")});await refresh();});}}><label htmlFor="workspace-name">Name<Input id="workspace-name" name="name" defaultValue={workspace.name} key={workspace.id+workspace.name} required maxLength={80}/></label><Button type="submit" variant="outline" disabled={busy}>Rename</Button></form>
            <div className="settings-section-title"><Users size={18}/><h3>People</h3></div>
            <div className="settings-people">{people.map(p=><div className="settings-person" key={p.user}><span className="settings-avatar" aria-hidden="true">{p.user.replace(/^@/, "").slice(0,1).toUpperCase()}</span><strong>{p.user}</strong><span className="settings-badge">{p.role}</span>{p.role==="member"&&<Button variant="ghost" disabled={busy} onClick={()=>void act(async()=>setPeople(await api<Person[]>(`/tenants/${selected}/members`,{method:"DELETE",body:JSON.stringify({user:p.user})})))}>Remove</Button>}</div>)}</div>
            <form className="settings-inline-form" onSubmit={e=>{e.preventDefault();void act(async()=>{setPeople(await post<Person[]>(`/tenants/${selected}/members`,{user:invite.trim()}));setInvite("");});}}><label htmlFor="workspace-invite">Invite Matrix user<Input id="workspace-invite" value={invite} onChange={e=>setInvite(e.target.value)} placeholder="@person:server" required/></label><Button type="submit" variant="outline" disabled={busy||!invite.trim()}>Invite</Button></form>
            <details className="workspace-danger"><summary>Delete workspace</summary><p>History is retained. You can restore this workspace later.</p><Button variant="destructive" disabled={busy} onClick={()=>void act(async()=>{if(!confirm(`Delete ${workspace.name}? History will be retained for restoration.`))return;await api(`/tenants/${selected}`,{method:"DELETE",body:"{}"});await refresh();})}>Delete workspace</Button></details>
          </>:<p className="settings-description">You are a member of this workspace. Its owner manages invitations, agents, and connected machines.</p>}
        </section>}
        {tenants.filter(t=>t.deleted).length>0&&<section className="settings-card"><h2>Deleted workspaces</h2>{tenants.filter(t=>t.deleted).map(t=><div className="settings-person" key={t.id}><strong>{t.name}</strong>{t.role==="owner"&&<Button variant="outline" disabled={busy} onClick={()=>void act(async()=>{await put(`/tenants/${t.id}`,{deleted:false});await refresh();})}>Restore</Button>}</div>)}</section>}
        {!workspace&&<Button variant="ghost" onClick={()=>void act(async()=>{await post("/logout");location.reload();})}>Sign out</Button>}
        {workspace&&<Button variant="ghost" onClick={()=>setManage(false)}><ArrowLeft size={16}/>Back to workspace</Button>}
      </DialogContent>
    </Dialog>
    {workspace&&<div className="platform-content"><App key={selected} user={user} workspaceName={workspace.name} role={workspace.role} controllerAccess={user==="owner"&&selected==="default"}/></div>}
  </div>;
}
