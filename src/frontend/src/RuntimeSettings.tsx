import { useEffect, useState } from "react";
import { api, post } from "./api";
export type RegisteredRuntime = { id:string; name:string; root?:string; os?:string; online:boolean; revoked:boolean };
export function RuntimeSelect({value,onChange}:{value:string;onChange:(id:string)=>void}) {
  const [runtimes,setRuntimes]=useState<RegisteredRuntime[]>([]);
  const [error,setError]=useState("");
  useEffect(()=>{void api<RegisteredRuntime[]>("/runtimes").then(setRuntimes,e=>setError(String(e)));},[]);
  return <label>Registered runtime <select aria-label="Registered runtime" value={value} onChange={e=>onChange(e.target.value)}><option value="">Choose runtime (or legacy workstation below)</option>{runtimes.filter(r=>!r.revoked).map(r=><option key={r.id} value={r.id}>{r.name} · {r.online?"online":"offline"}{r.root?` · ${r.root}`:""}</option>)}</select>{error&&<span role="alert">{error}</span>}</label>;
}
export function RuntimeSettings(){
  const [runtimes,setRuntimes]=useState<RegisteredRuntime[]>([]);const[name,setName]=useState("");const[token,setToken]=useState("");const[error,setError]=useState("");const[busy,setBusy]=useState(false);
  async function refresh(){setRuntimes(await api<RegisteredRuntime[]>("/runtimes"));}
  useEffect(()=>{void api<RegisteredRuntime[]>("/runtimes").then(setRuntimes,e=>setError(String(e)));const t=setInterval(()=>void refresh().catch(e=>setError(String(e))),5000);return()=>clearInterval(t);},[]);
  async function act(f:()=>Promise<void>){setBusy(true);setError("");try{await f();await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <section className="form-stack"><h2>Persistent runtimes</h2><p>Install a worker on a machine you control. Its workdir and native CLI login stay on that machine.</p>
    {runtimes.map(r=><div key={r.id}><strong>{r.name}</strong> · {r.revoked?"revoked":r.online?"online":"offline"} · {r.os??"awaiting enrollment"} {r.root??""} {!r.revoked&&<button disabled={busy} onClick={()=>void act(async()=>{await api(`/runtimes/${r.id}`,{method:"DELETE"});})}>Revoke</button>}</div>)}
    <form onSubmit={e=>{e.preventDefault();void act(async()=>{const r=await post<{enrollment_token:string}>("/runtimes",{name});setToken(r.enrollment_token);setName("");});}}><label>Runtime name <input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label><button disabled={busy}>Register runtime</button></form>
    {token&&<div><p>One-use enrollment token · expires in 15 minutes. Set AE_ENROLLMENT_TOKEN in the worker's environment, then run:</p><input aria-label="Enrollment token" readOnly type="password" value={token}/><button onClick={()=>void navigator.clipboard.writeText(token)}>Copy token</button><pre>{`agentic-enterprise --worker --controller ${location.origin} --worker-state .ae-worker --worker-root /absolute/workdir`}</pre><p>For Docker, mount a workdir at /workdir and persist /data. After enrollment the worker reuses its saved registration.</p><button onClick={()=>setToken("")}>Hide token</button></div>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
