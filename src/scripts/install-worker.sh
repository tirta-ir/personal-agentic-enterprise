#!/usr/bin/env bash
set -euo pipefail
binary="${AE_BINARY:-$HOME/.local/bin/agentic-enterprise}"
state="${AE_WORKER_STATE:-$HOME/.local/share/agentic-worker}"
workdir="${AE_WORKDIR:-$HOME/agentic-workdir}"
mkdir -p "$state" "$workdir"
chmod 700 "$state"
"$binary" --worker --worker-state "$state" --worker-root "$workdir" --enroll-only
case "$(uname -s)" in
  Linux)
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/agentic-worker.service" <<EOF
[Unit]
Description=Agentic Enterprise registered runtime
After=network-online.target
[Service]
ExecStart="$binary" --worker --worker-state "$state" --worker-root "$workdir"
Environment="PATH=$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now agentic-worker
    echo 'Worker installed. Use loginctl enable-linger if it must run before login.'
    ;;
  Darwin)
    mkdir -p "$HOME/Library/LaunchAgents"
    plist="$HOME/Library/LaunchAgents/ai.agentic.worker.plist"
    /usr/libexec/PlistBuddy -c Clear "$plist"
    /usr/libexec/PlistBuddy -c 'Add :Label string ai.agentic.worker' -c 'Add :ProgramArguments array' "$plist"
    i=0; for arg in "$binary" --worker --worker-state "$state" --worker-root "$workdir"; do /usr/libexec/PlistBuddy -c "Add :ProgramArguments:$i string $arg" "$plist"; i=$((i+1)); done
    /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' -c "Add :EnvironmentVariables:PATH string $HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$plist"
    /usr/libexec/PlistBuddy -c 'Add :RunAtLoad bool true' -c 'Add :KeepAlive bool true' -c "Add :StandardOutPath string $state/worker.log" -c "Add :StandardErrorPath string $state/worker.log" "$plist"
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo 'Worker installed as a persistent login agent.'
    ;;
esac
