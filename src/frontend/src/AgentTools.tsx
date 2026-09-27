import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FileText,
  Play,
  RefreshCw,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, post, requestId } from "./api";
import type { Agent } from "./bindings/Agent";
import type { TerminalRun } from "./bindings/TerminalRun";
import type { SkillList } from "./bindings/SkillList";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function AttachWorkdir({ onWorkdir }: { onWorkdir: () => void }) {
  return (
    <div className="form-stack">
      <p className="muted">
        Attach a codebase to use this agent’s terminal and skills.
      </p>
      <Button variant="outline" onClick={onWorkdir}>
        Attach a workdir
      </Button>
    </div>
  );
}

export function AgentTerminal({
  agent,
  onWorkdir,
  onSkills,
}: {
  agent: Agent;
  onWorkdir: () => void;
  onSkills: () => void;
}) {
  const [runs, setRuns] = useState<TerminalRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TerminalRun | null>(null);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [reload, setReload] = useState(0);
  const output = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const active =
    runs.find((r) => r.status === "running") ??
    (detail?.status === "running" ? detail : null);
  const root = `/agents/${agent.id}/terminal`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const history = await api<TerminalRun[]>(root, {
          signal: controller.signal,
        });
        const target = selected ?? history[0]?.id;
        const run = target
          ? await api<TerminalRun>(`${root}/${target}`, {
              signal: controller.signal,
            })
          : null;
        if (controller.signal.aborted) return;
        setRuns(history);
        setDetail(run);
        setLoadError("");
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(message(error));
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void refresh(), 1000);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [root, selected, reload]);
  useEffect(() => {
    if (output.current && followOutput.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [detail?.output]);

  async function run() {
    if (sending || active || !command.trim()) return;
    setSending(true);
    setError("");
    try {
      const result = await post<TerminalRun>(root, {
        id: requestId(),
        command,
      });
      setDetail(result);
      setSelected(result.id);
      setCommand("");
      followOutput.current = true;
      setReload((n) => n + 1);
    } catch (error) {
      setError(`${message(error)}. Check command history before retrying.`);
    } finally {
      setSending(false);
    }
  }
  if (!agent.workdir) return <AttachWorkdir onWorkdir={onWorkdir} />;
  return (
    <div className="agent-tools form-stack">
      <div className="tools-heading">
        <h3>
          <Terminal size={17} /> Terminal
        </h3>
        <Button variant="ghost" size="sm" onClick={onSkills}>
          <Wrench size={14} /> Skills
        </Button>
      </div>
      <code className="tools-workdir">{agent.workdir.path}</code>
      <p className="hint">
        Commands run as {agent.workdir.ssh_host ? `your SSH account on ${agent.workdir.ssh_host}` : "you"}, with this workdir’s .env. Each command
        starts in this folder.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="form-stack"
      >
        <label htmlFor="terminal-command">{agent.workdir.ssh_host ? "Shell command" : "PowerShell command"}</label>
        <Textarea
          id="terminal-command"
          className="terminal-command"
          value={command}
          maxLength={16384}
          spellCheck={false}
          placeholder={agent.workdir.ssh_host ? "pwd; ls -la" : "Get-ChildItem -Force"}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        <div className="tools-actions">
          <Button
            type="submit"
            size="sm"
            disabled={sending || !!active || !command.trim()}
          >
            <Play size={14} /> {sending ? "Starting…" : "Run command"}
          </Button>
          {active && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError("");
                void post(`${root}/${active.id}/stop`).then(
                  () => setReload((n) => n + 1),
                  (error: unknown) => setError(message(error)),
                );
              }}
            >
              <Square size={13} /> Stop command
            </Button>
          )}
          <span className="hint">Ctrl + Enter</span>
        </div>
      </form>
      <div className="tools-shortcuts">
        <button
          onClick={() => setCommand("Get-Location; Get-ChildItem -Force")}
        >
          List files
        </button>
        <button onClick={() => setCommand("git status --short --branch")}>
          Git status
        </button>
      </div>
      <p className="hint">
        Use unattended installer flags such as <code>--yes</code>. Interactive
        programs need an external terminal.
      </p>
      {(error || loadError) && (
        <p role="alert" className="tools-error">
          {error || loadError}
        </p>
      )}
      <div className="terminal-output-panel">
        <div className="terminal-output-heading">
          <span>{detail ? detail.status.replaceAll("_", " ") : "Output"}</span>
          {detail?.exit_code !== null && detail?.exit_code !== undefined && (
            <span>Exit {detail.exit_code}</span>
          )}
        </div>
        <pre
          ref={output}
          className="terminal-output"
          aria-label="Command output"
          tabIndex={0}
          onScroll={() => {
            const el = output.current;
            if (el)
              followOutput.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          }}
        >
          {detail
            ? `PS ${detail.cwd}> ${detail.command}\n\n${detail.output}${detail.error ? `\n${detail.error}` : ""}`
            : "Run a command to see its output here."}
        </pre>
      </div>
      {detail && (
        <div className="tools-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCommand(detail.command)}
          >
            Reuse command
          </Button>
          <span className="hint">
            {new Date(detail.created_at).toLocaleString()}
          </span>
        </div>
      )}
      {!!runs.length && (
        <>
          <h3>Recent commands</h3>
          <div className="terminal-history" aria-label="Command history">
            {runs.map((run) => (
              <button
                key={run.id}
                aria-pressed={detail?.id === run.id}
                onClick={() => {
                  setSelected(run.id);
                  setDetail(null);
                  followOutput.current = true;
                }}
              >
                <code>{run.command}</code>
                <span>
                  {run.status.replaceAll("_", " ")}
                  {run.exit_code !== null ? ` · ${run.exit_code}` : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AgentSkills({
  agent,
  onWorkdir,
  onTerminal,
}: {
  agent: Agent;
  onWorkdir: () => void;
  onTerminal: () => void;
}) {
  const [catalog, setCatalog] = useState<SkillList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const workdirPath = agent.workdir?.path;
  useEffect(() => {
    if (!workdirPath) return;
    const controller = new AbortController();
    void api<SkillList>(
      `/agents/${agent.id}/skills${selected ? `?path=${encodeURIComponent(selected)}` : ""}`,
      { signal: controller.signal },
    ).then(
      (value) => {
        setCatalog(value);
        setLoading(false);
        setError("");
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setError(message(error));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [agent.id, workdirPath, selected, reload]);
  function select(path: string | null) {
    setSelected(path);
    setLoading(true);
    setError("");
  }
  if (!agent.workdir) return <AttachWorkdir onWorkdir={onWorkdir} />;
  const skills =
    catalog?.skills.filter((s) =>
      `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <div className="agent-tools form-stack">
      <div className="tools-heading">
        <h3>
          <Wrench size={17} /> Workdir skills
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setReload((n) => n + 1);
          }}
        >
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      <code className="tools-workdir">{agent.workdir.path}</code>
      <p className="hint">
        Project skills discovered by the agent’s harness, including inherited skills from this
        repository.
      </p>
      <Button variant="outline" size="sm" onClick={onTerminal}>
        <Terminal size={14} /> Install with CLI
      </Button>
      <p className="hint">
        Install into <code>.agents/skills</code> from Terminal, then refresh
        this list.
      </p>
      {error && (
        <p role="alert" className="tools-error">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="hint">
          Reading installed skills…
        </p>
      )}
      {selected ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => select(null)}>
            <ArrowLeft size={14} /> All skills
          </Button>
          <code className="tools-workdir">{selected}</code>
          {!loading && !error && (
            <pre className="skill-instructions" aria-label="Skill instructions">
              {catalog?.text}
            </pre>
          )}
        </>
      ) : (
        <>
          <Input
            aria-label="Filter skills"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter skills…"
          />
          {!loading && !error && (
            <p className="hint">
              {skills.length} {skills.length === 1 ? "skill" : "skills"}
            </p>
          )}
          <div className="skill-list">
            {skills.map((skill) => (
              <button key={skill.path} onClick={() => select(skill.path)}>
                <FileText size={17} />
                <span>
                  <strong>{skill.name}</strong>
                  <p>{skill.description}</p>
                  <code>{skill.path}</code>
                  {!skill.enabled && <small>Disabled in harness settings</small>}
                </span>
              </button>
            ))}
          </div>
          {!loading && !error && !skills.length && (
            <p className="muted">
              {filter
                ? "No skills match this filter."
                : "No project skills installed yet."}
            </p>
          )}
          {catalog?.errors.map((error) => (
            <p className="tools-error" role="alert" key={error.path}>
              <strong>{error.path}</strong>
              <br />
              {error.message}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
