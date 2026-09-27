# Verification

Run the static and package checks from `src`:

```powershell
cargo fmt --all --check
cargo test --workspace --locked
Set-Location frontend
npm run lint
npm run build
```

The browser smoke tests in `frontend/tests/native-smoke.mjs` exercise the running service. Start a disposable organization on a separate port, set `AE_TEST_ORG` and `AE_TEST_URL`, and run a phase such as `node tests/native-smoke.mjs basic` from `frontend`.

Some phases require a signed-in provider CLI or a configured SSH workstation and may use provider quota. Keep test organizations and evidence outside the repository; never commit credentials, private addresses, runtime state, screenshots, or production run records.
