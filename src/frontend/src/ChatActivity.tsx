import { useEffect, useState } from "react";
import { Circle, LoaderCircle } from "lucide-react";
import { api } from "./api";
import type { Run } from "./bindings/Run";
import type { CodexSettings } from "./bindings/CodexSettings";
import { isActiveRun } from "./runStatus";

export function ChatActivity({ runs, questions = [], onOpen }: { runs: Run[]; questions?: string[]; onOpen: (run: Run) => void }) {
  const pending = runs.filter(isActiveRun);
  const latest = runs[0];
  const taskRuns = latest ? runs.filter((run) => run.message_id === latest.message_id) : [];
  const failed = taskRuns.find((run) => !isActiveRun(run) && !["succeeded", "delegated"].includes(run.status));
  const target = pending.find(run => questions.includes(run.id)) ?? pending[0] ?? failed ?? latest;
  const queued = pending.length > 0 && pending.every((run) => run.status === "queued");
  const status = questions.length ? "needs-answer" : pending.length ? queued ? "queued" : "working" : failed ? "failed" : latest ? "done" : "idle";
  const label = status === "needs-answer" ? "Needs your answer" : status === "working" ? "Working" : status === "queued" ? "Queued" : status === "failed" ? "Needs attention" : status === "done" ? "Done" : "No recent activity";
  return <button className={`chat-activity ${status}`} disabled={!target} onClick={() => target && onOpen(target)}
    aria-label={`Chat activity: ${label}`} title={pending.length ? `${pending.length} active run${pending.length === 1 ? "" : "s"}. Click to view activity.` : failed?.error || label}>
    {pending.length && !questions.length ? <LoaderCircle size={15} className="activity-spinner" /> : <Circle size={9} fill="currentColor" />}
    <span role="status">{label}{pending.length > 1 ? ` · ${pending.length}` : ""}</span>
  </button>;
}

export function MessageModelBadge({ runId, run, catalog }: { runId: string; run?: Run; catalog: CodexSettings | null }) {
  const [loaded, setLoaded] = useState<Run | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (run) return;
    let cancelled = false;
    void api<Run>(`/runs/${runId}`).then((value) => { if (!cancelled) setLoaded(value); }, (reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [run, runId]);
  const source = run ?? loaded;
  if (!source) return <span className="model-badge muted" title={error || undefined}>{error ? "Model unavailable" : "Loading model…"}</span>;
  // Saved CLI arguments preserve inherited defaults and profile settings as actually executed.
  // Never resolve an old message using today's profile or today's Codex defaults.
  const modelIndex = source.arguments.indexOf("--model");
  const modelArg = (modelIndex >= 0 ? source.arguments[modelIndex + 1] : "") || source.profile.model;
  const [model, variant] = source.profile.harness === "opencode" ? modelArg.split("#") : [modelArg, undefined];
  const effort = variant || source.arguments.find((arg) => arg.startsWith("model_reasoning_effort="))?.split("=").slice(1).join("=").replaceAll('"', "") || source.profile.reasoning;
  const displayName = source.model_display_name || catalog?.models.find((option) => option.slug === model)?.display_name || model;
  return <span className="model-badge" title={`${source.profile.harness === "opencode" ? "OpenCode" : "Codex"} · Recorded for this reply: ${model || "model not recorded"} / ${effort || (source.profile.harness === "opencode" ? "model default" : "reasoning not recorded")}`}>
    {displayName || "Model not recorded"}<span aria-hidden="true"> / </span><span className="reasoning-name">{effort || (source.profile.harness === "opencode" ? "default" : "not recorded")}</span>
  </span>;
}
