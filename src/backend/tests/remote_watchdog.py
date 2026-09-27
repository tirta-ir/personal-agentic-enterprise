"""Real SSH/Unix-process watchdog check. Uses only the dedicated demo workdir."""
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

host = sys.argv[1]
cancel = "--cancel-immediately" in sys.argv
complete = "--complete" in sys.argv
home = {"linux-example": "/home/test-user", "macos-example": "/Users/test-user"}[host]
src = Path(__file__).resolve().parents[2]
source = (src / "backend/src/remote_bridge.py").read_bytes().replace(b"\r\n", b"\n")
request = {"op": "terminal", "path": home + "/.local/share/agentic-enterprise/workspaces/connection-demo",
           "namespace": "watchdog-verification", "session_id": str(uuid.uuid4()), "run_id": str(uuid.uuid4()),
           "instructions": "", "command": "printf completed" if complete else "sleep 120", "timeout_seconds": 90,
           "dotenv_parser": (src / "vendor/python-dotenv/parser.py").read_text(),
           "dotenv_variables": (src / "vendor/python-dotenv/variables.py").read_text()}
command = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" python3 -u -c \'import sys; n=int(sys.stdin.buffer.readline()); exec(compile(sys.stdin.buffer.read(n), "ae-remote-bridge", "exec"))\''
process = subprocess.Popen(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", host, command],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
try:
    process.stdin.write(str(len(source)).encode() + b"\n" + source + json.dumps(request).encode() + b"\n" + (b"cancel\n" if cancel else b""))
    process.stdin.flush()
    started = json.loads(process.stdout.readline())
    assert started["type"] == "ae.remote.started", started
    begin = time.monotonic()
    # Deliberately leave SSH open but withhold heartbeats, like a stalled controller.
    process.wait(timeout=25)
    elapsed = time.monotonic() - begin
    frames = [json.loads(line) for line in process.stdout.read().splitlines()]
    finished = next(frame for frame in frames if frame["type"] == "ae.remote.finished")
    assert finished["status"] == (None if complete else "cancelled" if cancel else "interrupted"), (finished, process.stderr.read().decode())
    assert process.returncode == (0 if complete else 1), process.stderr.read().decode()
    assert (elapsed < 10 if cancel or complete else 14 <= elapsed <= 23), elapsed
    pid = int(started["pid"])
    check = subprocess.run(["ssh", host, f"if kill -0 {pid} 2>/dev/null; then echo alive; else echo stopped; fi"],
                           capture_output=True, text=True, check=True, timeout=12)
    assert check.stdout.strip() == "stopped", check.stdout
    print(json.dumps({"host": host, "remote_pid": pid, "heartbeat_timeout_seconds": round(elapsed, 2), "status": finished["status"], "process": "stopped", "mocks": False}))
finally:
    process.stdin.close()
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=10)
