import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  useStore,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeProps,
  type NodeChange,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import {
  FolderOpen,
  GripVertical,
  Network,
  Plus,
  Settings2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "./Avatar";
import { WorkstationStatus } from "./WorkstationStatus";
import type { Workstation } from "./bindings/Workstation";
import type { Connection } from "./bindings/Connection";
import type { Agent } from "./bindings/Agent";
import type { ChartCard } from "./bindings/ChartCard";
import type { RegisteredRuntime } from "./runtimeCatalog";
import { api, put } from "./api";
import "@xyflow/react/dist/style.css";
import "./OrganizationChart.css";

type PersonNode = Node<
  {
    agent?: Agent;
    connection?: Connection;
    hostName?: string;
    runtimeName?: string;
    reports: number;
    onSelect?: (id: string) => void;
  },
  "person"
>;
const WIDTH = 248;
const HEIGHT = 176;
const cardHeight = (agent?: Agent) => agent?.workdir?.ssh_host ? HEIGHT + 28 : HEIGHT;
const fitOptions = { padding: 0.18, maxZoom: 1, minZoom: 0.2 };
const agentNodeId = (id: string) => `agent:${id}`;
type ChartLayout = Partial<Record<string, ChartCard>>;

function cardGeometry(nodes: PersonNode[]): ChartLayout {
  return Object.fromEntries(
    nodes.map((node) => [
      node.id,
      {
        x: node.position.x,
        y: node.position.y,
        width: node.width ?? WIDTH,
        height: node.height ?? HEIGHT,
      },
    ]),
  );
}

function PersonCard({ id, data, selected }: NodeProps<PersonNode>) {
  const { agent, reports, onSelect } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  useLayoutEffect(() => {
    // Adding/removing a reporting handle does not resize the card itself.
    updateNodeInternals(id);
  }, [id, reports, updateNodeInternals]);
  const owner = !agent;
  const name = agent?.name ?? "Workspace owner";
  const workdir = agent?.workdir?.path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/");
  const content = (
    <>
      <div className="org-card-heading">
        <span className="org-card-kind">
          <GripVertical size={13} aria-hidden="true" />
          {owner ? "Organization owner" : agent.project_id ? "Project agent" : "Organization agent"}
        </span>
        {agent && <span className="org-card-runtime" title={`Runtime: ${data.runtimeName}`} aria-label={`Runtime: ${data.runtimeName}`}>{data.runtimeName}</span>}
        {agent && (
          <button
            type="button"
            className="org-card-edit nodrag nopan"
            aria-label={`Configure ${name}`}
            title={`Edit ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.(agent.id);
            }}
          >
            <Settings2 size={13} />
          </button>
        )}
      </div>
      <div className="org-card-person">
        <Avatar agent={agent} owner={owner} />
        <div className="org-card-identity">
          <strong title={name}>{name}</strong>
          <span>
            {owner ? "Workspace organization" : agent.position || "Position not set"}
            {agent && !agent.enabled ? " · Paused" : ""}
          </span>
        </div>
        {agent && (
          <img
            className="org-card-harness"
            src={`/harnesses/${agent.harness}.svg`}
            alt={agent.harness === "opencode" ? "OpenCode" : "Codex"}
            title={agent.harness === "opencode" ? "OpenCode" : "Codex"}
            width={22}
            height={22}
            draggable={false}
          />
        )}
      </div>
      <p className="org-card-role" title={agent?.role || undefined}>
        {owner
          ? "Direction, priorities, and decisions."
          : agent.role || "Add a role to this agent"}
      </p>
      <div className="org-card-footer">
        <span title={agent?.workdir?.path}>
          {owner ? <Users size={13} /> : <FolderOpen size={13} />}
          <span className="org-card-path">
            {owner
              ? `${reports} direct ${reports === 1 ? "report" : "reports"}`
              : workdir || "No codebase"}
          </span>
        </span>
        {agent && (
          <span title={`${reports} direct reports`}>
            <Users size={13} />
            {reports}
          </span>
        )}
      </div>
      {agent?.workdir?.ssh_host && <WorkstationStatus host={data.hostName ?? agent.workdir.ssh_host} connection={data.connection} />}
    </>
  );
  return (
    <>
      <NodeResizer
        minWidth={WIDTH}
        minHeight={cardHeight(agent)}
        maxWidth={1200}
        maxHeight={1000}
        color="var(--primary)"
        handleClassName="org-resize-handle"
        lineClassName="org-resize-line"
      />
      {!owner && (
        <Handle type="target" position={Position.Top} isConnectable={false} />
      )}
      <div
        className={`org-card ${owner ? "org-card-owner" : ""} ${selected ? "is-selected" : ""} ${agent && !agent.enabled ? "is-paused" : ""}`}
        data-agent-id={agent?.id}
        data-selected={selected}
        aria-label={owner ? "Workspace owner" : undefined}
      >
        {content}
      </div>
      {reports > 0 && (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={false}
        />
      )}
    </>
  );
}
const nodeTypes = { person: PersonCard };

// Adapted from React Flow's MIT Dagre example. Dagre owns layout, React Flow
// owns the viewport and connectors; saved reporting relationships remain the source.
function chartLayout(agents: Agent[], dimensions: ChartLayout = {}) {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "TB",
    nodesep: 36,
    ranksep: 76,
    marginx: 12,
    marginy: 12,
  });
  const reports = new Map<string, number>();
  for (const agent of agents) {
    const manager = agent.reports_to ? agentNodeId(agent.reports_to) : "owner";
    reports.set(manager, (reports.get(manager) ?? 0) + 1);
  }
  const nodes: PersonNode[] = [
    {
      id: "owner",
      type: "person",
      position: { x: 0, y: 0 },
      data: { reports: reports.get("owner") ?? 0 },
      width: WIDTH,
      height: HEIGHT,
    },
    ...agents.map((agent): PersonNode => ({
      id: agentNodeId(agent.id),
      type: "person",
      position: { x: 0, y: 0 },
      data: { agent, reports: reports.get(agentNodeId(agent.id)) ?? 0 },
      width: WIDTH,
      height: cardHeight(agent),
    })),
  ];
  const edges: Edge[] = agents.map((agent) => ({
    id: `reports:${agent.id}`,
    source: agent.reports_to ? agentNodeId(agent.reports_to) : "owner",
    target: agentNodeId(agent.id),
    type: "smoothstep",
    selectable: false,
    focusable: false,
    ariaLabel: `${agent.name} reports to ${agents.find((a) => a.id === agent.reports_to)?.name ?? "Workspace owner"}`,
    pathOptions: { borderRadius: 12 },
  }));
  for (const node of nodes) {
    node.width = dimensions[node.id]?.width ?? WIDTH;
    node.height = Math.max(dimensions[node.id]?.height ?? HEIGHT, cardHeight(node.data.agent));
    graph.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  for (const node of nodes) {
    const point = graph.node(node.id);
    node.position = {
      x: point.x - node.width! / 2,
      y: point.y - node.height! / 2,
    };
  }
  return { nodes, edges };
}

function FitChart({ structure }: { structure: string }) {
  const { fitView, viewportInitialized } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (!viewportInitialized || !width || !height) return;
    // Fit on structural/container changes, never during a drag or resize.
    const frame = requestAnimationFrame(() => {
      void fitView({ ...fitOptions, duration: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, viewportInitialized, structure, width, height]);
  return null;
}

export function OrganizationChart({
  agents,
  savedLayout,
  connections,
  onDeletedAgents,
  selected,
  onSelect,
  onAdd,
  projectName,
  workstations,
  layoutPath = "/organization/layout",
}: {
  projectName?: string;
  workstations: Workstation[];
  layoutPath?: string;
  agents: Agent[];
  savedLayout: ChartLayout;
  connections: Partial<Record<string, Connection>>;
  onDeletedAgents: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const layout = useMemo(() => chartLayout(agents), [agents]);
  const [nodes, setNodes] = useState<PersonNode[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<RegisteredRuntime[] | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<RegisteredRuntime[]>("/runtimes").then(value => {
      if (!cancelled) setRuntimes(value);
    }, (error: unknown) => {
      if (!cancelled) setRuntimeError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, []);
  const [arranged, setArranged] = useState(0);
  const saveQueue = useRef(Promise.resolve());
  function save(snapshot: ChartLayout) {
    // Serialize completed gestures so a slower earlier request cannot overwrite a later one.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await put(layoutPath, snapshot);
        setSaveError(null);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
      }
    });
  }
  const renderedNodes = layout.nodes.map((node) => {
    const card = savedLayout[node.id];
    const workdir = node.data.agent?.workdir;
    const hostName = workstations.find(host => host.id === workdir?.ssh_host)?.name;
    const runtimeId = workdir?.runtime_id ?? node.data.agent?.runtime_id;
    const runtimeName = runtimeId
      ? runtimes?.find(runtime => runtime.id === runtimeId)?.name ?? (runtimeError || runtimes ? "Runtime unavailable" : "Loading…")
      : !workdir ? "Not assigned" : workdir.ssh_host ? hostName ?? workdir.ssh_host : "Local";
    return {
      ...node,
      ...(card
        ? {
            position: { x: card.x, y: card.y },
            width: card.width,
            height: Math.max(card.height, cardHeight(node.data.agent)),
          }
        : {}),
      ...nodes.find((existing) => existing.id === node.id),
      selected: node.data.agent?.id === selected,
      data: { ...node.data, onSelect, hostName, runtimeName, connection: node.data.agent ? connections[node.data.agent.id] : undefined },
    };
  });
  const nodesRef = useRef<PersonNode[]>(renderedNodes);
  useLayoutEffect(() => {
    nodesRef.current = renderedNodes;
  }, [renderedNodes]);
  function onNodesChange(changes: NodeChange<PersonNode>[]) {
    if (
      !changes.some(
        (change) => change.type === "position" || change.type === "dimensions",
      )
    )
      return;
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    const snapshot = cardGeometry(next);
    setNodes(next);
    if (
      changes.some(
        (change) =>
          (change.type === "position" && change.dragging === false) ||
          (change.type === "dimensions" && change.resizing === false),
      )
    )
      save(snapshot);
  }
  const structure = agents
    .map((a) => `${a.id}:${a.reports_to ?? "owner"}`)
    .join("|");
  return (
    <section className="organization-view" aria-label="Organization">
      {runtimeError && agents.some(agent => agent.runtime_id || agent.workdir?.runtime_id) && <p className="org-layout-error" role="alert">Could not load runtime names: {runtimeError}</p>}
      <header className="organization-header">
        <div>
          <h1>{projectName ? `${projectName} · Structure` : "Organization"}</h1>
          <p>Your agents, roles, and reporting lines.</p>
        </div>
        <div className="organization-actions">
          <Button variant="outline" onClick={onDeletedAgents}>
            {projectName ? "Manage team" : "Deleted agents"}
          </Button>
          <Button onClick={onAdd}>
            <Plus size={16} /> Add agent
          </Button>
        </div>
      </header>
      <div className="org-canvas-frame">
        <div className="org-chart-toolbar">
          <button
            type="button"
            className="org-arrange"
            onClick={() => {
              const next = chartLayout(
                agents,
                cardGeometry(renderedNodes),
              ).nodes.map((node) => ({
                ...renderedNodes.find((existing) => existing.id === node.id),
                ...node,
              }));
              const snapshot = cardGeometry(next);
              setNodes(next);
              save(snapshot);
              setArranged((value) => value + 1);
            }}
          >
            Auto arrange
          </button>
          <span>
            <Network size={16} /> Reporting structure
          </span>
          <span>
            {agents.length} {agents.length === 1 ? "agent" : "agents"}
            <i />
            {agents.filter((a) => a.workdir).length} with a codebase
          </span>
        </div>
        <div className="org-chart-canvas" aria-label="Organization chart">
          <ReactFlowProvider>
            <ReactFlow<PersonNode>
              nodes={renderedNodes}
              edges={layout.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={(_, node) => {
                if (node.data.agent) onSelect(node.data.agent.id);
              }}
              fitView
              fitViewOptions={fitOptions}
              minZoom={0.2}
              maxZoom={1.6}
              nodesDraggable
              nodeDragThreshold={6}
              nodeClickDistance={6}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable
              deleteKeyCode={null}
              panOnScroll
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--grid-line)" gap={22} size={1} />
              <Controls
                position="bottom-right"
                orientation="horizontal"
                showInteractive={false}
                fitViewOptions={fitOptions}
                aria-label="Chart controls"
              />
              <FitChart structure={`${structure}:${arranged}`} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        <div className="org-chart-hint">
          <span>
            Drag cards to move · Drag corners to resize · Click to edit
          </span>
          <span>Layout saves automatically</span>
        </div>
        {saveError && (
          <div className="org-layout-error" role="alert">
            Layout could not be saved: {saveError}
            <button onClick={() => save(cardGeometry(nodesRef.current))}>
              Retry
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
