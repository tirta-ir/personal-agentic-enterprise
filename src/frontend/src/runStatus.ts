import type { Run } from "./bindings/Run";

export const isActiveRun = (run: Run) => ["queued", "starting", "running", "waiting"].includes(run.status);
