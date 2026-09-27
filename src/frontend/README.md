# Agentic Enterprise frontend

React 19, TypeScript, Vite, Tailwind and official shadcn components. The Rust service serves the production bundle and same-origin API.

```powershell
npm ci
npm run build
npm run lint
```

Build Rust and export shared types first using `../scripts/Build.ps1`. Start/open the application with the native scripts documented in [the application README](../README.md). The frontend has no independent database or mock API. Shared TypeScript bindings come from `backend/src/model.rs` via ts-rs.

The real browser smoke phases are `node tests/native-smoke.mjs basic`, then `codex`, `knowledge`, and `recovery` against the running native service. Use the complete instructions in the application README; Codex tests consume the signed-in account's normal usage.
