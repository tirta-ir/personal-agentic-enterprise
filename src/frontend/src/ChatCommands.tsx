import { useRef, useState } from "react";
import { Gauge, RotateCcw, MessagesSquare } from "lucide-react";
import type { UsageReport } from "./bindings/UsageReport";
import type { UsageWindow } from "./bindings/UsageWindow";

const commands = [
  { name: "/btw", description: "Independent side chat with main-chat context", icon: MessagesSquare },
  {
    name: "/reset",
    description: "Fresh sessions in this side chat, or the whole group from main chat",
    icon: RotateCcw,
  },
  {
    name: "/usage",
    description: "Check harness usage and available account limits",
    icon: Gauge,
  },
];

export function CommandInput({
  value,
  onChange,
  onSend,
  placeholder,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  busy: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const matches =
    value.trim().startsWith("/") &&
    !/\s/.test(value.trim()) &&
    value !== dismissed
      ? commands.filter((command) => command.name.startsWith(value.trim()))
      : [];
  const active = Math.min(selected, matches.length - 1);
  function choose(command: string) {
    onChange(command);
    setDismissed(command);
    setSelected(0);
    input.current?.focus();
  }
  return (
    <>
      {matches.length > 0 && (
        <div
          className="slash-picker"
          id="chat-commands"
          role="listbox"
          aria-label="Chat commands"
        >
          {matches.map((command, index) => (
            <button
              key={command.name}
              id={`command-${index}`}
              role="option"
              aria-selected={active === index}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(command.name)}
            >
              <command.icon size={18} />
              <span>
                <strong>{command.name}</strong>
                <small>{command.description}</small>
              </span>
              <kbd>↵</kbd>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        rows={1}
        aria-label="Message"
        placeholder={placeholder}
        value={value}
        aria-autocomplete="list"
        aria-controls={matches.length ? "chat-commands" : undefined}
        aria-activedescendant={matches.length ? `command-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setSelected(0);
          setDismissed(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (matches.length) {
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissed(value);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(
                (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
                  matches.length,
              );
              return;
            }
            if (
              e.key === "Tab" ||
              (e.key === "Enter" &&
                !e.shiftKey &&
                value.trim() !== matches[active].name)
            ) {
              e.preventDefault();
              choose(matches[active].name);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!busy) onSend();
          }
        }}
      />
    </>
  );
}

function windowName(window: UsageWindow | null, fallback: string) {
  const minutes = window?.windowDurationMins;
  if (minutes == null) return fallback;
  if (minutes === 10080) return "Weekly limit";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

export function UsageCard({ report }: { report: UsageReport }) {
  return (
    <section className="usage-card" aria-label="Harness usage">
      <p className="usage-caption">
        {report.buckets.length > 0 ? "Codex account limits · " : ""}Checked{" "}
        {new Date(report.checked_at).toLocaleString()}
      </p>
      {report.buckets.map((bucket, index) => (
        <div className="usage-bucket" key={bucket.limitId ?? index}>
          <h4>
            {bucket.limitName || bucket.limitId || "Codex"}
            {bucket.planType && <span>{bucket.planType}</span>}
          </h4>
          {([bucket.primary, bucket.secondary] as const).map(
            (window, index) => {
              const used = window?.usedPercent;
              const remaining =
                used == null ? null : Math.max(0, Math.min(100, 100 - used));
              return (
                <div className="usage-window" key={index}>
                  <div>
                    <strong>
                      {windowName(
                        window,
                        index === 0 ? "Primary limit" : "Secondary limit",
                      )}
                    </strong>
                    <span>
                      {remaining == null
                        ? "Not reported"
                        : `${Number(remaining.toFixed(1))}% remaining`}
                    </span>
                  </div>
                  {remaining != null && (
                    <meter
                      min={0}
                      max={100}
                      value={remaining}
                      aria-label={`${windowName(window, "Limit")} remaining`}
                    />
                  )}
                  {window?.resetsAt != null && (
                    <small>
                      Resets {new Date(window.resetsAt * 1000).toLocaleString()}
                    </small>
                  )}
                </div>
              );
            },
          )}
        </div>
      ))}
      {report.opencode_usage && <p>{report.opencode_usage}</p>}
      <p className="usage-caption">Send /usage again to refresh.</p>
    </section>
  );
}
