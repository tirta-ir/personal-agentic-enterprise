import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, ChevronRight, GripVertical, FolderKanban, Hash, LoaderCircle, MoreHorizontal, Pin, PinOff, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { Group } from "./bindings/Group";
import type { GroupPreferences } from "./bindings/GroupPreferences";
import type { GroupSection } from "./bindings/GroupSection";
import { requestId } from "./api";

// The installed Base UI menu supplies keyboard navigation, focus return and touch handling.
function MenuPopup({ children }: { children: ReactNode }) {
  return <Menu.Portal><Menu.Positioner align="end" sideOffset={6} className="group-menu-positioner">
    <Menu.Popup className="group-menu">{children}</Menu.Popup>
  </Menu.Positioner></Menu.Portal>;
}

export function GroupList({ groups, preferences, selected, running, onSelect, onSave, onCreate, onCreateProject }: {
  groups: Group[]; preferences: GroupPreferences; selected: string | null; running: string[];
  onSelect: (id: string) => void; onSave: (preferences: GroupPreferences) => Promise<void>; onCreate: () => void; onCreateProject: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<GroupSection | null>(null);
  const [name, setName] = useState("");
  const customSections = preferences.sections ?? [];
  const collapsed = preferences.collapsed ?? [];
  const rank = new Map(preferences.order.map((id, i) => [id, i]));
  const ordered = groups.filter((g) => !g.archived_at && !g.deleted_at).sort((a, b) => {
    if (preferences.sort !== "custom") {
      const compare = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);
      return preferences.sort === "ascending" ? compare : -compare;
    }
    return (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || groups.indexOf(a) - groups.indexOf(b);
  });
  const sectionFor = (id: string) => preferences.pinned.includes(id) ? "pinned" : customSections.find((s) => s.groups.includes(id))?.id ?? "all";
  const sections = [{ id: "pinned", name: "Pinned" }, ...customSections, { id: "all", name: "All groups" }];
  const arranged = sections.flatMap((section) => ordered.filter((g) => sectionFor(g.id) === section.id));
  const visible = arranged.filter((g) => !collapsed.includes(sectionFor(g.id)));
  async function save(next: GroupPreferences, message: string) {
    if (busy) return false;
    setBusy(true); setError("");
    try { await onSave(next); setAnnouncement(message); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  }
  function placement(source: string, section: string): GroupPreferences {
    return { ...preferences,
      pinned: section === "pinned" ? [...new Set([...preferences.pinned, source])] : preferences.pinned.filter((id) => id !== source),
      sections: customSections.map((s) => ({ ...s, groups: section === "pinned" ? s.groups
        : [...s.groups.filter((id) => id !== source), ...(s.id === section ? [source] : [])] })),
    };
  }
  function move(source: string, target: string) {
    if (busy || source === target) return;
    const start = visible.findIndex((g) => g.id === source), end = visible.findIndex((g) => g.id === target);
    if (start < 0 || end < 0) return;
    // Array-splice reorder follows the existing Atlassian adaptation; see UPSTREAM.md.
    const order = arranged.map((g) => g.id).filter((id) => id !== source);
    order.splice(order.indexOf(target) + (start < end ? 1 : 0), 0, source);
    void save({ ...placement(source, sectionFor(target)), sort: "custom", order }, "Group order saved.");
  }
  function edit(section?: GroupSection) {
    setError(""); setEditing(section ?? { id: "", name: "", groups: [] }); setName(section?.name ?? "");
  }
  return <>
    <div className="section-label"><span>GROUPS & PROJECTS</span><div className="group-header-actions">
      <Menu.Root><Menu.Trigger aria-label="Group options" title="Sort groups and manage sections" disabled={busy}><MoreHorizontal size={19} /></Menu.Trigger>
        <MenuPopup>
          <div className="group-menu-label">Sort groups</div>
          {([["custom", "Custom order"], ["ascending", "A–Z"], ["descending", "Z–A"]] as const).map(([value, label]) =>
            <Menu.Item key={value} onClick={() => void save({ ...preferences, sort: value }, "Group sorting saved.")}>
              <span className="menu-check">{preferences.sort === value && <Check size={14} />}</span>{label}
            </Menu.Item>)}
          <Menu.Separator className="group-menu-separator" />
          <Menu.Item onClick={() => edit()}><Plus size={14} /> Create section</Menu.Item>
        </MenuPopup>
      </Menu.Root>
      <Menu.Root><Menu.Trigger aria-label="Add group or section" title="Add group or section" disabled={busy}><Plus size={17} /></Menu.Trigger>
        <MenuPopup>
          <Menu.Item onClick={onCreate}><Hash size={14} /> Create group</Menu.Item>
          <Menu.Item onClick={onCreateProject}><FolderKanban size={14} /> Create project</Menu.Item>
          <Menu.Item onClick={() => edit()}><Plus size={14} /> Create section</Menu.Item>
        </MenuPopup>
      </Menu.Root>
    </div></div>
    <nav aria-label="Groups" className="group-list" aria-busy={busy}>
      {sections.map((section) => {
        const items = ordered.filter((g) => sectionFor(g.id) === section.id);
        const isCollapsed = collapsed.includes(section.id);
        const custom = customSections.find((s) => s.id === section.id);
        return <section key={section.id} className="group-section" data-section-id={section.id}>
          <div className={`group-section-heading ${over === section.id ? "drop-target" : ""}`}
            onDragOver={(e) => { if (dragged && !busy) { e.preventDefault(); setOver(section.id); } }}
            onDrop={(e) => { e.preventDefault(); if (dragged) void save(placement(dragged, section.id), `Moved to ${section.name}.`); setDragged(null); setOver(null); }}>
            <button aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${section.name}`} aria-expanded={!isCollapsed} aria-controls={`groups-${section.id}`} disabled={busy}
              onClick={() => void save({ ...preferences, collapsed: isCollapsed ? collapsed.filter((id) => id !== section.id) : [...collapsed, section.id] }, "Section visibility saved.")}>
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{section.name}</span><small>{items.length}</small>
            </button>
            {custom && <Menu.Root><Menu.Trigger aria-label={`Section options for ${section.name}`} disabled={busy}><MoreHorizontal size={16} /></Menu.Trigger>
              <MenuPopup>
                <Menu.Item onClick={() => edit(custom)}>Rename section</Menu.Item>
                <Menu.Item onClick={() => void save({ ...preferences, sections: customSections.filter((s) => s.id !== section.id), collapsed: collapsed.filter((id) => id !== section.id) }, "Section removed. Its groups are still available.")}>Remove section</Menu.Item>
              </MenuPopup>
            </Menu.Root>}
          </div>
          <div id={`groups-${section.id}`} hidden={isCollapsed}>
            {items.map((g) => {
              const pinned = preferences.pinned.includes(g.id);
              return <div key={g.id} className={`group-row ${over === g.id ? "drop-target" : ""} ${dragged === g.id ? "dragging" : ""}`} data-group-id={g.id}
                onDragOver={(e) => { if (dragged && !busy) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(g.id); } }}
                onDrop={(e) => { e.preventDefault(); if (dragged) move(dragged, g.id); setDragged(null); setOver(null); }}>
                <button className="group-grip" aria-label={`Reorder ${g.name}`} title="Drag to move. Use Arrow Up or Arrow Down to reorder." disabled={busy} draggable={!busy}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", g.id); setDragged(g.id); }}
                  onDragEnd={() => { setDragged(null); setOver(null); }}
                  onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const target = visible[visible.findIndex((item) => item.id === g.id) + (e.key === "ArrowUp" ? -1 : 1)]; if (target) move(g.id, target.id); } }}>
                  <GripVertical size={14} />
                </button>
                <button className={`nav-item ${selected === g.id ? "selected" : ""}`} aria-current={selected === g.id ? "page" : undefined} onClick={() => onSelect(g.id)}>
                  {g.project?<FolderKanban size={16}/>:<Hash size={16} />}<span>{g.name}</span>{running.includes(g.id) && <LoaderCircle className="activity-spinner" size={14} aria-label="Working" />}
                </button>
                <button className={`group-pin ${pinned ? "is-pinned" : ""}`} aria-label={`${pinned ? "Unpin" : "Pin"} ${g.name}`} title={pinned ? "Unpin group" : "Pin group"} disabled={busy}
                  onClick={() => void save({ ...preferences, pinned: pinned ? preferences.pinned.filter((id) => id !== g.id) : [...preferences.pinned, g.id] }, `${g.name} ${pinned ? "unpinned" : "pinned"}.`)}>
                  {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <Menu.Root><Menu.Trigger className="group-pin" aria-label={`Move ${g.name} to section`} title="Move to section" disabled={busy}><MoreHorizontal size={15} /></Menu.Trigger>
                  <MenuPopup><div className="group-menu-label">Move to section</div>
                    {sections.map((s) => <Menu.Item key={s.id} onClick={() => void save(placement(g.id, s.id), `Moved to ${s.name}.`)}>
                      <span className="menu-check">{sectionFor(g.id) === s.id && <Check size={14} />}</span>{s.name}
                    </Menu.Item>)}
                  </MenuPopup>
                </Menu.Root>
              </div>;
            })}
            {!items.length && <p className="group-empty">{section.id === "pinned" ? "Pin groups to keep them here." : "No groups in this section."}</p>}
          </div>
        </section>;
      })}
    </nav>
    <span className="sr-only" role="status">{announcement}</span>
    {error && !editing && <p className="schedule-error" role="alert">{error}</p>}
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{editing?.id ? "Rename section" : "Create section"}</DialogTitle><DialogDescription>Organize groups in a collapsible section.</DialogDescription></DialogHeader>
        <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (!editing || !name.trim() || busy) return;
          const saved = { ...editing, id: editing.id || requestId(), name: name.trim() };
          void save({ ...preferences, sections: editing.id ? customSections.map((s) => s.id === editing.id ? saved : s) : [...customSections, saved] }, "Section saved.").then((ok) => { if (ok) setEditing(null); });
        }}><Label htmlFor="section-name">Section name</Label><Input id="section-name" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
          {error && <p className="schedule-error" role="alert">{error}</p>}<Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save section"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
