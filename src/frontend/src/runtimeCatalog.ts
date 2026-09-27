import type { Agent } from "./bindings/Agent";
import type { CodexSettings } from "./bindings/CodexSettings";

export type RegisteredRuntime = { id:string; name:string; description?:string; root?:string; os?:string; online:boolean; revoked:boolean; capabilities?:Partial<Record<Agent["harness"], CodexSettings | null>> };
export const harnessNames = {codex: "Codex CLI", opencode: "OpenCode"};
export const availableHarnesses = (runtime?: RegisteredRuntime) => (Object.keys(harnessNames) as Agent["harness"][]).filter(harness => runtime?.capabilities?.[harness]);
