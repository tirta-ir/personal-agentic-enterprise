import { Bot } from "lucide-react";
import type { Agent } from "./bindings/Agent";

export function Avatar({
  agent,
  owner = false,
}: {
  agent?: Agent;
  owner?: boolean;
}) {
  return (
    <span
      className={`avatar ${owner ? "owner-avatar" : ""}`}
      style={agent ? { backgroundColor: agent.color } : undefined}
      aria-hidden="true"
    >
      <span className="avatar-initials">
        {owner
          ? "U"
          : (agent?.name.slice(0, 2).toUpperCase() ?? <Bot size={16} />)}
      </span>
    </span>
  );
}
