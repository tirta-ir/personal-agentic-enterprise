import { useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import type { Agent } from "./bindings/Agent";

export type MarkdownFile = { url: string; name: string; runId: string | null; path?: string };

function markdownFile(href: string): MarkdownFile | null {
  const match = /^\/api\/runs\/([^/]+)\/files\?/.exec(href);
  if (!match) return null;
  let path = new URL(href, location.origin).searchParams.get("path") ?? "";
  try {
    if (/^file:/i.test(path)) path = decodeURIComponent(new URL(path).pathname);
  } catch { return null; /* Malformed file URLs keep the API's explicit error response. */ }
  if (!/\.(md|markdown)$/i.test(path)) return null;
  return { url: href, name: path.replaceAll("\\", "/").split("/").pop()!, runId: decodeURIComponent(match[1]), path };
}

function fileUrl(url: string, runId: string | null, basePath?: string): string {
  const drivePath = /^\/?[a-z]:[/\\]/i.test(url);
  const fileScheme = /^file:/i.test(url);
  if (!drivePath && !fileScheme && (
    /^[a-z][a-z\d+.-]*:/i.test(url) ||
    /^(#|\/\/|\/(?:api|assets|groups|projects|actions|organization)(?:\/|$))/.test(url)
  )) return defaultUrlTransform(url);
  if (!url || !runId) return "";
  try {
    // Markdown escapes spaces; file: URLs are decoded by the native URL parser.
    let path = fileScheme ? url.split("#")[0] : decodeURIComponent(url.split("#")[0]);
    if (basePath && !drivePath && !fileScheme && !path.startsWith("/")) {
      // Native URL resolution handles sibling files and ../ links inside reports.
      const base = new URL("https://workdir.invalid");
      base.pathname = basePath.replaceAll("\\", "/");
      path = decodeURIComponent(new URL(path.split("/").map(encodeURIComponent).join("/"), base).pathname);
      if (!basePath.startsWith("/")) path = path.slice(1);
    }
    return `/api/runs/${encodeURIComponent(runId)}/files?${new URLSearchParams({ path })}`;
  } catch {
    return "";
  }
}

function MessageImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const label = alt || "Image";
  if (!src || failed) return <span className="message-image-unavailable">
    {label} — image unavailable{src && <> · <a href={src} target="_blank" rel="noopener noreferrer">Open file</a></>}
  </span>;
  const open = () => window.open(src, "_blank", "noopener,noreferrer");
  return <img className="message-image" src={src} alt={label} role="link" tabIndex={0}
    aria-label={`Open image: ${label}`} onError={() => setFailed(true)}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); open(); }}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); open(); } }} />;
}

// Transform text nodes only: code, existing links and file URLs remain untouched.
function agentMentions(agents: Agent[]) {
  const aliases = new Map<string, Agent>();
  // Active agents precede deleted history; a reused name must open the current profile.
  for (const agent of agents) for (const name of [agent.id, agent.name]) {
    const key = name.toLowerCase();
    if (!aliases.has(key)) aliases.set(key, agent);
  }
  const names = [...aliases.keys()].filter(Boolean).sort((a,b) => b.length-a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = names.length ? new RegExp(`(^|[\\s([{])@(${names.join("|")})(?=$|[\\s,.!?:;\\)\\]\\}])`, "giu") : null;
  return () => (tree: Root) => {
    function visit(node: Root | RootContent) {
      if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return;
      const children: RootContent[] = node.children;
      for (let i=0; i<children.length; i++) {
        const child = children[i];
        if (child.type !== "text" || !pattern) { visit(child); continue; }
        const replacement: RootContent[] = []; let end = 0;
        for (const match of child.value.matchAll(pattern)) {
          const agent = aliases.get(match[2].toLowerCase())!;
          const start = match.index + match[1].length;
          if (start > end) replacement.push({type:"text", value:child.value.slice(end,start)});
          replacement.push({type:"link", url:`/organization/agents/${encodeURIComponent(agent.id)}/profile`, children:[{type:"text",value:`@${agent.name}`}]});
          end = match.index + match[0].length;
        }
        if (!replacement.length) continue;
        if (end < child.value.length) replacement.push({type:"text",value:child.value.slice(end)});
        children.splice(i,1,...replacement); i += replacement.length-1;
      }
    }
    visit(tree);
  };
}
const noAgents: Agent[] = [];

export function MessageMarkdown({ children, runId, basePath, onPreview, agents = noAgents, onMention }: {
  children: string;
  agents?: Agent[];
  onMention?: (id: string) => void;
  runId: string | null;
  basePath?: string;
  onPreview: (file: MarkdownFile) => void;
}) {
  const mentions = useMemo(() => agentMentions(agents), [agents]);
  const components = useMemo<Components>(() => ({
      a: ({ href, children, title }) => {
        if (!href) return <span title="This link is unavailable or has no attached workdir">{children}</span>;
        const agent = agents.find(agent => href === `/organization/agents/${encodeURIComponent(agent.id)}/profile`);
        if (agent) return <a className="agent-mention" href={href} title={`View ${agent.name}`} onClick={onMention ? event => { event.preventDefault(); onMention(agent.id); } : undefined}>{children}</a>;
        const file = markdownFile(href);
        return <a href={href} title={title} target={file ? undefined : "_blank"} rel="noopener noreferrer"
          onClick={file ? (event) => { event.preventDefault(); onPreview(file); } : undefined}>{children}</a>;
      },
      img: ({ src, alt }) => <MessageImage key={src} src={src} alt={alt} />,
    }), [onPreview, agents, onMention]);
  return <ReactMarkdown remarkPlugins={[remarkGfm, mentions]} urlTransform={(url) => fileUrl(url, runId, basePath)}
    components={components}>{children}</ReactMarkdown>;
}
