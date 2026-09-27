import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import type { Agent } from "./bindings/Agent";
import { availableHarnesses, harnessNames, type RegisteredRuntime } from "./runtimeCatalog";
import { Input } from "./components/ui/input";
import { Server, Plus, Copy, Check, KeyRound, RefreshCw, LoaderCircle } from "lucide-react";
import { api, post, put } from "./api";
export function RuntimeSelect({value,onChange,onLoaded,disabled=false,required=false,allowController=false}: {
  value:string; onChange:(id:string)=>void; onLoaded?:(runtimes:RegisteredRuntime[])=>void;
  disabled?:boolean; required?:boolean; allowController?:boolean;
}) {
  const [runtimes,setRuntimes]=useState<RegisteredRuntime[]>([]);
  const [error,setError]=useState("");
  useEffect(()=>{
    let cancelled=false;
    const refresh=()=>void api<RegisteredRuntime[]>("/runtimes").then(values=>{if(!cancelled){setError("");setRuntimes(values);onLoaded?.(values);}},e=>{if(!cancelled)setError(String(e));});
    refresh();window.addEventListener("focus",refresh);
    return()=>{cancelled=true;window.removeEventListener("focus",refresh);};
  },[onLoaded,value]);
  return <label className="runtime-select">Registered runtime <select aria-label="Registered runtime" value={value} disabled={disabled} required={required} onChange={e=>onChange(e.target.value)}>
    <option value="">{allowController ? "Controller / SSH" : "Choose a runtime"}</option>
    {runtimes.filter(r=>!r.revoked||r.id===value).map(r=><option key={r.id} value={r.id} disabled={r.revoked}>{r.name}</option>)}
    {value&&!runtimes.some(r=>r.id===value)&&<option value={value} disabled>{error?"Runtime unavailable":"Loading runtime…"}</option>}
  </select>{error&&<span role="alert">{error}</span>}</label>;
}
export function HarnessSelect({id,value,onChange,runtimeId,runtimes,allowController=false}: {
  id:string; value:Agent["harness"]|""; onChange:(harness:Agent["harness"])=>void;
  runtimeId:string; runtimes:RegisteredRuntime[]; allowController?:boolean;
}) {
  const runtime=runtimes.find(r=>r.id===runtimeId);
  const options=runtimeId?availableHarnesses(runtime):allowController?(Object.keys(harnessNames) as Agent["harness"][]):[];
  return <><label htmlFor={id}>Harness</label><select id={id} value={value} disabled={!options.length||Boolean(runtimeId&&(!runtime?.online||runtime.revoked))} required onChange={e=>onChange(e.target.value as Agent["harness"])}>
    {!value&&<option value="">Choose a harness</option>}
    {value&&!options.includes(value)&&<option value={value} disabled>{harnessNames[value]} (unavailable)</option>}
    {options.map(harness=><option key={harness} value={harness}>{harnessNames[harness]}</option>)}
  </select>{runtimeId&&(!runtime?.online||runtime.revoked)?<p className="hint">Connect this runtime to choose an available harness.</p>:runtimeId&&!options.length?<p className="hint">No harness catalog reported. Install and sign in to a harness on this machine, then refresh.</p>:null}</>;
}
export function RuntimeSettings(){
  const [runtimes,setRuntimes]=useState<RegisteredRuntime[]>([]);
  const [name,setName]=useState("");
  const [token,setToken]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [copied,setCopied]=useState(false);
  const [revoking,setRevoking]=useState("");
  const [editing,setEditing]=useState("");
  async function refresh(){setRuntimes(await api<RegisteredRuntime[]>("/runtimes"));}
  useEffect(()=>{void api<RegisteredRuntime[]>("/runtimes").then(setRuntimes).catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>setLoading(false));const t=setInterval(()=>void refresh().catch(e=>setError(e instanceof Error?e.message:String(e))),5000);return()=>clearInterval(t);},[]);
  async function act(f:()=>Promise<void>){setBusy(true);setError("");try{await f();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  const active=runtimes.filter(r=>!r.revoked);
  return <div className="runtime-settings">
    {error&&<p className="banner error" role="alert">{error}</p>}
    <section className="settings-card">
      <div className="settings-section-title"><Server size={20}/><h2>Agent runtimes</h2><span className="settings-badge">{active.length} registered</span><Button variant="ghost" aria-label="Refresh runtimes" disabled={busy} onClick={()=>void act(async()=>{})}><RefreshCw size={16}/></Button></div>
      {loading?<p className="settings-description" role="status">Loading runtimes…</p>:active.length===0?<div className="runtime-empty"><span className="runtime-empty-icon"><Server size={28}/></span><h3>Connect your first machine</h3><p>Run agents on your computer, a server, or a Docker container. Register it below, then connect the worker.</p></div>:<div className="runtime-list">{active.map(r=><article className="runtime-row" key={r.id}>
        <span className="runtime-device"><Server size={20}/></span><div className="runtime-info"><strong>{r.name}</strong><span>{r.os||"Waiting for worker to connect"}</span>{r.root&&<code title={r.root}>{r.root}</code>}{r.description&&<span>{r.description}</span>}<span>{availableHarnesses(r).map(h=>harnessNames[h]).join(" · ")||"No harness catalog reported"}</span></div>
        <span className={`runtime-status ${r.online?"online":"offline"}`}><i/>{r.online?"Online":r.os?"Offline":"Not connected"}</span>
        <Button variant="ghost" aria-label={`Edit ${r.name}`} disabled={busy} onClick={()=>setEditing(editing===r.id?"":r.id)}>Edit</Button>
        {editing===r.id&&<form className="runtime-edit form-stack" onSubmit={event=>{
          event.preventDefault();const fields=new FormData(event.currentTarget);
          void act(async()=>{await put(`/runtimes/${r.id}`,{name:String(fields.get("name")),description:String(fields.get("description"))});setEditing("");});
        }}><label>Runtime name<Input name="name" defaultValue={r.name} required maxLength={80}/></label><label>Description<Textarea name="description" defaultValue={r.description??""} maxLength={2000}/></label>
          <p className="hint">Root folder, operating system and available harnesses are reported by the worker. Change those on its machine.</p>
          <div className="action-controls"><Button type="submit" disabled={busy}>Save runtime</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setEditing("")}>Cancel</Button></div>
        </form>}
        {revoking===r.id?<div className="runtime-confirm"><p>Disconnect this runtime? Its saved registration will stop working.</p><Button variant="destructive" disabled={busy} onClick={()=>void act(async()=>{await api(`/runtimes/${r.id}`,{method:"DELETE"});setRevoking("");})}>Confirm revoke</Button><Button variant="ghost" onClick={()=>setRevoking("")}>Cancel</Button></div>:<Button variant="ghost" disabled={busy} onClick={()=>setRevoking(r.id)}>Revoke</Button>}
      </article>)}</div>}
    </section>
    <section className="settings-card">
      <div className="settings-section-title"><Plus size={20}/><h2>Register a runtime</h2></div><p className="settings-description">Give the machine a recognizable name. You’ll get a temporary key to connect its worker.</p>
      <form className="settings-inline-form" onSubmit={e=>{e.preventDefault();void act(async()=>{const r=await post<{enrollment_token:string}>("/runtimes",{name:name.trim()});setToken(r.enrollment_token);setCopied(false);setName("");});}}><label htmlFor="runtime-name">Runtime name<Input id="runtime-name" required maxLength={80} placeholder="e.g. MacBook or build server" value={name} onChange={e=>setName(e.target.value)}/></label><Button type="submit" disabled={busy||!name.trim()}>{busy&&<LoaderCircle className="animate-spin" size={16}/>}Register runtime</Button></form>
    </section>
    {token&&<section className="settings-card runtime-enrollment" aria-label="Connect your worker"><div className="settings-section-title"><KeyRound size={20}/><h2>Connect your worker</h2></div><p className="settings-description">This key can be used once and expires in 15 minutes.</p><div className="runtime-token"><Input aria-label="Enrollment token" readOnly type="password" value={token}/><Button variant="outline" onClick={()=>{void (async()=>{try{await navigator.clipboard.writeText(token);setCopied(true);}catch{setError("Could not copy the key. Select the key field and copy it manually.");}})();}}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?"Copied":"Copy token"}</Button></div>
      <details className="runtime-instructions"><summary>Worker connection instructions</summary><p>On the worker machine, set <code>AE_ENROLLMENT_TOKEN</code> to this key, then run the installed worker:</p><pre>{`agentic-enterprise --worker --controller ${location.origin} --worker-state .ae-worker --worker-root /absolute/workdir`}</pre><p>Replace the workdir with your folder. For a different machine, use the platform’s reachable network address instead of localhost. Docker workers can mount a host folder at /workdir; persist /data to keep their registration.</p></details><Button variant="ghost" onClick={()=>{setToken("");setCopied(false);}}>Hide token</Button></section>}
    {runtimes.some(r=>r.revoked)&&<details className="runtime-history"><summary>Revoked runtimes ({runtimes.filter(r=>r.revoked).length})</summary>{runtimes.filter(r=>r.revoked).map(r=><div className="settings-person" key={r.id}><strong>{r.name}</strong><span className="settings-badge">Revoked</span></div>)}</details>}
  </div>;
}
