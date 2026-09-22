import { useEffect, useState } from "react";
import { api } from "./api";
import type { Agent } from "./bindings/Agent";
import type { Message } from "./bindings/Message";

export function ReplyQuote({ id, message, groupId, sideChatId, agents, user, onJump, jumping }: {
  id: string; message?: Message; groupId: string; sideChatId: string | null;
  agents: Agent[]; user: string;
  onJump?: (message: Message) => void; jumping?: boolean;
}) {
  const [loaded, setLoaded] = useState<Message>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (message) return;
    let cancelled = false;
    const query = new URLSearchParams({ id });
    if (sideChatId) query.set("side_chat_id", sideChatId);
    else query.set("main", "true");
    void api<Message[]>(`/groups/${groupId}/messages?${query}`).then((values) => {
      if (!cancelled) {
        setLoaded(values[0]);
        if (!values.length) setError("Original message is unavailable in this conversation.");
      }
    }, (reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [id, message, groupId, sideChatId]);
  const quoted = message ?? loaded;
  const author = quoted?.sender === user ? "You"
    : quoted?.sender === "owner" ? "Workspace owner"
    : quoted?.sender === "system" ? "Agentic Enterprise"
    : agents.find(agent => agent.id === quoted?.sender)?.name ?? quoted?.sender;
  const content = <>
    {quoted ? <><strong>{author}</strong><span>{quoted.body || "Attachment"}</span></>
      : <span>{error ? "Original message unavailable" : "Loading original message…"}</span>}
  </>;
  return onJump
    ? <button type="button" className="reply-quote reply-quote-link" aria-label={`Go to original message${author ? ` from ${author}` : ""}`}
        aria-busy={jumping || undefined} disabled={!quoted || jumping} title={error || "Go to original message"}
        onClick={() => quoted && onJump(quoted)}>{content}</button>
    : <blockquote className="reply-quote" aria-label="Quoted message" title={error || undefined}>{content}</blockquote>;
}
