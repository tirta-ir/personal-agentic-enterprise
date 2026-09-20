import { useEffect, useId, useState } from "react";
import { api, post } from "./api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { QuestionRequest } from "./bindings/QuestionRequest";

export function QuestionCard({ id, question, onRefresh }: { id: string; question?: QuestionRequest; onRefresh: () => Promise<void> }) {
  const instanceId = useId();
  const [loaded, setLoaded] = useState<QuestionRequest | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (question) return;
    let cancelled = false;
    void api<QuestionRequest>(`/questions/${id}`).then(value => { if (!cancelled) setLoaded(value); }, reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [id, question]);
  const request = question ?? loaded;
  if (!request) return <p role="status">{error || "Loading question…"}</p>;
  const pending = request.status === "pending";
  async function submit() {
    if (!request) return;
    setBusy(true); setError("");
    try {
      const saved = await post<QuestionRequest>(`/questions/${id}/answer`, { answers: Object.fromEntries(request.questions.map(q => [q.id, { answers: [answers[q.id]] }])) });
      setLoaded(saved);
      await onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <form className="question-card" data-question-id={id} aria-label={`Question from ${request.agent_name}`} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="question-status" role="status">{pending ? "Needs your answer" : request.status === "answered" ? request.delivered ? "Answered · returned to the agent" : "Answer saved · continuing" : request.status}</p>
    {request.questions.map(q => <fieldset key={q.id} disabled={!pending || busy}>
      <legend>{q.header}</legend>
      <p>{q.question}</p>
      {pending ? <>
        {q.options.length > 0 && <div className="question-choices">{q.options.map(option => <button type="button" key={option.label} aria-pressed={answers[q.id] === option.label} onClick={() => setAnswers(old => ({ ...old, [q.id]: option.label }))}>
          <strong>{option.label}</strong>{option.description && <span>{option.description}</span>}
        </button>)}</div>}
        <label htmlFor={`${instanceId}-${q.id}`}>Your answer · {q.header}</label>
        <Textarea id={`${instanceId}-${q.id}`} data-question-field={q.id} required maxLength={16000} value={answers[q.id] ?? ""} onChange={event => setAnswers(old => ({ ...old, [q.id]: event.target.value }))} placeholder={q.options.length ? "Choose above or write your own answer" : "Write your answer"} />
      </> : request.answers[q.id] && <p className="question-answer"><strong>Your answer:</strong> {request.answers[q.id]?.answers.join(", ")}</p>}
    </fieldset>)}
    {request.error && <p role="status">{request.error}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {pending && <div className="question-actions">
      <Button type="submit" disabled={busy || request.questions.some(q => !answers[q.id]?.trim())}>{busy ? "Sending…" : "Send answer"}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await post(`/runs/${request.run_id}/cancel`); await onRefresh(); }
        catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setBusy(false); }
      }}>Stop run</Button>
    </div>}
  </form>;
}
