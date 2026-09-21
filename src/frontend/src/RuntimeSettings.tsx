import { useEffect, useState } from "react";

import { Button } from "./components/ui/button";

import { Input } from "./components/ui/input";

import { Server, Plus, Copy, Check, KeyRound, RefreshCw, LoaderCircle } from "lucide-react";

import { api, post } from "./api";

export type RegisteredRuntime = { id:string; name:string; root?:string; os?:string; online:boolean; revoked:boolean };

export function RuntimeSelect({value,onChange}:{value:string;onChange:(id:string)=>void}) {

  const [runtimes,setRuntimes]=useState<RegisteredRuntime[]>([]);

  const [error,setError]=useState("");

  useEffect(()=>{void api<RegisteredRuntime[]>("/runtimes").then(setRuntimes,e=>setError(String(e)));},[]);

  return <label className="runtime-select">Registered runtime <select aria-label="Registered runtime" value={value} onChange={e=>onChange(e.target.value)}><option value="">Choose a connected runtime</option>{runtimes.filter(r=>!r.revoked).map(r=><option key={r.id} value={r.id}>{r.name} · {r.online?"online":"offline"}{r.root?` · ${r.root}`:""}</option>)}</select>{error&&<span role="alert">{error}</span>}</label>;

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

  async function refresh(){setRuntimes(await api<RegisteredRuntime[]>("/runtimes"));}

  useEffect(()=>{void api<RegisteredRuntime[]>("/runtimes").then(setRuntimes).catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>setLoading(false));const t=setInterval(()=>void refresh().catch(e=>setError(e instanceof Error?e.message:String(e))),5000);return()=>clearInterval(t);},[]);

  async function act(f:()=>Promise<void>){setBusy(true);setError("");try{await f();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}

  const active=runtimes.filter(r=>!r.revoked);

  return <div className="runtime-settings">

    {error&&<p className="banner error" role="alert">{error}</p>}

    <section className="settings-card">

      <div className="settings-section-title"><Server size={20}/><h2>Agent runtimes</h2><span className="settings-badge">{active.length} registered</span><Button variant="ghost" aria-label="Refresh runtimes" disabled={busy} onClick={()=>void act(async()=>{})}><RefreshCw size={16}/></Button></div>

      {loading?<p className="settings-description" role="status">Loading runtimes…</p>:active.length===0?<div className="runtime-empty"><span className="runtime-empty-icon"><Server size={28}/></span><h3>Connect your first machine</h3><p>Run agents on your computer, a server, or a Docker container. Register it below, then connect the worker.</p></div>:<div className="runtime-list">{active.map(r=><article className="runtime-row" key={r.id}>

        <span className="runtime-device"><Server size={20}/></span><div className="runtime-info"><strong>{r.name}</strong><span>{r.os||"Waiting for worker to connect"}</span>{r.root&&<code title={r.root}>{r.root}</code>}</div>

        <span className={`runtime-status ${r.online?"online":"offline"}`}><i/>{r.online?"Online":r.os?"Offline":"Not connected"}</span>

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
