# Tencent deployment over NetBird

The platform is deployed on `tencent-personal` at **http://10.69.0.101:18766**.
Connect through NetBird (`wt0`). Docker publishes the app only on `10.69.0.101`;
Matrix is available to the platform internally and on host loopback `127.0.0.1:18767`.
No public HTTPS hostname or reverse-proxy route is configured for this deployment.

## Installation

- Application source: `e323338d1042ff1fdd37952ffe21c109625b840a`.
- Platform image: `agentic-enterprise:e323338-amd64` (Linux x86_64).
- Image on Tencent: `sha256:82dfb08e15a6dcca93a69373802abc0f0683f8b1a1e5e18edf708c6673593698`.
- Synapse: `ghcr.io/element-hq/synapse:v1.161.0`; server name `agentic.tencent`.
- Deployment directory: `/home/ubuntu/agentic-enterprise`.
- Managed service: `agentic-enterprise.service`, enabled at boot and ordered after Docker
  and NetBird. Its pre-start check waits for the expected address on `wt0`.
- Persistent Docker volumes: `agentic-enterprise_platform-data` and
  `agentic-enterprise_matrix-data`.

Tencent has 2 GB RAM. The image was built on mac-personal with a native ARM Rust
compiler targeting `x86_64-unknown-linux-gnu`, then transferred directly over SSH.
The dev build disables debug symbols. The build context, cross-build Dockerfile,
and log are retained at `/Users/punya-tirta/ae-tencent-build-e323338`.
The source archive SHA-256 is
`df165c4dadca258ef48618daf90b8ea6a2e5464fa398e04b67daf6185c639e3c`.
Source and imported images were verified to have identical seven filesystem layers,
architecture, entrypoint, command, environment, user, and working directory.

## Access and operation

Alice (`@alice:agentic.tencent`) owns the fresh `Personal` workspace. Her generated
password is kept in the deployment's mode-0600 `.credentials.json` and a private
local handoff file; it is not committed. Bridge credentials are in mode-0600 `.env`.
The Mac deployment's data remains separate. Register execution machines through
**User settings → Runtime**; this controller has no mounted provider credentials.

```sh
ssh tencent-personal
sudo systemctl status agentic-enterprise
cd /home/ubuntu/agentic-enterprise
sudo docker compose ps
sudo docker compose logs --tail 100 platform
sudo systemctl restart agentic-enterprise
```

For bootstrap-owner recovery, read `/data/org/.state/owner.key` inside the platform
container and enter it in Administrator sign in. Keep that key private.

## Verification

- The actual browser signed in through bundled Matrix, created `Personal`, opened
  Profile/Runtime/Workspace and Action board, and retained its session after reload.
- Health returned HTTP 200 with `status: ok`; protected state returned 401 before
  sign-in and again after logout. Browser exceptions: zero.
- A full service restart preserved an existing authenticated session, the workspace,
  and its agent records. The systemd unit is active and enabled.
- Both containers reported healthy. The socket table showed only
  `10.69.0.101:18766` for the app and `127.0.0.1:18767` for Matrix.
- Windows reached the app through NetBird; Matrix's port was not reachable on wt0.

Detailed private proof files and screenshots are in local
`org/deployment-tencent-20260922/`. No mocks or paid model invocations were used.
Agent execution awaits registration of a runtime; no Mac runtime was reassigned.
