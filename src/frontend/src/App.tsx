import {
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CalendarClock,
  FolderKanban,
  ListChecks,
  Slash,
  ArrowUp,
  ArrowLeft,
  Check,
  Circle,
  FolderOpen,
  Hash,
  Network,
  ChevronRight,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  X,
  Archive,
  PanelLeftOpen,
  PanelLeftClose,
  FileText,
  RefreshCw,
  LogOut,
  PanelRightClose,
  Users,
  Server,
  UserRound,
  Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CommandInput, UsageCard, type CommandInputHandle } from "./ChatCommands";
import { GroupList } from "./GroupList";
import { ArchivedGroups } from "./ArchivedGroups";
import { ChatActivity, MessageModelBadge } from "./ChatActivity";
import { isActiveRun } from "./runStatus";
import { ProjectTeam } from "./ProjectTeam";
import { RuntimeSelect } from "./RuntimeSettings";
import { WorkstationSelect } from "./WorkstationSelect";
import { UserSettings } from "./UserSettings";
import type { Workstation } from "./bindings/Workstation";
import { GroupDialog } from "./GroupDialog";
import { MessageMarkdown, type MarkdownFile } from "./MessageMarkdown";
import { MarkdownPreview } from "./MarkdownPreview";
import { ActionBoard } from "./ActionBoard";
import { QuestionCard } from "./QuestionCard";
import type { QuestionRequest } from "./bindings/QuestionRequest";
import { ScheduledTasks } from "./ScheduledTasks";
import { api, post, put, requestId, ApiFailure } from "./api";
import type { Agent } from "./bindings/Agent";
import type { Group } from "./bindings/Group";
import type { Message } from "./bindings/Message";
import type { Run } from "./bindings/Run";
import type { Artifact } from "./bindings/Artifact";
import type { Workspace } from "./bindings/Workspace";
import type { StateView } from "./bindings/StateView";
import type { Connection } from "./bindings/Connection";
import { WorkstationStatus } from "./WorkstationStatus";
import type { Event } from "./bindings/Event";
import type { CodexSettings } from "./bindings/CodexSettings";
import type { OrganizationContext } from "./bindings/OrganizationContext";
import { KnowledgeExplorer } from "./KnowledgeExplorer";
import { Avatar } from "./Avatar";
import { Group as PanelGroup, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { FolderPicker } from "./FolderPicker";
import { AgentTerminal, AgentSkills } from "./AgentTools";
import {
  useRoute,
  navigate,
  routePath,
  sections,
  type Route,
  type Section,
} from "./navigation";
import "./workspace.css";
const OrganizationChart = lazy(() =>
  import("./OrganizationChart").then((module) => ({
    default: module.OrganizationChart,
  })),
);

type Session = {
  harness: "codex" | "opencode";
  id: string;
  native_id: string | null;
  agent_id: string;
  group_id: string;
  side_chat_id: string | null;
  workspace: string;
  active: boolean;
};
type FileView = {
  entries?: { name: string; directory: boolean }[];
  text?: string;
  base: string;
};
type SearchResult = {
  messages?: Message[];
  artifacts?: { id: string; name: string; snippet: string; distance: number }[];
};
const active = isActiveRun;
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
const shortPath = (value: string) =>
  value.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
function chatMessagesPath(groupId: string, side: string | null, before?: string) {
  const query = new URLSearchParams(side ? { side_chat_id: side } : { main: "true" });
  if (before) query.set("before", before);
  return `/groups/${groupId}/messages?${query}`;
}
export default function App({role = "owner", controllerAccess = true, user = "owner", workspaceName = "My workspace", workspaceSettings}: {role?: string; controllerAccess?: boolean; user?: string; workspaceName?: string; workspaceSettings?: ReactNode}) {
  const [data, setData] = useState<StateView | null>(null);
  const [catalog, setCatalog] = useState<CodexSettings | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const navigationPanel = useRef<PanelImperativeHandle | null>(null);
  const edgePointer = useRef(0);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const resize = () => setMobile(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const catalogRevision = data?.agents.map((a) => `${a.id}:${a.revision}`).join(",");
  const route = useRoute();
  const groupId = route.groupId;
  const sideChatId = route.sideChatId;
  const selectedAgent = route.agentId;
  const selectedRun = data?.runs.find((run) => run.id === route.runId) ?? null;
  const routeError =
    !route.valid ||
    (data &&
      ((!["Organization", "Action board", "User settings", "Profile", "Workspace settings"].includes(route.view) &&
        !data.groups.some((g) => g.id === groupId)) ||
        (selectedAgent && !data.agents.some((a) => a.id === selectedAgent)) ||
        (route.runId && !selectedRun)));
  const tab = routeError ? "NotFound" : route.view;
  function go(patch: Partial<Route>, replace = false) {
    setMobileNavigationOpen(false);
    setFilePreview(null);
    previewTrigger.current = null;
    const next = { ...route, ...patch, valid: true };
    if ((patch.groupId && patch.groupId !== groupId) || (patch.view && patch.view !== "Chat")) next.sideChatId = null;
    if (next.groupId !== groupId || next.sideChatId !== sideChatId) { setReply(null); setAttachments([]); }
    navigate(
      routePath(
        next,
        data?.groups.find((g) => g.id === next.groupId),
        data?.agents.find((a) => a.id === next.agentId),
      ),
      replace,
    );
  }
  const setSelectedRun = (run: Run | null) =>
    go({ runId: run?.id ?? null, agentId: null });
  const setSelectedAgent = (id: string | null) =>
    go({ view: "Organization", agentId: id, section: "Profile", runId: null });
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [ownerKey, setOwnerKey] = useState("");
  const [loadedMessages, setMessages] = useState<Message[]>([]);
  const [messagesScope, setMessagesScope] = useState("");
  const messages = messagesScope === `${groupId}:${sideChatId ?? "main"}` ? loadedMessages : [];
  const [error, setError] = useState("");
  const [deletedAgentsOpen, setDeletedAgentsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [reply, setReply] = useState<Message | null>(null);
  const [runEvents, setRunEvents] = useState<Event[]>([]);
  const [filePreview, setFilePreview] = useState<{ file: MarkdownFile; scope: string } | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const preview = tab === "Chat" && filePreview?.scope === `${groupId}:${sideChatId ?? "main"}` ? filePreview.file : null;
  const openPreview = useCallback((file: MarkdownFile | null) => {
    if (!file) {
      const trigger = previewTrigger.current;
      previewTrigger.current = null;
      setFilePreview(null);
      requestAnimationFrame(() => trigger?.focus());
      return;
    }
    if (!previewTrigger.current?.isConnected) previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFilePreview({ file, scope: `${groupId}:${sideChatId ?? "main"}` });
  }, [groupId, sideChatId]);
  const [newAgent, setNewAgent] = useState(false);
  const [newAgentProject, setNewAgentProject] = useState("");
  const [projectTeamOpen, setProjectTeamOpen] = useState(true);
  const [groupEditor, setGroupEditor] = useState<Group | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [semantic, setSemantic] = useState(false);
  const [searchMedia, setSearchMedia] = useState("documents");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const cursor = useRef(0);
  const panelGroup = useRef<HTMLDivElement>(null);
  const pendingMessage = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const groupRef = useRef({ groupId, sideChatId });
  useEffect(() => {
    groupRef.current = { groupId, sideChatId };
  }, [groupId, sideChatId]);

  const perform = useCallback(
    (work: () => Promise<void>, clearError = true) =>
      work().then(
        () => {
          if (clearError) setError("");
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [setError],
  );
  const refresh = useCallback(async () => {
    const response = await api<StateView>("/state");
    // Deleted groups remain recoverable in storage but are not exposed in platform navigation.
    const snapshot = { ...response, groups: response.groups.filter((g) => !g.deleted_at) };
    setData(snapshot);
    cursor.current = snapshot.cursor;
    const { groupId: id, sideChatId: side } = groupRef.current;
    const next = snapshot.groups.some((g) => g.id === id)
      ? await api<Message[]>(chatMessagesPath(id, side))
      : [];
    if (id === groupRef.current.groupId && side === groupRef.current.sideChatId) {
      setMessages(next);
      setMessagesScope(`${id}:${side ?? "main"}`);
    }
  }, [setMessages, setMessagesScope]);
  useEffect(() => {
    if (!authenticated || !controllerAccess) return;
    void perform(async () => setCatalog(await api<CodexSettings>("/codex/settings")), false);
  }, [authenticated, catalogRevision, perform, controllerAccess]);
  useEffect(() => {
    void perform(async () => {
      const fragment = new URLSearchParams(location.hash.slice(1)).get("key");
      if (fragment) {
        history.replaceState(null, "", location.pathname + location.search);
        await post("/login", { token: fragment });
      }
      try {
        await refresh();
        setConnected(true);
        setAuthenticated(true);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 401)
          setAuthenticated(false);
        else throw e;
      }
    });
  }, [perform, refresh]);
  useEffect(() => {
    if (authenticated && data && !routeError) {
      navigate(
        routePath(
          route,
          data.groups.find((g) => g.id === groupId),
          data.agents.find((a) => a.id === selectedAgent),
        ),
        true,
      );
    }
  }, [authenticated, data, routeError, route, groupId, selectedAgent]);
  useEffect(() => {
    if (!authenticated) return;
    if (role !== "owner") { const poll = setInterval(() => {void refresh().then(()=>setConnected(true), (e: unknown)=>{setConnected(false);setError(e instanceof Error?e.message:String(e));});}, 2000); return () => clearInterval(poll); }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const source = new EventSource(`/api/events?after=${cursor.current}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          void perform(refresh, false);
        }, 350);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [authenticated, perform, refresh, role]);
  useEffect(() => {
    if (authenticated) void perform(refresh);
  }, [groupId, sideChatId, authenticated, perform, refresh]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length]);
  useEffect(() => {
    if (selectedRun)
      void perform(async () =>
        setRunEvents(await api<Event[]>(`/runs/${selectedRun.id}/events`)),
      );
  }, [selectedRun, data?.cursor, perform]);

  const group = data?.groups.find((g) => g.id === groupId);
  const groupClosed = !!(group?.archived_at || group?.deleted_at);
  const organizationAgents = data?.agents ?? [];
  const allAgents = [...organizationAgents, ...(data?.deleted_agents ?? [])];
  const groupAccess = data?.group_access?.[groupId];
  const participants = organizationAgents.filter((agent) => !groupAccess || groupAccess.participant_ids.includes(agent.id));
  const composerInput = useRef<CommandInputHandle>(null);
  const mentionedAgents = /@all\b/i.test(draft)
    ? participants.filter((a) => a.enabled)
    : participants.filter((a) =>
        draft.toLowerCase().includes(`@${a.name.toLowerCase()}`) || draft.includes(`@${a.id}`),
      );
  const running =
    data?.runs.filter((r) => r.group_id === groupId && active(r)) ?? [];
  const chatRunning = running.filter((r) => (r.side_chat_id ?? null) === sideChatId);
  const pendingQuestions = (data?.questions ?? []).filter(q => q.status === "pending" && data?.groups.some(g => g.id === q.group_id));
  const chatQuestions = pendingQuestions.filter(q => q.group_id === groupId && q.side_chat_id === sideChatId);
  const agent = data?.agents.find((a) => a.id === selectedAgent);

  async function send() {
    if (!draft.trim() || busy || groupClosed) return;
    setBusy(true);
    await perform(async () => {
      const content = {
        group_id: groupId,
        body: draft,
        side_chat_id: sideChatId,
        recipients: [], // The server resolves complete mentions and enforces room membership.
        reply_to: reply?.id ?? null,
        artifacts: attachments,
      };
      const fingerprint = JSON.stringify(content);
      if (pendingMessage.current?.fingerprint !== fingerprint)
        pendingMessage.current = { fingerprint, id: requestId() };
      const sent = await post<Message>("/messages", { id: pendingMessage.current.id, ...content });
      if (sent.command === "btw" && sent.side_chat_id) go({ sideChatId: sent.side_chat_id, view: "Chat" });
      pendingMessage.current = null;
      setDraft("");
      setReply(null);
      setAttachments([]);
      await refresh();
    });
    setBusy(false);
  }
  async function upload(file: File) {
    await perform(async () => {
      const form = new FormData();
      form.append("group_id", groupId);
      form.append("file", file);
      const artifact = await api<Artifact>("/artifacts", {
        method: "POST",
        body: form,
      });
      if (tab === "Chat") setAttachments((old) => [...old, artifact.id]);
      await refresh();
    });
  }

  async function addReportToKnowledge(file: MarkdownFile, source: Blob): Promise<Artifact> {
    const snapshot = await api<StateView>("/state");
    const target = snapshot.groups.find((group) => group.id === groupId);
    if (!target || target.archived_at || target.deleted_at) throw new Error("Restore this group to add knowledge.");
    const bytes = new Uint8Array(await source.arrayBuffer());
    let artifact: Artifact | undefined;
    // ponytail: sequential adds reuse exact bytes; concurrent adds need server-side hash uniqueness.
    for (const candidate of snapshot.artifacts.filter((item) => item.group_id === groupId && item.status !== "deleted" && item.media_type.startsWith("text/") && item.name === file.name && item.size === source.size)) {
      const response = await fetch(`/api/artifacts/${candidate.id}`);
      if (!response.ok) throw new Error("Unable to check existing knowledge files. Please try again.");
      const saved = new Uint8Array(await response.arrayBuffer());
      if (saved.length === bytes.length && saved.every((byte, index) => byte === bytes[index])) { artifact = candidate; break; }
    }
    if (!artifact) {
      const form = new FormData();
      form.append("group_id", groupId);
      form.append("file", new Blob([source], { type: "text/markdown" }), file.name);
      artifact = await api<Artifact>("/artifacts", { method: "POST", body: form });
    }
    if (artifact.status === "stored" || artifact.status === "failed") artifact = await post<Artifact>(`/artifacts/${artifact.id}/index`);
    await refresh();
    return artifact;
  }

  if (authenticated !== true)
    return (
      <main className="login-page">
        <div className="login-card">
          <img className="brand-mark" src="/agentic-enterprise-logo.png" alt="Agentic Enterprise logo" width={44} height={44} />
          <p className="eyebrow">YOUR PERSONAL AGENT WORKSPACE</p>
          <h1>Agentic Enterprise</h1>
          <p>One place for your agents, codebases, and conversations.</p>
          {authenticated === null ? (
            <p>Connecting to your local workspace…</p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  await post("/login", { token: ownerKey.trim() });
                  setOwnerKey("");
                  setAuthenticated(true);
                  await refresh();
                });
              }}
            >
              <Label htmlFor="owner-key">Owner key</Label>
              <Input
                id="owner-key"
                type="password"
                value={ownerKey}
                onChange={(e) => setOwnerKey(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Button type="submit" className="w-full mt-4">
                Open workspace <ArrowUp size={16} />
              </Button>
              <p className="hint">
                Use the native Open script, or enter the key from
                org/.state/owner.key.
              </p>
            </form>
          )}
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <span className="local-label">
            <ShieldCheck size={14} /> Native on this machine
          </span>
        </div>
      </main>
    );

  const navigation = (
          <aside className="sidebar">
            <div className="brand">
              <img className="brand-mark" src="/agentic-enterprise-logo.png" alt="Agentic Enterprise logo" width={44} height={44} />
              <div>
                <strong>Agentic Enterprise</strong>
                <span>{workspaceName}</span>
              </div>
            </div>
            {role === "owner" && <button
              className="search-button"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} /> Search your workspace <kbd>⌕</kbd>
            </button>}
            {data && (
              <GroupList
                readOnly={role !== "owner"}
                groups={data.groups}
                preferences={data.group_preferences}
                selected={["Organization", "Action board", "User settings", "Profile", "Workspace settings"].includes(tab) ? null : groupId}
                running={data.runs.filter(active).map((r) => r.group_id)}
                onCreate={() => setGroupEditor({ id: "", name: "", description: "", member_ids: [], human_ids: [], project:null, scope_levels: null, chat_lead_id: null, archived_at: null, deleted_at: null })}
                onCreateProject={() => setGroupEditor({ id:"", name:"", description:"", project:{workdir:{path:"",canonical_path:"",git_root:null,ssh_host:null},members:[]},scope_levels:null,chat_lead_id:null,archived_at:null,deleted_at:null })}
                onSave={async (preferences) => {
                  await put("/preferences/groups", preferences);
                  await refresh();
                }}
                onSelect={(id) => {
                  go({ groupId: id, view: "Chat", agentId: null, runId: null });
                  setReply(null);
                  setAttachments([]);
                }}
              />
            )}
            <div className="sidebar-bottom">
              {role === "owner" && <nav className="sidebar-shortcuts" aria-label="Workspace tools">
                <button className={`organization-button ${tab === "Action board" ? "selected" : ""}`} onClick={() => go({view:"Action board",agentId:null,runId:null})}><ListChecks size={18}/><span>Action board</span><ChevronRight size={15}/></button>
                <button
                  className={`organization-button ${tab === "Organization" ? "selected" : ""}`}
                  onClick={() => {
                    go({ view: "Organization", agentId: null, runId: null });
                  }}
                >
                  <Network size={18} />
                  <span>Organization</span>
                  <ChevronRight size={15} />
                </button>
              </nav>}
              <nav className="sidebar-shortcuts settings-navigation" aria-label="Settings">
                <button className={`organization-button ${tab === "User settings" ? "selected" : ""}`} onClick={()=>go({view:"User settings",agentId:null,runId:null})}><Server size={18}/><span>Runtime</span><ChevronRight size={15}/></button>
                <button className={`organization-button ${tab === "Profile" ? "selected" : ""}`} onClick={()=>go({view:"Profile",agentId:null,runId:null})}><UserRound size={18}/><span>Profile</span><ChevronRight size={15}/></button>
                <button className={`organization-button ${tab === "Workspace settings" ? "selected" : ""}`} onClick={()=>go({view:"Workspace settings",agentId:null,runId:null})}><Building2 size={18}/><span>Workspace</span><ChevronRight size={15}/></button>
              </nav>
              <div className="owner-row">
                <Avatar owner />
                <button className="owner-settings" aria-label="Your profile" title="Your profile" onClick={() => go({ view: "Profile", agentId: null, runId: null })}>
                  <strong>{user}</strong>
                </button>
                {role === "owner" && <button
                  aria-label="Archived groups"
                  title="Archived groups"
                  onClick={() => setArchiveOpen(true)}
                >
                  <Archive size={17} />
                </button>}
                <button
                  aria-label="Sign out"
                  onClick={() =>
                    void perform(async () => {
                      await post("/logout");
                      location.reload();
                    })
                  }
                >
                  <LogOut size={16} />
                </button>
              </div>
            </div>
          </aside>
  );

  return (
    <div className="shell">
      <PanelGroup
        className="workspace-panels"
        elementRef={panelGroup}
        onLayoutChanged={(_, meta) => {
          if (meta.isUserInteraction) {
            // Keyboard layout commits precede ResizeObserver; measure after React paints.
            requestAnimationFrame(() => {
              const widths: Record<string, number> = {};
              for (const name of ["sidebar", "inspector"]) {
                const panel = panelGroup.current?.querySelector(`.${name}`);
                if (panel && !mobile && panel.getBoundingClientRect().width >= (name === "sidebar" ? 180 : 300))
                  widths[name] = Math.round(
                    panel.getBoundingClientRect().width,
                  );
              }
              if (Object.keys(widths).length)
                void perform(async () => {
                  await put("/preferences/panels", widths);
                });
            });
          }
        }}
      >
        {!mobile && <Panel
          id="sidebar"
          panelRef={navigationPanel}
          collapsible
          collapsedSize={0}
          onResize={(size) => setNavigationOpen(size.inPixels > 0)}
          defaultSize={data?.panel_sizes.sidebar ?? 258}
          minSize={180}
          maxSize={420}
        >
          {navigationOpen && navigation}
        </Panel>}
        {!mobile && <Separator
          className="panel-separator navigation-separator"
          aria-label="Resize main navigation"
          title="Click to hide or show navigation. Drag to resize."
          onPointerDownCapture={(event) => { edgePointer.current = event.clientX; }}
          onClick={(event) => {
            if (Math.abs(event.clientX - edgePointer.current) < 4) {
              if (navigationPanel.current?.isCollapsed()) navigationPanel.current.expand();
              else navigationPanel.current?.collapse();
            }
          }}
        />}
        <Panel id="content" minSize={mobile && (agent || selectedRun || preview) ? 0 : 220}>
          <main className={`main-panel${preview ? " has-file-preview" : ""}`} inert={mobile && !!(agent || selectedRun || preview)}>
            {(mobile || !navigationOpen) && <div className="navigation-toolbar">
              <button aria-label="Show navigation" onClick={() => mobile ? setMobileNavigationOpen(true) : navigationPanel.current?.expand()}><PanelLeftOpen size={20} /><span>Workspace</span></button>
            </div>}
            {tab === "NotFound" && (
              <div className="empty-state">
                <h2>Page not found</h2>
                <p>This group, agent or view is unavailable.</p>
                <Button
                  onClick={() =>
                    go({
                      groupId: "general",
                      view: "Chat",
                      agentId: null,
                      runId: null,
                    })
                  }
                >
                  Open General
                </Button>
              </div>
            )}
            {tab !== "Organization" && tab !== "Action board" && tab !== "User settings" && tab !== "Profile" && tab !== "Workspace settings" && tab !== "NotFound" && (
              <>
                <header className="topbar">
                  <div className="group-title">
                    {group?.project?<FolderKanban size={23}/>:<Hash size={23} />}
                    <div>
                      <h1>{group?.name}</h1>
                      <p>{group?.description}</p>
                    </div>
                  </div>
                  <div className="topbar-actions">
                    {tab === "Chat" && <ChatActivity questions={chatQuestions.map(q => q.run_id)} runs={(data?.runs ?? []).filter((r) => r.group_id === groupId && (r.side_chat_id ?? null) === sideChatId)} onOpen={setSelectedRun} />}
                    <Dialog>
                      <DialogTrigger render={<button className="group-members-trigger" aria-label="View group agents" />}>
                        <span className="avatar-stack">
                          {participants.slice(0, 4).map((a) => <Avatar key={a.id} agent={a} />)}
                          {participants.length === 0 && <Users size={18} />}
                        </span>
                        <span className="group-members-count">{participants.length}</span>
                      </DialogTrigger>
                      <DialogContent className="group-members-dialog">
                        <DialogHeader>
                          <DialogTitle>Agents in {group?.name}</DialogTitle>
                          <DialogDescription>{participants.length} agents in this group’s chat scope. Mention @name to message them directly.</DialogDescription>
                        </DialogHeader>
                        <ul className="group-members-list" aria-label="Group agents">
                          {participants.map((a) => (
                            <li key={a.id}>
                              <Avatar agent={a} />
                              <div><strong>{a.name}</strong><span>{a.position || a.role}</span></div>
                              {!a.enabled ? <Badge variant="outline">Paused</Badge> : null}
                            </li>
                          ))}
                        </ul>
                        {participants.length === 0 && <p>No agents in this group’s chat scope.</p>}
                      </DialogContent>
                    </Dialog>
                    {role === "owner" && <Button
                      variant="outline"
                      size="sm"
                      onClick={() => group && setGroupEditor(group)}
                    >
                      <Settings2 size={14} /> {group?.project?"Manage project":"Manage group"}
                    </Button>}
                  </div>
                </header>
                {groupClosed && <div className="group-status-banner" role="status">
                  <div><strong>{group?.deleted_at ? "Deleted group" : "Archived group"}</strong><p>History and files are kept. Restore this group to make changes. Scheduled tasks stay paused.</p></div>
                  <Button size="sm" variant="outline" onClick={() => group && setGroupEditor(group)}>Restore group</Button>
                </div>}
                <nav className="view-tabs" aria-label="Group views">
                  {(
                    [
                      ["Chat", MessageSquare],
                      ["Knowledge", FileText],
                      ["Runs", Terminal],
                      ["Scheduled tasks", CalendarClock],
                      ["Actions", ListChecks],
                      ["Structure", Network],
                    ] as const
                  ).filter(([name]) => (role === "owner" || name === "Chat") && (name !== "Structure" || !!group?.project)).map(([name, Icon]) => (
                    <button
                      className={tab === name ? "active" : ""}
                      key={name}
                      onClick={() => {
                        go({ view: name, agentId: null, runId: null });
                      }}
                    >
                      <Icon size={16} />
                      {name}
                      {name === "Runs" && running.length > 0 && (
                        <span>{running.length}</span>
                      )}
                    </button>
                  ))}
                  <span className="view-context">
                    <FolderOpen size={14} />
                    {group?.project ? "Project workdir" : `${participants.filter((a) => a.workdir).length} attached codebases`}
                  </span>
                </nav>
              </>
            )}
            {pendingQuestions.some(q => tab !== "Chat" || q.group_id !== groupId || q.side_chat_id !== sideChatId) && <div className="question-notice" role="status">
              {pendingQuestions.filter(q => tab !== "Chat" || q.group_id !== groupId || q.side_chat_id !== sideChatId).map(q => <button key={q.id} onClick={() => go({groupId:q.group_id,sideChatId:q.side_chat_id,view:"Chat",agentId:null,runId:null})}>
                {q.agent_name} needs your answer · {data?.groups.find(g => g.id === q.group_id)?.name}{q.side_chat_id ? " · Side chat" : ""}
              </button>)}
            </div>}
            {error && (
              <div className="banner error" role="alert">
                {error}
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  <X size={16} />
                </button>
              </div>
            )}
            {!connected && (
              <div className="banner notice" role="status">
                Reconnecting to your workspace…
              </div>
            )}
            {notice && (
              <div className="banner notice" role="status">
                {notice}
                <button
                  aria-label="Dismiss notice"
                  onClick={() => setNotice("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {tab === "Chat" && (
              <>
                <div className="timeline">
                  {sideChatId && (
                    <div className="side-chat-header" role="region" aria-label="Side chat">
                      <Button variant="outline" size="sm" onClick={() => go({ sideChatId: null })}>Back to main chat</Button>
                      <strong>Side chat</strong>
                      <span>Starts with main-chat context, then runs independently. /reset resets only this side chat.</span>
                    </div>
                  )}
                  {!sideChatId && <div className="channel-intro">
                    <div className="channel-symbol">
                      {group?.project?<FolderKanban size={28}/>:<Hash size={28} />}
                    </div>
                    <h2>{group?.project?group.name:"Your team starts here."}</h2>
                    <p>
                      {group?.project ? `Project workspace: ${group.project.workdir.ssh_host ? (data?.workstations?.find(h => h.id === group.project?.workdir.ssh_host)?.name ?? group.project.workdir.ssh_host) + ": " : ""}${group.project.workdir.path}` : "A shared space to give direction, work together, and see what gets done."}
                    </p>
                    <div className="intro-chips">
                      <span>
                        <ShieldCheck size={13} /> Local & private
                      </span>
                      <span>
                        <Terminal size={13} /> Native agent execution
                      </span>
                      <span>
                        <FolderOpen size={13} /> Your existing codebases
                      </span>
                    </div>
                  </div>}
                  {messages.length >= 50 && (
                    <button
                      className="load-more"
                      onClick={() =>
                        void perform(async () => {
                          const older = await api<Message[]>(
                            chatMessagesPath(groupId, sideChatId, messages[0].id),
                          );
                          if (groupRef.current.groupId === groupId && groupRef.current.sideChatId === sideChatId) setMessages([...older, ...messages]);
                        })
                      }
                    >
                      Load earlier messages
                    </button>
                  )}
                  {messages.length > 0 && (
                    <div className="date-separator">
                      <span>
                        {new Date(messages[0].created_at).toLocaleDateString(
                          [],
                          {
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                          },
                        )}
                      </span>
                    </div>
                  )}
                  {messages.map((m) => {
                    const isSelf = m.sender === user;
                    const isHuman = m.sender === "owner" || m.sender.startsWith("@");
                    const sender = allAgents.find((a) => a.id === m.sender);
                    const position = sender?.position || data?.runs.find((run) => run.id === m.run_id)?.profile.position;
                    return (
                    <article className={`message message-${isSelf ? "self" : m.sender === "system" ? "system" : isHuman ? "human" : "agent"}`} key={m.id}>
                      {m.sender === "system" ? (
                        <div className="avatar system-avatar">
                          <Slash size={17} />
                        </div>
                      ) : (
                        <Avatar
                          agent={allAgents.find((a) => a.id === m.sender)}
                          owner={isHuman}
                        />
                      )}
                      <div className="message-content">
                        <div className="message-heading">
                          <strong>
                            {isSelf ? "You" : m.sender === "system"
                              ? "Agentic Enterprise"
                              : m.sender === "owner"
                                ? "Workspace owner"
                                : (allAgents.find((a) => a.id === m.sender)
                                    ?.name ?? m.sender)}
                          </strong>
                          {!isHuman && m.sender !== "system" && position && (
                            <span className="bot-badge" title={position}>{position}</span>
                          )}
                          {!isHuman && m.sender !== "system" && m.run_id && (
                            <MessageModelBadge runId={m.run_id} run={data?.runs.find((r) => r.id === m.run_id)} catalog={catalog} />
                          )}
                          {m.schedule_id && (
                            <span className="scheduled-message-label">
                              <CalendarClock size={12} />
                              Scheduled
                            </span>
                          )}
                          <time>{time(m.created_at)}</time>
                          {m.command !== "question" && <button
                            className="reply-action"
                            disabled={groupClosed}
                            onClick={() => {
                              if (m.side_chat_id && m.side_chat_id !== sideChatId) go({ sideChatId: m.side_chat_id });
                              else setReply(m);
                            }}
                          >
                            Reply
                          </button>}
                        </div>
                        <div className="message-bubble">
                          <div className="markdown">
                            <MessageMarkdown runId={m.run_id} onPreview={openPreview}>
                              {m.command === "btw" ? (m.body.replace(/^\s*\/btw\s*/, "") || "Side conversation") : m.body}
                            </MessageMarkdown>
                          </div>
                          {m.command === "question" && <QuestionCard id={m.id} question={data?.questions?.find(q => q.id === m.id)} onRefresh={refresh} />}
                          {m.artifacts.map((id) => {
                            const file = data?.artifacts.find((a) => a.id === id);
                            const isMarkdown = /\.(md|markdown)$/i.test(file?.name ?? "");
                            return <a
                              key={id}
                              className="attachment-pill"
                              href={`/api/artifacts/${id}`}
                              target={isMarkdown ? undefined : "_blank"}
                              rel="noreferrer"
                              onClick={isMarkdown && file ? (event) => {
                                event.preventDefault();
                                openPreview({ url: `/api/artifacts/${id}`, name: file.name, runId: null });
                              } : undefined}
                            >
                              <Paperclip size={13} />
                              {file?.name ?? "Attachment"}
                            </a>;
                          })}
                        </div>
                        {!sideChatId && m.side_chat_id === m.id && (
                          <Button variant="outline" size="sm" onClick={() => go({ sideChatId: m.id })}>Open side chat</Button>
                        )}
                        {m.usage_report && (
                          <UsageCard report={m.usage_report} />
                        )}
                        {m.run_id && (
                          <button
                            className="run-link"
                            onClick={() => {
                              setSelectedRun(
                                data?.runs.find((r) => r.id === m.run_id) ??
                                  null,
                              );
                            }}
                          >
                            <Check size={13} /> View execution evidence
                          </button>
                        )}
                        {isHuman &&
                          data?.runs
                            .filter((r) => r.message_id === m.id)
                            .map((r) => (
                              <button
                                key={r.id}
                                className={`delivery ${r.status}`}
                                onClick={() => {
                                  setSelectedRun(r);
                                }}
                              >
                                <Circle size={8} fill="currentColor" />
                                {r.profile.name}
                                {r.kind === "delegate"
                                  ? " · delegated"
                                  : r.kind === "summary"
                                    ? " · summary"
                                    : ""}
                                : {r.status.replace("_", " ")}
                                {r.error && (
                                  <span> · {r.error.slice(0, 100)}</span>
                                )}
                              </button>
                            ))}
                      </div>
                    </article>
                  ); })}
                  {chatQuestions.filter(q => !messages.some(m => m.id === q.id)).map(q => <div key={q.id}>
                    <p>{q.agent_name} needs your answer.</p>
                    <QuestionCard id={q.id} question={q} onRefresh={refresh} />
                  </div>)}
                  {chatRunning.length > 0 && (
                    <div className="running-card">
                      <Terminal size={17} />
                      <div>
                        <strong>
                          {chatRunning
                            .map(
                              (r) =>
                                data?.agents.find((a) => a.id === r.agent_id)
                                  ?.name,
                            )
                            .join(", ")}{" "}
                          {chatQuestions.length ? "waiting for your answer" : "working"}
                        </strong>
                        <span>
                          {chatRunning[0].status} · {shortPath(chatRunning[0].cwd)}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void perform(async () => {
                            await post(`/runs/${chatRunning[0].id}/cancel`);
                            await refresh();
                          })
                        }
                      >
                        <Square size={11} /> Stop
                      </Button>
                      <button
                        aria-label="View live output"
                        onClick={() => {
                          setSelectedRun(chatRunning[0]);
                        }}
                      >
                        <MoreHorizontal size={20} />
                      </button>
                    </div>
                  )}
                  <div ref={bottom} />
                </div>
                {!groupClosed && <div className="composer-area">
                  {reply && (
                    <div className="reply-preview">
                      Replying to{" "}
                      {reply.sender === user
                        ? "you"
                        : reply.sender === "owner" ? "Workspace owner"
                        : reply.sender === "system"
                          ? "Agentic Enterprise"
                          : data?.agents.find((a) => a.id === reply.sender)
                              ?.name ?? reply.sender}
                      : {reply.body.slice(0, 90)}
                      <button
                        aria-label="Cancel reply"
                        onClick={() => setReply(null)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <div className="composer">
                    <CommandInput
                      key={`${groupId}:${sideChatId ?? "main"}`}
                      value={draft}
                      agents={participants}
                      ref={composerInput}
                      onChange={setDraft}
                      onSend={() => void send()}
                      busy={busy}
                      placeholder={chatQuestions.length ? "Answer the question above to continue · new messages are queued" : sideChatId ? "Message this side chat · independent session" : `Message #${group?.name ?? ""} · / for commands`}
                    />
                    {attachments.length > 0 && (
                      <div className="compose-attachments">
                        {attachments.map((id) => (
                          <button
                            key={id}
                            onClick={() =>
                              setAttachments((old) =>
                                old.filter((i) => i !== id),
                              )
                            }
                          >
                            <Paperclip size={12} />
                            {data?.artifacts.find((a) => a.id === id)?.name}
                            <X size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="composer-footer">
                      <button aria-label="Mention an agent" onMouseDown={e=>e.preventDefault()} onClick={()=>composerInput.current?.openMentions()}> @ </button>
                      <button
                        aria-label="Attach file"
                        onClick={() => uploadRef.current?.click()}
                      >
                        <Paperclip size={18} />
                      </button>
                      <span className="chat-lead-hint">
                        {draft.trim().startsWith("/")
                          ? draft.trim().startsWith("/reset")
                            ? sideChatId ? "Fresh sessions for this side chat. Main chat and other side chats are unchanged." : "Fresh sessions for this group and its side chats. Other groups are unchanged."
                            : draft.trim().startsWith("/btw") ? "Opens an independent side chat with main-chat context. Add a question to start work." : "Chat commands run directly in your workspace."
                          : mentionedAgents.length > 0
                            ? `Sending to ${mentionedAgents.map((a) => a.name).join(", ")}.`
                            : "Room message · mention an agent to start work."}
                      </span>
                      <Button
                        aria-label="Send message"
                        disabled={!draft.trim() || busy}
                        size="icon"
                        onClick={() => void send()}
                      >
                        <ArrowUp size={18} />
                      </Button>
                    </div>
                  </div>
                  <p className="composer-hint">
                    Enter to send · Shift + Enter for a new line · / for
                    commands · @name to send directly{" "}
                    <span>Agent activity is saved to your organization.</span>
                  </p>
                </div>}
              </>
            )}
            {tab === "Runs" && (
              <div className="content-view">
                <div className="view-heading">
                  <div>
                    <h2>Execution history</h2>
                    <p>Real processes. Inspectable outcomes.</p>
                  </div>
                  <Badge variant="outline">
                    {data?.runs.filter((r) => r.group_id === groupId).length}{" "}
                    recent runs
                  </Badge>
                </div>
                {data?.runs
                  .filter((r) => r.group_id === groupId)
                  .map((r) => (
                    <button
                      className="run-row"
                      key={r.id}
                      onClick={() => {
                        setSelectedRun(r);
                      }}
                    >
                      <Avatar
                        agent={data.agents.find((a) => a.id === r.agent_id)}
                      />
                      <div>
                        <strong>
                          {data.agents.find((a) => a.id === r.agent_id)?.name}
                        </strong>
                        <small>{r.cwd}</small>
                      </div>
                      <Badge variant="outline">{r.status}</Badge>
                      <time>{time(r.created_at)}</time>
                    </button>
                  ))}
                {!data?.runs.some((r) => r.group_id === groupId) && (
                  <Empty
                    icon={<Terminal size={28} />}
                    title="Your runs will appear here"
                    text="Select an agent when sending a message to start its first run."
                  />
                )}
              </div>
            )}
            {tab === "Scheduled tasks" && (
              <ScheduledTasks
                readOnly={groupClosed}
                key={`${groupId}:${groupClosed}`}
                groupId={groupId}
                tasks={
                  data?.schedules.filter((s) => s.group_id === groupId) ?? []
                }
                runs={data?.runs ?? []}
                onRefresh={refresh}
                onOpenRun={(id) => go({ runId: id })}
              />
            )}
            {tab === "Knowledge" && (
              <KnowledgeExplorer
                readOnly={groupClosed}
                key={`${groupId}:${groupClosed}`}
                files={
                  data?.artifacts.filter((a) => a.group_id === groupId) ?? []
                }
                groupName={group?.name ?? ""}
                onUpload={() => uploadRef.current?.click()}
                onRefresh={refresh}
                perform={perform}
              />
            )}
            {(tab === "Action board" || tab === "Actions") && data && <ActionBoard key={tab === "Actions" ? groupId : "organization"} data={data} groupId={tab === "Actions" ? groupId : undefined} onRefresh={refresh} onOpenRun={(groupId,runId)=>go({groupId,view:"Runs",runId,agentId:null})}/>}
            {tab === "Profile" && <section className="user-settings"><div className="settings-page"><header className="settings-page-heading"><p className="settings-kicker">ACCOUNT</p><h1>Profile</h1><p>Your signed-in account and workspace access.</p></header><section className="settings-card"><div className="settings-section-title"><UserRound size={20}/><h2>{user}</h2></div><dl className="profile-details"><dt>Account</dt><dd>{user === "owner" ? "Platform administrator" : "Matrix account"}</dd><dt>Workspace</dt><dd>{workspaceName}</dd><dt>Role</dt><dd>{role === "owner" ? "Owner" : "Member"}</dd></dl></section></div></section>}
            {tab === "Workspace settings" && <section className="user-settings"><div className="settings-page"><header className="settings-page-heading"><p className="settings-kicker">SETTINGS</p><h1>Workspace</h1><p>Manage your workspace, people, and their access.</p></header>{workspaceSettings}</div></section>}
            {tab === "User settings" && <UserSettings role={role} user={user} controllerAccess={controllerAccess} workstations={data?.workstations ?? []} onRefresh={refresh}/>}
            {tab === "Structure" && group?.project && data && <div className="project-structure-view">{projectTeamOpen && <ProjectTeam key={`${group.id}:${JSON.stringify(group.project.members)}`} group={group} agents={data.agents} onSaved={refresh} onClose={() => setProjectTeamOpen(false)} onAdd={() => { setNewAgentProject(groupId); setNewAgent(true); }}/>}<Suspense fallback={<div className="empty-state">Opening project structure…</div>}><OrganizationChart key={groupId} workstations={data.workstations ?? []}
              projectName={group.name} layoutPath={`/organization/layout?group_id=${encodeURIComponent(groupId)}`}
              agents={data.agents.filter(a=>group.project!.members.some(m=>m.agent_id===a.id)).map(a=>({...a,reports_to:group.project!.members.find(m=>m.agent_id===a.id)?.manager_id??null,workdir:group.project!.workdir}))}
              connections={Object.fromEntries(group.project.members.map(m=>[m.agent_id,data.project_connections?.[groupId]]))} savedLayout={data.project_layouts?.[groupId]??{}}
              onDeletedAgents={()=>setProjectTeamOpen(true)} selected={selectedAgent} onSelect={id => go({ agentId: id, section: "Profile", runId: null })}
              onAdd={()=>{setNewAgentProject(groupId);setNewAgent(true);}}/></Suspense></div>}
            {tab === "Organization" && (
              <Suspense
                fallback={
                  <div className="empty-state">Opening organization…</div>
                }
              >
                <OrganizationChart
                  workstations={data?.workstations ?? []}
                  agents={(data?.agents ?? []).map(a=>a.project_id?{...a,workdir:data?.groups.find(g=>g.id===a.project_id)?.project?.workdir??a.workdir}:a)}
                  connections={data?.connections ?? {}}
                  savedLayout={data?.organization_layout ?? {}}
                  onDeletedAgents={() => setDeletedAgentsOpen(true)}
                  selected={selectedAgent}
                  onSelect={(id) => {
                    setSelectedAgent(id);
                  }}
                  onAdd={() => { setNewAgentProject(""); setNewAgent(true); }}
                />
              </Suspense>
            )}
          </main>
        </Panel>
        {!mobile && (agent || selectedRun || preview) && (
          <Separator
            className="panel-separator"
            aria-label={preview ? "Resize Markdown preview" : "Resize agent configuration"}
          />
        )}
        {(agent || selectedRun || preview) && (
          <Panel
            id="inspector"
            defaultSize={mobile ? "100%" : data?.panel_sizes.inspector ?? (preview ? 560 : 370)}
            minSize={mobile ? "100%" : 300}
            maxSize={mobile ? "100%" : 900}
          >
            {preview && <MarkdownPreview key={preview.url} file={preview} onClose={() => openPreview(null)} onPreview={openPreview}
              onAddToKnowledge={addReportToKnowledge} artifacts={(data?.artifacts ?? []).filter((file) => file.group_id === groupId)}
              groupName={group?.name ?? "this group"} readOnly={groupClosed} />}
            {agent && !preview && (
              <AgentInspector
                controllerAccess={controllerAccess}
                key={`${agent.id}-${agent.revision}`}
                agent={agent}
                workstations={data?.workstations ?? []}
                connection={data?.connections?.[agent.id]}
                groups={data?.groups ?? []}
                runs={data?.runs ?? []}
                agents={data?.agents ?? []}
                section={route.section}
                onSectionChange={(section) => go({ section })}
                onClose={() => tab === "Structure" ? go({ agentId: null }) : setSelectedAgent(null)}
                onSaved={refresh}
                perform={perform}
              />
            )}
            {selectedRun && !preview && (
              <aside className="inspector">
                <div className="inspector-heading">
                  <strong>Execution evidence</strong>
                  <button
                    aria-label="Close run details"
                    onClick={() => setSelectedRun(null)}
                  >
                    <PanelRightClose size={18} />
                  </button>
                </div>
                <RunInspector
                  run={
                    data?.runs.find((r) => r.id === selectedRun.id) ??
                    selectedRun
                  }
                  events={runEvents}
                  questions={(data?.questions ?? []).filter(q => q.run_id === selectedRun.id)}
                  onRefresh={refresh}
                  onCancel={() =>
                    void perform(async () => {
                      await post(`/runs/${selectedRun.id}/cancel`);
                      await refresh();
                    })
                  }
                />
              </aside>
            )}
          </Panel>
        )}
      </PanelGroup>
      {mobile && <Dialog open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
        <DialogContent className="mobile-navigation" style={{ translate: "none" }} showCloseButton={false}>
          <DialogHeader className="sr-only"><DialogTitle>Workspace navigation</DialogTitle><DialogDescription>Your groups and organization.</DialogDescription></DialogHeader>
          <button className="mobile-navigation-close" aria-label="Hide navigation" onClick={() => setMobileNavigationOpen(false)}><PanelLeftClose size={20} /></button>
          {navigation}
        </DialogContent>
      </Dialog>}
      <ArchivedGroups open={archiveOpen} onClose={() => setArchiveOpen(false)} groups={data?.groups ?? []}
        onOpen={(id) => go({ groupId: id, view: "Chat", agentId: null, runId: null })} onRefresh={refresh} />
      <input
        ref={uploadRef}
        className="hidden"
        type="file"
        multiple
        aria-label="Upload attachment"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void (async () => {
            for (const file of files) await upload(file);
          })();
          e.target.value = "";
        }}
      />
      <Dialog open={deletedAgentsOpen} onOpenChange={setDeletedAgentsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deleted agents</DialogTitle>
            <DialogDescription>
              Restore an agent with its saved profile and files. Restored agents
              start disabled.
            </DialogDescription>
          </DialogHeader>
          <div className="session-list">
            {data?.deleted_agents.map((deleted) => (
              <div key={deleted.id}>
                <strong>{deleted.name}</strong>
                <p>{deleted.role}</p>
                <Button
                  variant="outline"
                  onClick={() =>
                    void perform(async () => {
                      await post(`/agents/${deleted.id}/restore`);
                      await refresh();
                    })
                  }
                >
                  Restore {deleted.name}
                </Button>
              </div>
            ))}
            {!data?.deleted_agents.length && <p>No deleted agents.</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={newAgent} onOpenChange={setNewAgent}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add your agent</DialogTitle>
            <DialogDescription>
              Give it a name, position, and role. Attach its codebase next.
            </DialogDescription>
          </DialogHeader>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              void perform(async () => {
                const a = await post<Agent>("/agents", {
                  id: "",
                  name: String(fields.get("name")),
                  project_id: String(fields.get("project_id")??"") || null,
                  position: String(fields.get("position") ?? ""),
                  role: String(fields.get("role")),
                  color: getComputedStyle(document.documentElement).getPropertyValue("--gauss-700").trim(),
                  harness: String(fields.get("harness") || "codex"),
                  model: "",
                  reasoning: "",
                  reports_to: String(fields.get("reports_to") ?? "") || null,
                  instructions:
                    "Work carefully. Explain your changes and verify the result.",
                  agents_md: "",
                  workdir: null,
                  permission: fields.get("harness") === "opencode" ? "danger-full-access" : "read-only",
                  timeout_seconds: 1800,
                  enabled: true,
                  deleted_at: null,
                  revision: 1,
                });
                await refresh();
                setNewAgent(false);
                if (a.project_id) { setProjectTeamOpen(true); go({ groupId: a.project_id, view: "Structure", agentId: a.id, section: "Profile", runId: null }); }
                else setSelectedAgent(a.id);
              });
            }}
          >
            <Label htmlFor="agent-project">Agent scope</Label>
            <select id="agent-project" name="project_id" defaultValue={newAgentProject}><option value="">Organization agent</option>{data?.groups.filter(g=>g.project&&!g.archived_at).map(g=><option key={g.id} value={g.id}>Project: {g.name}</option>)}</select>
            <Label htmlFor="agent-harness">Harness</Label>
            <select id="agent-harness" name="harness" defaultValue="codex"><option value="codex">Codex CLI</option><option value="opencode">OpenCode</option></select>
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              name="name"
              placeholder="Engineer"
              required
              maxLength={80}
            />
            <Label htmlFor="agent-position">Position</Label>
            <Input
              id="agent-position"
              name="position"
              placeholder="Software Engineer"
              maxLength={120}
            />
            <Label htmlFor="agent-role">Role</Label>
            <Input
              id="agent-role"
              name="role"
              placeholder="Build and maintain our products"
            />
            <Label htmlFor="agent-manager">Reports to</Label>
            <select id="agent-manager" name="reports_to" defaultValue="">
              <option value="">Organization owner</option>
              {data?.agents.filter(a=>!a.project_id).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button type="submit">Create agent</Button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
      {groupEditor && <GroupDialog controllerAccess={controllerAccess} key={`${groupEditor.id}:${groupEditor.archived_at}:${groupEditor.deleted_at}`}
        group={data?.groups.find((g) => g.id === groupEditor.id) ?? groupEditor}
        agents={organizationAgents}
        workstations={data?.workstations ?? []}
        onClose={() => setGroupEditor(null)}
        onSaved={async (saved) => {
          await refresh();
          go(saved.deleted_at ? { view: "Organization", agentId: null, runId: null } : { groupId: saved.id, view: saved.project && !groupEditor.id ? "Structure" : "Chat", agentId: null, runId: null });
          if (saved.project && !groupEditor.id) setProjectTeamOpen(true);
          setReply(null); setAttachments([]);
          setNotice(saved.deleted_at ? "Group deleted and hidden from the platform."
            : saved.archived_at ? "Group archived. Find it beside Sign out. Scheduled tasks are paused." : saved.project && !groupEditor.id ? "Project created. Add agents and reporting lines below." : "Group saved. Scheduled tasks can be reviewed in their tab.");
        }} />}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="search-dialog">
          <DialogHeader>
            <DialogTitle>Search #{group?.name}</DialogTitle>
            <DialogDescription>
              Find earlier messages or indexed documents and images.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () =>
                setSearchResult(
                  await api<SearchResult>(
                    `/search?group_id=${encodeURIComponent(groupId)}&q=${encodeURIComponent(searchQuery)}&semantic=${semantic}&media=${searchMedia}`,
                  ),
                ),
              );
            }}
            className="form-stack"
          >
            <Input
              aria-label="Search query"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="What are you looking for?"
              required
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={semantic}
                onChange={(e) => setSemantic(e.target.checked)}
              />{" "}
              Semantic document & image search
            </label>
            {semantic && (
              <select
                aria-label="Search file type"
                value={searchMedia}
                onChange={(e) => setSearchMedia(e.target.value)}
              >
                <option value="documents">Documents</option>
                <option value="images">Images</option>
              </select>
            )}
            <Button type="submit">
              <Search size={15} /> Search
            </Button>
          </form>
          <div className="search-results">
            {searchResult?.messages?.map((m) => (
              <article key={m.id}>
                <small>{time(m.created_at)}</small>
                <p>{m.body}</p>
              </article>
            ))}
            {searchResult?.artifacts?.map((a) => (
              <a
                key={a.id}
                href={`/api/artifacts/${a.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <strong>{a.name}</strong>
                <p>{a.snippet}</p>
                <small>CLIP similarity · source file</small>
              </a>
            ))}
            {searchResult &&
              !(
                searchResult.messages?.length || searchResult.artifacts?.length
              ) && <p>No results in this group.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Empty({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function RunInspector({
  run,
  events,
  onCancel,
  questions,
  onRefresh,
}: {
  run: Run;
  events: Event[];
  onCancel: () => void;
  questions: QuestionRequest[];
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="inspector-body">
      <Badge variant="outline">{run.status}</Badge>
      <h2>{run.profile.name}</h2>
      {run.profile.position && <p className="muted">{run.profile.position}</p>}
      {questions.map(q => <QuestionCard key={q.id} id={q.id} question={q} onRefresh={onRefresh} />)}
      <dl className="details">
        <dt>Working directory</dt>
        <dd>{run.cwd}</dd>
        <dt>Process</dt>
        <dd>
          PID {run.pid ?? "not started"} · exit {run.exit_code ?? "pending"}
        </dd>
        <dt>Profile revision</dt>
        <dd>{run.profile.revision}</dd>
        <dt>Provider session</dt>
        <dd>{run.native_session_id ?? "Not assigned yet"}</dd>
        <dt>Started</dt>
        <dd>{run.started_at ?? "Queued"}</dd>
        <dt>Executable</dt>
        <dd>{run.executable || "Pending launch"}</dd>
      </dl>
      {active(run) && (
        <Button variant="outline" onClick={onCancel}>
          <Square size={12} /> Stop run
        </Button>
      )}
      {run.error && <p className="error">{run.error}</p>}
      <details>
        <summary>Launch arguments</summary>
        <pre>{run.arguments.join("\n")}</pre>
      </details>
      {run.usage && (
        <details>
          <summary>Reported usage</summary>
          <pre>{JSON.stringify(run.usage, null, 2)}</pre>
        </details>
      )}
      {run.organization_context && (
        <details>
          <summary>Organization context supplied to this run</summary>
          <OrganizationRelationships context={run.organization_context} />
          <pre>{JSON.stringify(run.organization_context, null, 2)}</pre>
        </details>
      )}
      <h3>Provider events</h3>
      <div className="event-log">
        {events
          .filter((e) => e.kind === "run.output")
          .map((e) => (
            <pre key={String(e.seq)}>
              {typeof e.payload === "object" &&
              e.payload !== null &&
              "line" in e.payload
                ? String(e.payload.line)
                : JSON.stringify(e.payload)}
            </pre>
          ))}
      </div>
    </div>
  );
}

function canManage(candidate: Agent, agent: Agent, agents: Agent[]) {
  const seen = new Set([agent.id]);
  let current: Agent | undefined = candidate;
  while (current) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = agents.find((a) => a.id === current?.reports_to);
  }
  return true;
}

function OrganizationRelationships({
  context,
}: {
  context: OrganizationContext;
}) {
  function person(id: string) {
    if (id === "owner") return `${context.owner_name} (Owner)`;
    const member = context.members.find((m) => m.id === id);
    return member
      ? `${member.name}${member.position ? ` · ${member.position}` : ""}`
      : id;
  }
  const names = (ids: string[]) =>
    ids.length ? ids.map(person).join(", ") : "None";
  return (
    <dl
      className="details organization-relationships"
      aria-label="Organization relationships"
    >
      <dt>Reports to</dt>
      <dd>{person(context.manager_id)}</dd>
      <dt>Management chain</dt>
      <dd>{context.reporting_chain.map(person).join(" → ")}</dd>
      <dt>Direct reports</dt>
      <dd>{names(context.direct_report_ids)}</dd>
      <dt>Team, including indirect reports</dt>
      <dd>{names(context.team_member_ids)}</dd>
      <dt>Peers reporting to the same manager</dt>
      <dd>{names(context.peer_ids)}</dd>
      <dt>Organization</dt>
      <dd>
        {context.members.length} agents, with positions, reporting lines and
        available access
      </dd>
    </dl>
  );
}

function AgentInspector({
  controllerAccess,
  workstations,
  connection,
  agent,
  agents,
  groups,
  runs,
  section,
  onSectionChange,
  onClose,
  onSaved,
  perform,
}: {
  connection?: Connection;
  controllerAccess: boolean;
  workstations: Workstation[];
  agent: Agent;
  agents: Agent[];
  groups: Group[];
  runs: Run[];
  section: Section;
  onSectionChange: (section: Section) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [edited, setEdited] = useState(() => ({
    ...agent,
    instructions: [
      ...new Set(
        [agent.instructions, agent.agents_md].filter((text) => text.trim()),
      ),
    ].join("\n\n"),
    agents_md: "",
  }));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [folderPicker, setFolderPicker] = useState(false);
  const projectWorkdir = groups.find(g=>g.id===agent.project_id)?.project?.workdir;
  const effectiveAgent = projectWorkdir ? {...agent,workdir:projectWorkdir} : agent;
  const [path, setPath] = useState(agent.workdir?.path ?? "");
  const [sshHost, setSshHost] = useState(agent.workdir?.ssh_host ?? "");
  const [runtimeId, setRuntimeId] = useState(agent.workdir?.runtime_id ?? "");
  const remote = Boolean(sshHost);
  const [probe, setProbe] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [scriptScope, setScriptScope] = useState(false);
  const [scriptName, setScriptName] = useState("");
  const [scriptContent, setScriptContent] = useState("");
  const [sessionList, setSessionList] = useState<Session[]>([]);
  const [revisionList, setRevisionList] = useState<Agent[]>([]);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<CodexSettings | null>(null);
  const [organization, setOrganization] = useState<OrganizationContext | null>(
    null,
  );
  const loadOrganization = useCallback(
    async () =>
      setOrganization(
        await api<OrganizationContext>(
          `/agents/${agent.id}/organization-context`,
        ),
      ),
    [agent.id],
  );
  const [modelError, setModelError] = useState("");
  const catalogHost = effectiveAgent.workdir?.ssh_host;
  const modelsRequest = useRef(0);
  const loadModels = useCallback(() => {
    const request = ++modelsRequest.current;
    return api<CodexSettings>(`/harness/settings?harness=${edited.harness}&agent_id=${encodeURIComponent(agent.id)}${runtimeId ? `&runtime_id=${encodeURIComponent(runtimeId)}` : catalogHost ? `&ssh_host=${encodeURIComponent(catalogHost)}` : ""}`).then(settings => {
      if (request === modelsRequest.current) { setModels(settings); setModelError(""); }
    }, (error: unknown) => {
      if (request === modelsRequest.current) setModelError(error instanceof Error ? error.message : String(error));
    });
  }, [catalogHost, runtimeId, edited.harness, agent.id]);
  useEffect(() => {
    if (section !== "Profile") return;
    let request = modelsRequest.current;
    const refresh = () => { void loadModels(); request = modelsRequest.current; };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); if (modelsRequest.current === request) modelsRequest.current = request + 1; };
  }, [loadModels, section]);
  const selectedModel = models?.models.find(
    (m) => m.slug === (edited.model || models.model),
  );
  const inheritedReasoning =
    selectedModel?.slug === models?.model
      ? models?.reasoning
      : selectedModel?.default_reasoning_level;
  async function save(next = edited) {
    const result = await put<Agent>(`/agents/${agent.id}`, next);
    setEdited(result);
    setSaved(true);
    await onSaved();
  }
  const loadFile = useCallback(
    async (relative: string, scripts: boolean) => {
      setFileView(
        await api<FileView>(
          `/agents/${agent.id}/files?path=${encodeURIComponent(relative)}&scope=${scripts ? "scripts" : "workdir"}`,
        ),
      );
      setFilePath(relative);
    },
    [agent.id],
  );
  useEffect(() => {
    if (section === "Profile") void perform(loadOrganization);
    if (section === "Sessions")
      void perform(async () =>
        setSessionList(
          (await api<Session[]>("/sessions")).filter(
            (s) => s.agent_id === agent.id,
          ),
        ),
      );
    if (section === "Code") void perform(() => loadFile("", scriptScope));
    if (section === "History")
      void perform(async () =>
        setRevisionList(await api<Agent[]>(`/agents/${agent.id}/revisions`)),
      );
  }, [
    section,
    agent.id,
    agent.revision,
    scriptScope,
    perform,
    loadFile,
    loadOrganization,
  ]);
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <strong>Agent configuration</strong>
        <button aria-label="Close agent settings" onClick={onClose}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className="agent-summary">
        <Avatar agent={agent} />
        <div>
          <h2>{agent.name}</h2>
          <span>
            {agent.position || agent.role || "Set a position in Profile"}
          </span>
        </div>
        <Badge variant="outline">
          {agent.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>
      <nav className="inspector-tabs">
        {sections.map((s) => (
          <button
            className={section === s ? "active" : ""}
            key={s}
            onClick={() => onSectionChange(s)}
          >
            {s}
          </button>
        ))}
      </nav>
      <div className="inspector-body">
        <p className="project-kind">{agent.project_id ? "Project-specific agent" : agent.workdir?.ssh_host ? "Remote organization agent" : "Organization agent"}</p>
        {projectWorkdir && <p className="hint">Runs, terminal and skills use this project's workdir: <code>{projectWorkdir.path}</code>. <a href={`/projects/${agent.project_id}/structure`}>Open project structure</a></p>}
        {effectiveAgent.workdir?.ssh_host && <WorkstationStatus host={workstations.find(h => h.id === effectiveAgent.workdir?.ssh_host)?.name ?? effectiveAgent.workdir.ssh_host} connection={connection} />}
        {section === "Profile" && (
          <div className="form-stack">
            <Label htmlFor="profile-name">Display name</Label>
            <Input
              id="profile-name"
              value={edited.name}
              onChange={(e) => setEdited({ ...edited, name: e.target.value })}
            />
            <Label htmlFor="profile-position">Position</Label>
            <Input
              id="profile-position"
              value={edited.position}
              placeholder="Software Engineer"
              maxLength={120}
              onChange={(e) =>
                setEdited({ ...edited, position: e.target.value })
              }
            />
            <Label htmlFor="profile-role">Role</Label>
            <Textarea
              id="profile-role"
              value={edited.role}
              placeholder="Responsibilities and scope of this agent"
              onChange={(e) => setEdited({ ...edited, role: e.target.value })}
            />
            <Label htmlFor="profile-manager">Reports to</Label>
            <select
              id="profile-manager"
              disabled={!!agent.project_id}
              value={edited.reports_to ?? ""}
              onChange={(event) =>
                setEdited({ ...edited, reports_to: event.target.value || null })
              }
            >
              <option value="">Organization owner</option>
              {agents
                .filter((a) => canManage(a, agent, agents))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <details className="organization-knowledge">
              <summary>Organization knowledge</summary>
              <p className="hint">
                Every run receives the saved organization structure, including
                direct messages and delegated tasks.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void perform(loadOrganization)}
              >
                Refresh relationships
              </Button>
              {organization && (
                <OrganizationRelationships context={organization} />
              )}
            </details>
            <Label htmlFor="profile-harness">Harness</Label>
            <select id="profile-harness" value={edited.harness} onChange={event => {
              setModels(null); setModelError(""); setProbe("");
              setEdited({...edited, harness: event.target.value as Agent["harness"], model:"", reasoning:"", permission: event.target.value === "opencode" ? "danger-full-access" : edited.permission});
            }}>
              <option value="codex">Codex CLI</option>
              <option value="opencode">OpenCode</option>
            </select>
            <p className="hint">Each harness keeps its own resumable sessions. Switching back resumes that harness’s conversation.</p>
            <Label htmlFor="profile-model">Model</Label>
            <select
              id="profile-model"
              value={edited.model}
              disabled={!models}
              onChange={(e) =>
                setEdited({ ...edited, model: e.target.value, reasoning: "" })
              }
            >
              <option value="">
                {models
                  ? `Use ${edited.harness === "opencode" ? "OpenCode setting" : "Codex setting"} (${models.model})`
                  : "Loading models…"}
              </option>
              {edited.model &&
                !models?.models.some((m) => m.slug === edited.model) && (
                  <option value={edited.model} disabled>
                    {edited.model} (unavailable)
                  </option>
                )}
              {models?.models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.display_name}{edited.harness === "opencode" ? ` · ${m.slug.split("/")[0]}` : ""}
                </option>
              ))}
            </select>
            {Boolean(selectedModel?.supported_reasoning_levels.length) && <><Label htmlFor="profile-reasoning">{edited.harness === "opencode" ? "Model variant" : "Reasoning effort"}</Label>
            <select
              id="profile-reasoning"
              value={edited.reasoning}
              disabled={!selectedModel}
              onChange={(e) =>
                setEdited({ ...edited, reasoning: e.target.value })
              }
            >
              <option value="">
                {inheritedReasoning
                  ? `Use default (${inheritedReasoning})`
                  : "Use model default"}
              </option>
              {edited.reasoning &&
                !selectedModel?.supported_reasoning_levels.some(
                  (r) => r.effort === edited.reasoning,
                ) && (
                  <option value={edited.reasoning} disabled>
                    {edited.reasoning} (unavailable)
                  </option>
                )}
              {selectedModel?.supported_reasoning_levels.map((r) => (
                <option key={r.effort} value={r.effort} title={r.description}>
                  {r.effort.charAt(0).toUpperCase() + r.effort.slice(1)}
                </option>
              ))}
            </select>
            </>}
            <div className="model-source">
              <span>{edited.harness === "opencode" ? "From your OpenCode CLI · refresh after adding providers or models" : "From your Codex settings"}</span>
              <button
                type="button"
                onClick={() => void loadModels()}
                aria-label="Refresh models"
              >
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
            {modelError && (
              <p className="error" role="alert">
                {modelError}
              </p>
            )}
            <Label htmlFor="profile-timeout">Run timeout (seconds)</Label>
            <Input
              id="profile-timeout"
              type="number"
              min={10}
              max={14400}
              value={edited.timeout_seconds}
              onChange={(e) =>
                setEdited({
                  ...edited,
                  timeout_seconds: Number(e.target.value),
                })
              }
            />
            <Label htmlFor="profile-color">Avatar color</Label>
            <input
              id="profile-color"
              type="color"
              value={edited.color}
              onChange={(e) => setEdited({ ...edited, color: e.target.value })}
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={edited.enabled}
                onChange={(e) =>
                  setEdited({ ...edited, enabled: e.target.checked })
                }
              />{" "}
              Agent enabled
            </label>
            <Button
              variant="outline"
              onClick={() =>
                void perform(async () => {
                  const p = await post<{ message: string }>(
                    `/agents/${agent.id}/probe`,
                  );
                  setProbe(p.message);
                })
              }
            >
              <ShieldCheck size={15} /> Check {agent.harness === "opencode" ? "OpenCode" : "Codex"} connection
            </Button>
            {probe && <p className="probe-result">{probe}</p>}
          </div>
        )}
        {section === "Workdir" && (
          <div className="form-stack">
            <div className="workdir-icon">
              <FolderOpen size={26} />
            </div>
            <h3>Work in your existing codebase</h3>
            <p className="muted">
              Attach a local or remote folder. Your agent will run directly in
              that directory. Agent runs and terminal commands automatically load
              this folder’s .env file when they start. Edit the file in your
              codebase; changes apply to the next execution.
            </p>
            <RuntimeSelect value={runtimeId} onChange={id=>{setRuntimeId(id);setSshHost("");setPath("");setProbe("");}}/>
            {controllerAccess && !runtimeId && <WorkstationSelect id="workstation-host" value={sshHost} workstations={workstations} onChange={host => { setSshHost(host); setPath(""); setProbe(""); }}/> }
            <Label htmlFor="workdir-path">Absolute directory path</Label>
            <Button variant="outline" disabled={!controllerAccess || !!runtimeId || (remote && !sshHost.trim())} onClick={() => setFolderPicker(true)}>
              <FolderOpen size={16} />
              Browse folders
            </Button>
            <Input
              id="workdir-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={remote ? "/home/you/project" : "F:\\Engineering\\my-project"}
            />
            <Button
              variant="outline"
              onClick={() =>
                void perform(async () => {
                  const result = await post<{
                    workspace: Workspace;
                    git_status: string;
                  }>("/workspaces/probe", { path, runtime_id: runtimeId || null, ssh_host: remote ? sshHost.trim() : null });
                  setEdited({ ...edited, workdir: result.workspace });
                  setProbe(result.git_status);
                })
              }
            >
              <FolderOpen size={15} /> Validate workdir
            </Button>
            {probe && <pre className="probe-result">{probe}</pre>}
            <Label htmlFor="workdir-access">Access mode</Label>
            <select
              id="workdir-access"
              value={edited.permission}
              onChange={(e) =>
                setEdited({ ...edited, permission: e.target.value })
              }
            >
              <option value="read-only">
                Read only — inspect the codebase
              </option>
              <option value="workspace-write">
                Workspace write — make requested changes
              </option>
              <option value="danger-full-access">
                YOLO — full access, no approvals
              </option>
            </select>
            {edited.harness === "opencode" && edited.permission !== "danger-full-access" && <p className="hint">OpenCode tool permissions: shell commands are disabled in restricted modes. Workspace write allows file edits inside the workdir. These controls are not an operating-system sandbox. Some free providers reject restricted runs; the selected permissions stay in effect when a run fails.</p>}
            {edited.permission === "danger-full-access" && (
              <p className="hint">
                Commands run with your account’s access, without {edited.harness === "codex" ? "the Codex sandbox or " : ""}approval prompts.
              </p>
            )}
            <Button
              onClick={() =>
                void perform(async () => {
                  const result = await post<{ workspace: Workspace }>(
                    "/workspaces/probe",
                    { path, runtime_id: runtimeId || null, ssh_host: remote ? sshHost.trim() : null },
                  );
                  const changedHost = (result.workspace.ssh_host ?? null) !== (agent.workdir?.ssh_host ?? null) || result.workspace.runtime_id !== agent.workdir?.runtime_id;
                  await save({ ...edited, workdir: result.workspace, ...(changedHost ? {model:"", reasoning:""} : {}) });
                })
              }
            >
              {agent.workdir ? "Change workdir" : "Attach workdir"}
            </Button>
            {agent.workdir && (
              <>
                <div className="attached-path">
                  <Check size={14} />
                  <span>{agent.workdir.path}</span>
                </div>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void perform(() => save({ ...edited, workdir: null }))
                  }
                >
                  Detach workdir
                </Button>
              </>
            )}
            <p className="hint">
              Attaching does not copy or change files. Detaching never deletes
              your codebase. Remote native sessions stay on that workstation; chat and execution records stay under org.
            </p>
          </div>
        )}
        {section === "Instructions" && (
          <div className="form-stack">
            <Label htmlFor="markdown-editor">Role and task instructions</Label>
            <Textarea
              id="markdown-editor"
              className="code-editor"
              value={edited.instructions}
              onChange={(e) =>
                setEdited({
                  ...edited,
                  instructions: e.target.value,
                })
              }
            />
            <details>
              <summary>Markdown preview</summary>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {edited.instructions}
                </ReactMarkdown>
              </div>
            </details>
            <p className="hint">
              Applied to the next run. Existing repository AGENTS.md files
              remain unchanged.
            </p>
          </div>
        )}
        {section === "Code" && (
          <div className="form-stack">
            <label className="check-row">
              <input
                type="checkbox"
                checked={scriptScope}
                onChange={(e) => setScriptScope(e.target.checked)}
              />{" "}
              Agent-owned scripts
            </label>
            <p className="hint">{fileView?.base}</p>
            {filePath && (
              <button
                className="file-back"
                onClick={() =>
                  void perform(() =>
                    loadFile(
                      filePath.split("/").slice(0, -1).join("/"),
                      scriptScope,
                    ),
                  )
                }
              >
                <ArrowLeft size={14} /> Parent folder
              </button>
            )}
            {fileView?.entries?.map((entry) => (
              <button
                className="file-entry"
                key={entry.name}
                onClick={() =>
                  void perform(() =>
                    loadFile(
                      [filePath, entry.name].filter(Boolean).join("/"),
                      scriptScope,
                    ),
                  )
                }
              >
                {entry.directory ? (
                  <FolderOpen size={15} />
                ) : (
                  <FileText size={15} />
                )}
                {entry.name}
              </button>
            ))}
            {fileView?.text !== undefined && (
              <>
                <p>{filePath}</p>
                <pre className="file-preview">{fileView.text}</pre>
              </>
            )}
            {scriptScope && (
              <>
                <Label htmlFor="script-name">Script filename</Label>
                <Input
                  id="script-name"
                  value={scriptName}
                  onChange={(e) => setScriptName(e.target.value)}
                  placeholder="verify.ps1"
                />
                <Textarea
                  aria-label="Script content"
                  className="code-editor"
                  value={scriptContent}
                  onChange={(e) => setScriptContent(e.target.value)}
                />
                <Button
                  onClick={() =>
                    void perform(async () => {
                      await put(`/agents/${agent.id}/files`, {
                        name: scriptName,
                        content: scriptContent,
                      });
                      await loadFile("", true);
                    })
                  }
                >
                  Save script
                </Button>
                <p className="hint">Saving does not execute the script.</p>
              </>
            )}
          </div>
        )}
        {section === "Terminal" && (
          <AgentTerminal
            key={agent.id}
            agent={effectiveAgent}
            onWorkdir={() => onSectionChange("Workdir")}
            onSkills={() => onSectionChange("Skills")}
          />
        )}
        {section === "Skills" && (
          <AgentSkills
            key={agent.id}
            agent={effectiveAgent}
            onWorkdir={() => onSectionChange("Workdir")}
            onTerminal={() => onSectionChange("Terminal")}
          />
        )}
        {section === "Sessions" && (
          <div className="session-list">
            <p className="hint">Each group and side chat has its own session for this agent. Each harness starts only when assigned work and exits when that execution finishes.</p>
            {sessionList.map((s) => (
              <div key={s.id}>
                <Badge variant="outline">
                  {s.active ? "Current" : "Reset"}
                </Badge>
                {" "}<strong>{groups.find((g) => g.id === s.group_id)?.name ?? s.group_id} · {s.side_chat_id ? `Side chat ${s.side_chat_id.slice(0, 8)}` : "Main chat"}</strong>
                <p>{s.harness === "opencode" ? "OpenCode · " : "Codex · "}{!s.active ? "Retired" : runs.some((r) => r.session_id === s.id && ["running", "starting"].includes(r.status)) ? "Working" : runs.some((r) => r.session_id === s.id && r.status === "queued") ? "Queued" : "Idle · resumes when triggered"}</p>
                <code>{s.native_id ?? "Not started yet"}</code>
                <p>{s.workspace}</p>
                {s.active && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void perform(async () => {
                        await post(`/sessions/${s.id}/reset`);
                        setSessionList(
                          (await api<Session[]>("/sessions")).filter(
                            (s) => s.agent_id === agent.id,
                          ),
                        );
                      })
                    }
                  >
                    <RefreshCw size={13} /> Start fresh next time
                  </Button>
                )}
              </div>
            ))}
            {!sessionList.length && (
              <p className="muted">
                A session is created when you send this agent a message.
              </p>
            )}
          </div>
        )}
        {section === "History" && (
          <div className="session-list">
            {revisionList.map((r) => (
              <div key={r.revision}>
                <strong>Revision {r.revision}</strong>
                <p>
                  {r.name} · {r.workdir?.path ?? "No workdir"}
                </p>
                <details>
                  <summary>Inspect instructions</summary>
                  <pre>
                    {r.instructions}\n{r.agents_md}
                  </pre>
                </details>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void perform(() => save({ ...r, revision: agent.revision }))
                  }
                >
                  Restore this revision
                </Button>
              </div>
            ))}
          </div>
        )}
        {["Profile", "Instructions"].includes(section) && (
          <Button
            className="save-profile"
            onClick={() => void perform(() => save())}
          >
            <Check size={15} />
            {saved ? "Saved" : "Save changes"}
          </Button>
        )}
        {section === "Profile" && (
          <Button
            variant="destructive"
            className="delete-agent"
            onClick={() => setConfirmDelete(true)}
          >
            Delete agent
          </Button>
        )}
      </div>
      {folderPicker && (
        <FolderPicker
          initialPath={path}
          sshHost={remote ? sshHost.trim() : undefined}
          onSelect={(selected) => {
            setPath(selected);
            setProbe("");
            setFolderPicker(false);
          }}
          onClose={() => setFolderPicker(false)}
        />
      )}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {agent.name}?</DialogTitle>
            <DialogDescription>
              The agent will leave the organization chart. Its history and files
              stay available for restoration. Its direct reports move to its
              manager. Stop active work before deleting.
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            onClick={() =>
              void (async () => {
                try {
                  await api(`/agents/${agent.id}`, { method: "DELETE" });
                  await onSaved();
                  onClose();
                } catch (error) {
                  setDeleteError(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              })()
            }
          >
            Delete {agent.name}
          </Button>
          {deleteError && (
            <p role="alert" className="error">
              {deleteError}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
