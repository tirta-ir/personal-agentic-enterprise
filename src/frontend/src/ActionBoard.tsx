import { useRef, useState } from "react";
import { CalendarDays, List, Play, Plus, Square, ChevronLeft, ChevronRight, Pencil, Trash2, FileText, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, post, requestId } from "./api";
import type { StateView } from "./bindings/StateView";
import type { ActionItem } from "./bindings/ActionItem";
import "./ActionBoard.css";

const columns = ["Project / group", "PIC", "Action", "Planned start", "Status", "Controls"];
const initialWidths = [170, 130, 230, 180, 120, 170];
const collator = new Intl.Collator(undefined, {numeric:true, sensitivity:"base"});
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const localTime = (date: Date) => `${localDate(date)}T${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;

export function ActionBoard({ data, groupId, onRefresh, onOpenRun }: {
  data: StateView; groupId?: string; onRefresh: () => Promise<void>; onOpenRun: (groupId: string, runId: string) => void;
}) {
  const [view,setView] = useState<"table"|"calendar">("table");
  const [filter,setFilter] = useState(groupId ?? "");
  const [pic,setPic] = useState("");
  const [month,setMonth] = useState(() => new Date(new Date().getFullYear(),new Date().getMonth(),1));
  const [draft,setDraft] = useState<ActionItem|null>(null);
  const [deleting,setDeleting] = useState<ActionItem|null>(null);
  const [sort,setSort] = useState({column:0, descending:false});
  const [widths,setWidths] = useState(initialWidths);
  const resizing = useRef<{column:number; x:number; width:number}|null>(null);
  const resize = (column:number, width:number) => setWidths(values=>values.map((value,i)=>i===column?Math.max(column===5?150:100,Math.min(800,width)):value));
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const groups = data.groups.filter(g => !g.archived_at && !g.deleted_at);
  const items = (data.actions??[]).filter(a => data.groups.some(g=>g.id===a.group_id&&!g.deleted_at) && (!groupId && !filter || a.group_id === (groupId || filter)) && (!pic || a.assignee_id === pic));
  const value = (a:ActionItem) => [data.groups.find(g=>g.id===a.group_id)?.name??"Unavailable group",data.agents.find(p=>p.id===a.assignee_id)?.name??"Deleted agent",a.title,a.planned_start??"",a.status][sort.column];
  const sorted = [...items].sort((a,b) => {
    const left=value(a), right=value(b);
    if(sort.column===3 && (!left||!right)) return left ? -1 : right ? 1 : a.id.localeCompare(b.id);
    const order=sort.column===3 ? Date.parse(left)-Date.parse(right) : collator.compare(left,right);
    return (sort.descending?-order:order) || a.id.localeCompare(b.id);
  });
  const editingGroup = groups.find(g=>g.id===draft?.group_id);
  const allowed = data.group_access[draft?.group_id??""]?.delegate_ids ?? [];
  const people = data.agents.filter(a=>allowed.includes(a.id) && a.enabled);
  const running = (a: ActionItem) => ["queued","running"].includes(a.status);
  async function perform(work:()=>Promise<unknown>) {
    setBusy(true);setError("");
    try { await work(); await onRefresh(); }
    catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {setBusy(false);}
  }
  function create(date?: Date) {
    const selected = groupId || filter || groups[0]?.id || "";
    setDraft({id:requestId(),revision:0,group_id:selected,title:"",body:"",assignee_id:"",planned_start:date?.toISOString()??null,status:"backlog",created_by:"owner",created_at:"",updated_at:"",run_id:null,error:null});
  }
  function card(a: ActionItem) {
    return <button className={`action-calendar-item status-${a.status}`} key={a.id} onClick={()=>setDraft(a)} title={`${a.title} · ${data.agents.find(p=>p.id===a.assignee_id)?.name}`}>
      <strong>{a.title}</strong><small>{data.agents.find(p=>p.id===a.assignee_id)?.name} · {a.status}</small>
    </button>;
  }
  const days = Array.from({length:42},(_,i)=>new Date(month.getFullYear(),month.getMonth(),1-month.getDay()+i));
  return <section className="action-board" aria-label="Action board">
    <header className="action-board-heading"><div><h1>Action board</h1><p>Organization → project or group → person in charge. Without a planned start, work stays in Backlog.</p></div>
      <Button onClick={()=>create()} disabled={!groups.length||!!groupId&&!groups.some(g=>g.id===groupId)}><Plus size={16}/> New action</Button></header>
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="action-toolbar">
      <div role="group" aria-label="Board view"><Button variant={view==="table"?"default":"outline"} onClick={()=>setView("table")}><List size={15}/>Table</Button><Button variant={view==="calendar"?"default":"outline"} onClick={()=>setView("calendar")}><CalendarDays size={15}/>Calendar</Button></div>
      {!groupId && <select aria-label="Filter project or group" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">All projects and groups</option>{data.groups.filter(g=>!g.deleted_at).map(g=><option key={g.id} value={g.id}>{g.project?"Project: ":"Group: "}{g.name}</option>)}</select>}
      <select aria-label="Filter PIC" value={pic} onChange={e=>setPic(e.target.value)}><option value="">All people in charge</option>{data.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>
    </div>
    {view==="table" ? <div className="action-table-scroll"><table className="action-table" style={{width:widths.reduce((a,b)=>a+b,0)}}><colgroup>{widths.map((width,i)=><col key={i} style={{width}}/>)}</colgroup><thead><tr>{columns.map((label,i)=><th key={label} aria-sort={i===5?undefined:sort.column===i?(sort.descending?"descending":"ascending"):"none"}>
      {i===5 ? label : <button className="action-sort" onClick={()=>setSort({column:i,descending:sort.column===i?!sort.descending:false})}>{label}{sort.column===i?(sort.descending?<ArrowDown size={14}/>:<ArrowUp size={14}/>):<ArrowUpDown size={14}/>}</button>}
      <span className="action-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${label} column`} aria-valuemin={i===5?150:100} aria-valuemax={800} aria-valuenow={widths[i]}
        onPointerDown={e=>{e.preventDefault();resizing.current={column:i,x:e.clientX,width:widths[i]};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{const drag=resizing.current;if(drag?.column===i)resize(i,drag.width+e.clientX-drag.x);}}
        onPointerUp={()=>{resizing.current=null;}} onPointerCancel={()=>{resizing.current=null;}} onLostPointerCapture={()=>{resizing.current=null;}}
        onKeyDown={e=>{if(["ArrowLeft","ArrowRight","Home"].includes(e.key)){e.preventDefault();resize(i,e.key==="Home"?initialWidths[i]:widths[i]+(e.key==="ArrowRight"?16:-16));}}}/>
    </th>)}</tr></thead><tbody>
      {sorted.map(a=><tr key={a.id}><td data-label="Project / group">{data.groups.find(g=>g.id===a.group_id)?.name??"Unavailable group"}</td><td data-label="PIC">{data.agents.find(p=>p.id===a.assignee_id)?.name??"Deleted agent"}</td><td data-label="Action"><button onClick={()=>setDraft(a)}>{a.title}</button>{a.error && <small className="error">{a.error}</small>}</td><td data-label="Planned start">{a.planned_start?new Date(a.planned_start).toLocaleString():"Unscheduled"}</td><td data-label="Status"><span className={`action-status status-${a.status}`}>{a.status}</span></td><td data-label="Controls"><div className="action-controls">
        <Button variant="ghost" size="icon" aria-label={`Edit ${a.title}`} title="Edit action" disabled={busy||running(a)} onClick={()=>setDraft(a)}><Pencil size={16}/></Button>
        {running(a)?<Button variant="ghost" size="icon" aria-label={`Stop ${a.title}`} title="Stop action" disabled={busy} onClick={()=>void perform(()=>post(`/actions/${a.id}/cancel`))}><Square size={16}/></Button>:<Button variant="ghost" size="icon" className="action-play" aria-label={`Run ${a.title}`} title="Run now" disabled={busy||a.status==="completed"||!groups.some(g=>g.id===a.group_id)} onClick={()=>void perform(()=>post(`/actions/${a.id}/invoke`))}><Play size={16}/></Button>}
        <Button variant="ghost" size="icon" className="action-delete" aria-label={`Delete ${a.title}`} title={running(a)?"Stop the action before deleting":"Delete action"} disabled={busy||running(a)} onClick={()=>setDeleting(a)}><Trash2 size={16}/></Button>
        {a.run_id&&<Button variant="ghost" size="icon" aria-label={`Evidence for ${a.title}`} title="View evidence" onClick={()=>onOpenRun(a.group_id,a.run_id!)}><FileText size={16}/></Button>}
      </div></td></tr>)}
    </tbody></table>{!items.length&&<p className="empty-state">No actions here yet.</p>}</div> : <>
      <div className="calendar-heading"><Button variant="ghost" aria-label="Previous month" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}><ChevronLeft/></Button><strong>{month.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</strong><Button variant="ghost" aria-label="Next month" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}><ChevronRight/></Button></div>
      <div className="action-calendar">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=><strong className="calendar-weekday" key={d}>{d}</strong>)}{days.map(day=><div key={localDate(day)} className={`calendar-day ${day.getMonth()!==month.getMonth()?"outside":""}`}><button className="calendar-day-number" aria-label={`Add action on ${localDate(day)}`} onClick={()=>{const start=new Date(day);start.setHours(9);create(start);}}>{day.getDate()}</button>{items.filter(a=>a.planned_start&&localDate(new Date(a.planned_start))===localDate(day)).map(card)}</div>)}</div>
      <h2 className="backlog-heading">Unscheduled backlog</h2><div className="action-backlog">{items.filter(a=>!a.planned_start&&!["completed","cancelled"].includes(a.status)).map(card)}{!items.some(a=>!a.planned_start&&!["completed","cancelled"].includes(a.status))&&<p>No unscheduled actions.</p>}</div>
    </>}
    {deleting&&<Dialog open onOpenChange={open=>{if(!open&&!busy)setDeleting(null);}}><DialogContent><DialogHeader><DialogTitle>Delete action?</DialogTitle><DialogDescription>Remove “{deleting.title}” from the board. Existing run history and evidence are retained.</DialogDescription></DialogHeader>{error&&<p className="error" role="alert">{error}</p>}<div className="action-controls"><Button variant="outline" disabled={busy} onClick={()=>setDeleting(null)}>Keep action</Button><Button variant="destructive" disabled={busy} onClick={()=>void perform(async()=>{await api(`/actions/${deleting.id}`,{method:"DELETE"});setDeleting(null);})}>Delete action</Button></div></DialogContent></Dialog>}
    {draft&&<Dialog open onOpenChange={open=>{if(!open&&!busy)setDraft(null);}}><DialogContent className="action-dialog"><DialogHeader><DialogTitle>{draft.revision?"Edit action":"New action"}</DialogTitle><DialogDescription>Assign a PIC, then save for later, schedule, or run now.</DialogDescription></DialogHeader>
      <form className="form-stack" onSubmit={e=>{e.preventDefault();const now=(e.nativeEvent as SubmitEvent).submitter?.getAttribute("value")==="now";void perform(async()=>{const saved=await post<ActionItem>("/actions",{id:draft.id,revision:draft.revision,group_id:draft.group_id,title:draft.title,body:draft.body,assignee_id:draft.assignee_id,planned_start:now?null:draft.planned_start});setDraft(saved);if(now)await post(`/actions/${draft.id}/invoke`);setDraft(null);});}}>
        <Label htmlFor="action-group">Project or group</Label><select id="action-group" value={draft.group_id} required disabled={busy||running(draft)} onChange={e=>setDraft({...draft,group_id:e.target.value,assignee_id:""})}><option value="" disabled>Select a workspace</option>{groups.map(g=><option key={g.id} value={g.id}>{g.project?"Project: ":"Group: "}{g.name}</option>)}</select>
        {editingGroup?.project&&<p className="hint">Runs in {editingGroup.project.workdir.ssh_host?`${editingGroup.project.workdir.ssh_host}: `:""}{editingGroup.project.workdir.path}</p>}
        <Label htmlFor="action-title">Title</Label><Input id="action-title" value={draft.title} required maxLength={160} disabled={busy||running(draft)} onChange={e=>setDraft({...draft,title:e.target.value})}/>
        <Label htmlFor="action-body">Task / instructions</Label><Textarea id="action-body" value={draft.body} required disabled={busy||running(draft)} onChange={e=>setDraft({...draft,body:e.target.value})}/>
        <Label htmlFor="action-pic">Person in charge (PIC)</Label><select id="action-pic" value={draft.assignee_id} required disabled={busy||running(draft)} onChange={e=>setDraft({...draft,assignee_id:e.target.value})}><option value="" disabled>Choose an agent</option>{people.map(a=><option key={a.id} value={a.id}>{a.name} · {a.position}</option>)}</select>
        <Label htmlFor="action-start">Planned start (optional, your local time)</Label><Input id="action-start" type="datetime-local" value={draft.planned_start?localTime(new Date(draft.planned_start)):""} disabled={busy||running(draft)} onChange={e=>setDraft({...draft,planned_start:e.target.value?new Date(e.target.value).toISOString():null})}/>
        <p className="hint">Leave blank to keep it unscheduled. Saving a future start schedules one invocation.</p>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="action-controls"><Button type="submit" value="save" disabled={busy||running(draft)}>{draft.planned_start?"Schedule action":"Save to backlog"}</Button><Button type="submit" value="now" variant="outline" disabled={busy||running(draft)}><Play size={14}/>Run now</Button></div>
      </form></DialogContent></Dialog>}
  </section>;
}
