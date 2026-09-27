import { useState } from "react";
import { CalendarClock, Pause, Play, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api, post, put } from "./api";
import type { Schedule } from "./bindings/Schedule";
import type { Run } from "./bindings/Run";

function localTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}
const displayTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
type Draft = {
  id?: string;
  name: string;
  body: string;
  start: string;
  repeat: string;
};

export function ScheduledTasks({
  readOnly = false,
  groupId,
  tasks,
  runs,
  onRefresh,
  onOpenRun,
}: {
  readOnly?: boolean;
  groupId: string;
  tasks: Schedule[];
  runs: Run[];
  onRefresh: () => Promise<void>;
  onOpenRun: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function perform(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await action();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="scheduled-tasks" aria-label="Scheduled tasks">
      <header className="schedule-header">
        <div>
          <h2>Scheduled tasks</h2>
          <p>Send a message to your chat lead at the time you choose.</p>
        </div>
        <Button
          disabled={readOnly}
          onClick={() => {
            setError("");
            setDraft({
              name: "",
              body: "",
              start: localTime(new Date(Date.now() + 3600000).toISOString()),
              repeat: "",
            });
          }}
        >
          <Plus size={16} />
          New task
        </Button>
      </header>
      {error && !draft && !deleting && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      <p className="schedule-note">
        Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Keep
        this machine awake and Agentic Enterprise running. After downtime, one
        overdue message is sent; missed repeats are combined.
      </p>
      {!tasks.length && (
        <div className="empty-state">
          <CalendarClock size={32} />
          <h2>Let your next message arrive on time</h2>
          <p>
            Schedule a check-in, a reminder, or instructions for your agents.
          </p>
        </div>
      )}
      <div className="schedule-list">
        {tasks.map((task) => {
          const run = runs.find((r) => r.message_id === task.last_message_id);
          const status = task.last_error
            ? "Needs attention"
            : task.enabled
              ? "Scheduled"
              : task.next_run_at
                ? "Paused"
                : "Sent";
          return (
            <article
              className="schedule-card"
              key={task.id}
              aria-label={task.name}
            >
              <div className="schedule-card-heading">
                <CalendarClock size={20} />
                <h3>{task.name}</h3>
                <span
                  className={`schedule-status ${task.last_error ? "has-error" : ""}`}
                >
                  {status}
                </span>
              </div>
              <p className="schedule-message">{task.body}</p>
              <div className="schedule-timing">
                <span>
                  {task.next_run_at
                    ? `${task.enabled ? "Next" : "Scheduled for"}: ${displayTime(task.next_run_at)}`
                    : "One-time message sent"}
                </span>
                <span>
                  {task.repeat_minutes
                    ? `Every ${task.repeat_minutes} minutes`
                    : "Does not repeat"}
                </span>
              </div>
              {task.last_error && (
                <p className="schedule-error" role="alert">
                  {task.last_error}
                </p>
              )}
              <footer>
                <div className="schedule-last">
                  {task.last_sent_at && (
                    <span>Last sent {displayTime(task.last_sent_at)}</span>
                  )}
                  {run && (
                    <button
                      className="run-link"
                      onClick={() => onOpenRun(run.id)}
                    >
                      View run · {run.status}
                    </button>
                  )}
                </div>
                <div className="schedule-actions">
                  {task.next_run_at && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || readOnly}
                      onClick={() =>
                        void perform(async () => {
                          await put(`/schedules/${task.id}/enabled`, {
                            enabled: !task.enabled,
                          });
                        })
                      }
                    >
                      {task.enabled ? <Pause size={14} /> : <Play size={14} />}{" "}
                      {task.enabled ? "Pause" : "Resume"}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || readOnly}
                    onClick={() => {
                      setError("");
                      setDraft({
                        id: task.id,
                        name: task.name,
                        body: task.body,
                        start: localTime(
                          task.next_run_at &&
                            new Date(task.next_run_at).getTime() > Date.now()
                            ? task.next_run_at
                            : new Date(Date.now() + 3600000).toISOString(),
                        ),
                        repeat: task.repeat_minutes?.toString() ?? "",
                      });
                    }}
                  >
                    <Pencil size={14} />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || readOnly}
                    onClick={() => {
                      setError("");
                      setDeleting(task);
                    }}
                    aria-label={`Delete ${task.name}`}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </footer>
            </article>
          );
        })}
      </div>
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDraft(null);
            setError("");
          }
        }}
      >
        <DialogContent className="schedule-dialog">
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? "Edit scheduled task" : "New scheduled task"}
            </DialogTitle>
            <DialogDescription>
              Your custom message goes to this group. Your chat lead can respond
              or delegate.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="schedule-form"
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  const date = new Date(draft.start);
                  if (
                    !Number.isFinite(date.getTime()) ||
                    date.getTime() <= Date.now()
                  )
                    throw new Error("Choose a future date and time.");
                  const input = {
                    name: draft.name,
                    body: draft.body,
                    start_at: date.toISOString(),
                    repeat_minutes: draft.repeat ? Number(draft.repeat) : null,
                  };
                  if (draft.id) await put(`/schedules/${draft.id}`, input);
                  else await post(`/groups/${groupId}/schedules`, input);
                  setDraft(null);
                });
              }}
            >
              <Label htmlFor="task-name">Name</Label>
              <Input
                id="task-name"
                required
                maxLength={80}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Morning check-in"
              />
              <Label htmlFor="task-message">Custom message</Label>
              <Textarea
                id="task-message"
                required
                maxLength={64000}
                rows={5}
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="Review the codebase and tell me what needs attention."
              />
              <Label htmlFor="task-start">
                Send at · {Intl.DateTimeFormat().resolvedOptions().timeZone}
              </Label>
              <Input
                type="datetime-local"
                step="1"
                id="task-start"
                required
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
              />
              <Label htmlFor="task-repeat">Repeat</Label>
              <select
                id="task-repeat"
                value={
                  ["", "60", "1440", "10080"].includes(draft.repeat)
                    ? draft.repeat
                    : "custom"
                }
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    repeat: e.target.value === "custom" ? "30" : e.target.value,
                  })
                }
              >
                <option value="">Does not repeat</option>
                <option value="60">Every hour</option>
                <option value="1440">Every 24 hours</option>
                <option value="10080">Every 7 days</option>
                <option value="custom">Custom interval</option>
              </select>
              {draft.repeat &&
                !["60", "1440", "10080"].includes(draft.repeat) && (
                  <>
                    <Label htmlFor="task-interval">
                      Minutes between messages
                    </Label>
                    <Input
                      id="task-interval"
                      type="number"
                      required
                      min="1"
                      max="525600"
                      step="1"
                      value={draft.repeat}
                      onChange={(e) =>
                        setDraft({ ...draft, repeat: e.target.value })
                      }
                    />
                  </>
                )}
              <p className="schedule-note">
                Repeats use elapsed time from the first send. Paused tasks stay
                paused after editing.
              </p>
              {error && (
                <p className="schedule-error" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy || readOnly}>
                {busy ? "Saving…" : "Save task"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDeleting(null);
            setError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>
              This stops future messages. Messages and runs already sent stay in
              the group.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="schedule-error">
              {error}
            </p>
          )}
          <Button
            disabled={busy || readOnly}
            onClick={() =>
              void perform(async () => {
                if (deleting)
                  await api(`/schedules/${deleting.id}`, { method: "DELETE" });
                setDeleting(null);
              })
            }
          >
            Delete task
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
