import type { Connection } from "./bindings/Connection";

export function WorkstationStatus({ connection, host }: { connection?: Connection; host: string }) {
  const status = connection?.status ?? "checking";
  const label = status === "online" ? "Online" : status === "offline" ? "Offline" : status === "attention" ? "Needs attention" : "Checking";
  return <span className={`workstation-status workstation-${status}`} title={`${connection?.message ?? "Checking workstation"}${connection?.checked_at ? ` · Checked ${new Date(connection.checked_at).toLocaleTimeString()}` : ""}`}>
    <i aria-hidden="true" />{host} · {label}
  </span>;
}
