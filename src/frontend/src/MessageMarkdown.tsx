import { useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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

export function MessageMarkdown({ children, runId, basePath, onPreview }: {
  children: string;
  runId: string | null;
  basePath?: string;
  onPreview: (file: MarkdownFile) => void;
}) {
  const components = useMemo<Components>(() => ({
      a: ({ href, children, title }) => {
        if (!href) return <span title="This link is unavailable or has no attached workdir">{children}</span>;
        const file = markdownFile(href);
        return <a href={href} title={title} target={file ? undefined : "_blank"} rel="noopener noreferrer"
          onClick={file ? (event) => { event.preventDefault(); onPreview(file); } : undefined}>{children}</a>;
      },
      img: ({ src, alt }) => <MessageImage key={src} src={src} alt={alt} />,
    }), [onPreview]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => fileUrl(url, runId, basePath)}
    components={components}>{children}</ReactMarkdown>;
}
