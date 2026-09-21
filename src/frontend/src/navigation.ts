import { useSyncExternalStore } from "react";

export const sections = [
  "Profile",
  "Workdir",
  "Terminal",
  "Skills",
  "Instructions",
  "Code",
  "Sessions",
  "History",
] as const;
export type Section = (typeof sections)[number];
export type View =
  "Chat" | "Knowledge" | "Runs" | "Scheduled tasks" | "Organization" | "Actions" | "Structure" | "Action board" | "User settings" | "Profile" | "Workspace settings";
export type Route = {
  groupId: string;
  view: View;
  agentId: string | null;
  section: Section;
  runId: string | null;
  sideChatId: string | null;
  valid: boolean;
};
type Named = { id: string; name: string; project?: unknown };

// Stable IDs disambiguate duplicate names and keep bookmarks working after a rename.
export function slug(entity: Named): string {
  if (["general", "ceo"].includes(entity.id)) return entity.id;
  const name =
    entity.name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "untitled";
  return `${name}--${entity.id}`;
}
const idFromSlug = (value: string) => value.split("--").at(-1) ?? "";
export function parseRoute(url: string): Route {
  const route: Route = {
    groupId: "general",
    view: "Chat",
    agentId: null,
    section: "Profile",
    runId: null,
    sideChatId: null,
    valid: true,
  };
  const location = new URL(url, "http://localhost");
  let parts: string[];
  try {
    parts = location.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    return { ...route, valid: false };
  }
  route.runId = location.searchParams.get("run");
  route.sideChatId = location.searchParams.get("side");
  if (route.sideChatId && !/^[a-zA-Z0-9-]{1,64}$/.test(route.sideChatId)) return { ...route, valid: false };
  if (!parts.length) return route;
  if (parts.join("/") === "settings/profile") return { ...route, view: "Profile" };
  if (parts.join("/") === "settings/workspace") return { ...route, view: "Workspace settings" };
  if (["settings/runtime", "settings/workstations"].includes(parts.join("/"))) return { ...route, view: "User settings" };
  if (parts[0] === "actions" && parts.length === 1) return { ...route, view: "Action board" };
  if (parts[0] === "organization") {
    route.view = "Organization";
    if (parts.length === 1) return route;
    const section = sections.find(
      (s) => s.toLowerCase() === (parts[3] ?? "profile"),
    );
    if (parts[1] !== "agents" || !parts[2] || !section || parts.length > 4)
      return { ...route, valid: false };
    return { ...route, agentId: idFromSlug(parts[2]), section };
  }
  const view = ["Chat", "Knowledge", "Runs", "Scheduled tasks", "Actions", "Structure"].find(
    (s) => s.toLowerCase().replaceAll(" ", "-") === (parts[2] ?? "chat"),
  ) as View | undefined;
  if (!["groups", "projects"].includes(parts[0]) || !parts[1] || !view || parts.length > 3)
    return { ...route, valid: false };
  if (view === "Structure") {
    route.agentId = location.searchParams.get("agent");
    route.section = sections.find(s => s.toLowerCase() === location.searchParams.get("section")) ?? "Profile";
  }
  return { ...route, groupId: idFromSlug(parts[1]), view };
}
export function routePath(route: Route, group?: Named, agent?: Named): string {
  let path =
    route.view === "Profile" ? "/settings/profile" : route.view === "Workspace settings" ? "/settings/workspace" : route.view === "User settings" ? "/settings/runtime" : route.view === "Action board" ? "/actions" : route.view === "Organization"
      ? "/organization"
      : `/${group?.project ? "projects" : "groups"}/${encodeURIComponent(group ? slug(group) : route.groupId)}/${route.view.toLowerCase().replaceAll(" ", "-")}`;
  if (route.view === "Organization" && route.agentId)
    path += `/agents/${encodeURIComponent(agent ? slug(agent) : route.agentId)}/${route.section.toLowerCase()}`;
  const query = new URLSearchParams();
  if (route.view === "Structure" && route.agentId) { query.set("agent", route.agentId); query.set("section", route.section.toLowerCase()); }
  if (route.runId) query.set("run", route.runId);
  if (route.view === "Chat" && route.sideChatId) query.set("side", route.sideChatId);
  if (query.size) path += `?${query}`;
  return path;
}
const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener("ae:navigate", notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener("ae:navigate", notify);
  };
};
export function navigate(path: string, replace = false) {
  if (path === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  window.dispatchEvent(new Event("ae:navigate"));
}
export function useRoute() {
  return parseRoute(
    useSyncExternalStore(subscribe, () => location.pathname + location.search),
  );
}
