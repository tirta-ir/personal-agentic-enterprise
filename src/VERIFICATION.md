# Verification

Run these checks from `src` after installing the documented Rust and Node.js dependencies:

```powershell
cargo fmt --all --check
cargo test --workspace --locked
Set-Location frontend
npm run lint
npm run build
```

The frontend smoke tests in `frontend/tests/native-smoke.mjs` exercise the running service through a real browser. Start a disposable organization on a separate port, set `AE_TEST_ORG` and `AE_TEST_URL`, then run the requested phase, for example:

```powershell
node tests/native-smoke.mjs basic
```

Some phases need a signed-in provider CLI or a configured SSH workstation and may use provider quota. Use only disposable test data; do not commit screenshots, runtime state, credentials, private addresses, or production run evidence.
