"""On-demand SSH bridge. No daemon, credentials on the workstation only.

Process groups follow CCCC's Unix process ownership; dotenv parsing is the
unmodified python-dotenv v1.2.2 parser (sources supplied by the Rust backend).
"""
import io
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time
import tomllib
import types

MAX_OUTPUT = 8 * 1024 * 1024
SECRETS = []


def redact(text):
    for secret in sorted(SECRETS, key=len, reverse=True):
        if secret:
            text = text.replace(json.dumps(secret, ensure_ascii=False)[1:-1], "[REDACTED]")
            text = text.replace(secret, "[REDACTED]")
    return text


def emit(value):
    def clean(item):
        if isinstance(item, str):
            return redact(item)
        if isinstance(item, list):
            return [clean(v) for v in item]
        if isinstance(item, dict):
            return {k: clean(v) for k, v in item.items()}
        return item
    print(json.dumps(clean(value), ensure_ascii=False), flush=True)


def run(command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, timeout=12, **kwargs)


def codex():
    paths = [str(Path.home() / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
    paths += [str(p) for p in sorted((Path.home() / ".nvm/versions/node").glob("*/bin"), reverse=True)]
    os.environ["PATH"] = os.pathsep.join(paths + [os.environ.get("PATH", "/usr/bin:/bin")])
    found = shutil.which("codex")
    if not found:
        raise ValueError("Codex CLI is not installed or is not on this workstation's PATH")
    return found


def codex_home():
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))


def safe_path(path):
    if any(p.lower().startswith(".env") or p.lower() in (".git", ".state", "auth.json", "owner.key") for p in path.parts):
        raise ValueError("Sensitive/internal files are not exposed by this viewer")
    return path


def workspace(request):
    raw = Path(request["path"])
    if not raw.is_absolute() or not raw.is_dir():
        raise ValueError("Select an existing absolute directory on the workstation")
    root = raw.resolve(strict=True)
    if root == Path(root.anchor):
        raise ValueError("Attach a codebase directory, not a filesystem root")
    with os.scandir(root):
        pass
    git = run(["git", "-C", str(root), "rev-parse", "--show-toplevel"])
    value = {"path": str(raw), "canonical_path": str(root), "git_root": git.stdout.strip() if git.returncode == 0 else None}
    expected = request.get("workspace")
    if expected and any(value[k] != expected[k] for k in ("canonical_path", "git_root")):
        raise ValueError("Attached directory identity changed; reattach it explicitly")
    return value


def dotenv(request, root):
    file = root / ".env"
    if not file.exists():
        return {}
    if file.stat().st_size > 1024 * 1024:
        raise ValueError("Workdir .env exceeds 1 MiB")
    # Upstream parser rejects malformed entries without echoing secret source lines.
    parser = types.ModuleType("ae_dotenv_parser")
    variables = types.ModuleType("ae_dotenv_variables")
    exec(request["dotenv_parser"], parser.__dict__)
    exec(request["dotenv_variables"], variables.__dict__)
    values = {}
    reserved = {"PATH", "PATHEXT", "COMSPEC", "HOME", "USERPROFILE", "CODEX_HOME", "CODEX_THREAD_ID", "AE_ORG", "AE_TOKEN", "AE_TOOL_TOKEN", "RUST_LOG"}
    for binding in parser.parse_stream(io.StringIO(file.read_text(encoding="utf-8-sig"))):
        if binding.error:
            raise ValueError("Invalid workdir .env syntax; check key/value quoting")
        if binding.key is None:
            continue
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", binding.key) or binding.key.upper() in reserved:
            raise ValueError("Invalid or reserved variable name in workdir .env")
        if binding.value is None:
            raise ValueError("Workdir .env entries require a value")
        values[binding.key] = "".join(atom.resolve({**os.environ, **values}) for atom in variables.parse_variables(binding.value))
    SECRETS.extend(v for v in values.values() if v)
    return values


def contained(root, reference):
    from urllib.parse import urlparse, unquote
    if reference.startswith("file:"):
        url = urlparse(reference)
        if url.netloc not in ("", "localhost"):
            raise ValueError("Network file paths are not supported")
        reference = unquote(url.path)
    path = Path(reference)
    if ".." in path.parts or any(ord(c) < 32 for c in reference):
        raise ValueError("Path escapes workspace")
    safe_path(path)
    resolved = (root / path).resolve(strict=True)
    safe_path(resolved.relative_to(root))
    return resolved


def stop_group(process):
    if getattr(process, "ae_stopped", False):
        return
    process.ae_stopped = True
    # Reap the entire process group even when its leader has already exited.
    try:
        os.killpg(process.pid, signal.SIGTERM)
        time.sleep(0.2)
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin returns EPERM for an owned group containing only zombies.
        # Do not hide a permission failure while any group member is still alive.
        groups = subprocess.run(["ps", "-axo", "pgid=,stat="], capture_output=True,
                                text=True, check=True, timeout=5).stdout
        for line in groups.splitlines():
            group, state = line.split(maxsplit=1)
            if int(group) == process.pid and not state.startswith("Z"):
                raise
    process.wait(timeout=5)


def execute(request, ws, executable):
    terminal = request["op"] == "terminal"
    root = Path(ws["canonical_path"])
    env = dict(os.environ)
    env.update(dotenv(request, root))
    if request.get("tool_token"):
        env["AE_TOOL_TOKEN"] = request["tool_token"]
        SECRETS.append(request["tool_token"])
    for key in ("namespace", "session_id", "run_id"):
        if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", request[key]):
            raise ValueError("Invalid runtime identifier")
    home = Path.home() / ".local/share/agentic-enterprise" / request["namespace"] / "sessions" / request["session_id"]
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(home, 0o700)
    source = codex_home() / "auth.json"
    original = None if terminal else source.read_bytes()
    target = home / "auth.json"
    if original is not None:
        target.write_bytes(original)
        os.chmod(target, 0o600)
    (home / "AGENTS.md").write_text(request["instructions"], encoding="utf-8")
    env["CODEX_HOME"] = str(home)
    args = ["-lc", request["command"]] if terminal else request["arguments"]
    if request.get("schema"):
        schema = home / "coordination-schema.json"
        schema.write_text(request["schema"], encoding="utf-8")
        args += ["--output-schema", str(schema)]
    import base64
    for attachment in request.get("images", []):
        if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", attachment["id"]):
            raise ValueError("Invalid image identifier")
        file = home / (attachment["id"] + ".image")
        file.write_bytes(base64.b64decode(attachment["data"], validate=True))
        args += ["--image", str(file)]
    if request.get("native_session_id"):
        args += ["resume", request["native_session_id"]]
    if not terminal:
        args += ["-"]
    process = subprocess.Popen([executable, *args], cwd=root, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    reason = None
    try:
        emit({"type": "ae.remote.started", "pid": process.pid, "executable": executable, "arguments": args, "cwd": str(root)})
        # Write concurrently so a large prompt cannot block the heartbeat/output loop.
        import threading
        def prompt():
            try:
                if not terminal:
                    process.stdin.write(request["prompt"].encode("utf-8"))
                process.stdin.close()
            except BrokenPipeError:
                pass
        writer = threading.Thread(target=prompt, daemon=True)
        writer.start()
        selector = selectors.DefaultSelector()
        streams = {process.stdout: bytearray(), process.stderr: bytearray()}
        # Drain bytes prefetched with the JSON request before using the raw fd.
        # A blocked daemon BufferedReader would abort Python during shutdown.
        os.set_blocking(sys.stdin.fileno(), False)
        prefetched = sys.stdin.buffer.read()
        control_buffer = bytearray(prefetched or b"")
        if prefetched == b"":
            reason = "interrupted"
        for stream in [*streams, sys.stdin.buffer]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        started = heartbeat = time.monotonic()
        active_time = 0
        waiting_for_input = False
        total = 0
        while True:
            for key, _ in selector.select(0.25):
                stream = key.fileobj
                chunk = os.read(stream.fileno(), 65536)
                if stream == sys.stdin.buffer:
                    if not chunk:
                        reason = "interrupted"
                    control_buffer.extend(chunk)
                    continue
                if not chunk:
                    selector.unregister(stream)
                    continue
                total += len(chunk)
                if total > MAX_OUTPUT:
                    raise ValueError("Run output exceeded 8 MiB")
                buffer = streams[stream]
                buffer.extend(chunk)
                patterns = [s.encode() for s in SECRETS if s]
                # Hold possible secret prefixes across reads, including multiline values.
                boundary = buffer.rfind(b"\n", 0, max(0, len(buffer) - max(map(len, patterns), default=0))) + 1
                for pattern in patterns:
                    start = buffer.find(pattern, max(0, boundary - len(pattern)))
                    if 0 <= start < boundary < start + len(pattern):
                        boundary = buffer.rfind(b"\n", 0, start) + 1
                if boundary:
                    text = bytes(buffer[:boundary]).decode("utf-8", errors="replace")
                    del buffer[:boundary]
                    forward(text, terminal, stream == process.stderr)
            tick = time.monotonic()
            if not waiting_for_input:
                active_time += tick - started
            started = tick
            while b"\n" in control_buffer:
                line, _, remaining = control_buffer.partition(b"\n")
                control_buffer[:] = remaining
                heartbeat = time.monotonic()
                if line.strip() == b"cancel":
                    reason = "cancelled"
                if not terminal:
                    waiting_for_input = line.strip() == b"waiting_for_input"
            if time.monotonic() - heartbeat > 15:
                reason = "interrupted"
            if active_time > request["timeout_seconds"]:
                reason = "timed_out"
            exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if reason or exited is not None:
                stop_group(process)
                writer.join(timeout=2)
                # Drain final bytes after the owned group is gone.
                for stream, buffer in streams.items():
                    os.set_blocking(stream.fileno(), True)
                    buffer.extend(stream.read(MAX_OUTPUT - min(total, MAX_OUTPUT) + 1))
                    if buffer:
                        text = buffer.decode("utf-8", errors="replace")
                        forward(text, terminal, stream == process.stderr)
                emit({"type": "ae.remote.finished", "status": reason, "exit_code": process.returncode})
                return process.returncode if reason is None else 1
    finally:
        stop_group(process)
        # Never replace a newer native login with stale scoped credentials.
        if original is not None and source.read_bytes() == original and target.exists():
            updated = target.read_bytes()
            if updated != original:
                replacement = source.with_name("ae-auth-" + request["run_id"] + ".tmp")
                replacement.write_bytes(updated)
                os.chmod(replacement, 0o600)
                replacement.replace(source)


def forward(text, terminal, error):
    if terminal:
        emit({"type": "ae.terminal.output", "text": text})
    elif error:
        print(redact(text), end="", file=sys.stderr, flush=True)
    else:
        for line in text.splitlines():
            if line.strip():
                emit(json.loads(line))


def skills(request, root, executable):
    process = subprocess.Popen([executable, "app-server"], cwd=root, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    def send(value):
        process.stdin.write((json.dumps(value) + "\n").encode())
        process.stdin.flush()
    try:
        send({"id": 0, "method": "initialize", "params": {"clientInfo": {"name": "agentic_enterprise", "version": "0.1.0"}}})
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = b""
        total = 0
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            for _, _ in selector.select(0.25):
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise ValueError("Remote Codex skills discovery disconnected")
                total += len(chunk)
                if total > 2 * 1024 * 1024:
                    raise ValueError("Remote skills response exceeded 2 MiB")
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    value = json.loads(line)
                    if "error" in value:
                        raise ValueError("Remote Codex skills request failed; check the installed CLI")
                    if value.get("id") == 0:
                        send({"method": "initialized", "params": {}})
                        send({"id": 1, "method": "skills/list", "params": {"cwds": [str(root)], "forceReload": True}})
                    elif value.get("id") == 1:
                        found = [s for entry in value["result"]["data"] for s in entry["skills"] if s["scope"] == "repo"]
                        errors = [e for entry in value["result"]["data"] for e in entry["errors"]]
                        text = None
                        if request.get("reference"):
                            selected = next((s for s in found if s["path"] == request["reference"]), None)
                            if selected is None:
                                raise ValueError("Skill is no longer installed; refresh the list")
                            path = contained(Path(request["workspace"].get("git_root") or root), selected["path"])
                            if path.name != "SKILL.md" or path.stat().st_size > 256 * 1024:
                                raise ValueError("Only SKILL.md files up to 256 KiB can be previewed")
                            text = path.read_text(encoding="utf-8")
                        emit({"cwd": str(root), "skills": sorted(found, key=lambda s: s["name"].lower()), "errors": errors, "text": text})
                        return 0
        raise ValueError("Remote skills discovery timed out")
    finally:
        stop_group(process)


def main(request):
    op = request["op"]
    if op == "directories":
        root = safe_path(Path(request.get("path") or Path.home()).resolve(strict=True))
        folders = []
        for p in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if p.is_dir() and not p.name.startswith("."):
                folders.append({"name": p.name, "path": str(p)})
            if len(folders) >= 1000:
                break
        emit({"path": str(root), "parent": str(root.parent) if root.parent != root else None,
              "roots": [{"name": "Home", "path": str(Path.home())}], "folders": folders})
        return 0
    if op == "settings":
        home = codex_home()
        config = tomllib.loads((home / "config.toml").read_text()) if (home / "config.toml").exists() else {}
        profile = config.get("profiles", {}).get(config.get("profile"), {})
        keys = ("model", "model_reasoning_effort")
        emit({"config": {k: profile.get(k, config.get(k, "")) for k in keys},
              "cache": json.loads((home / "models_cache.json").read_text())})
        return 0
    ws = workspace(request)
    if op == "workspace":
        emit({"workspace": ws, "git_status": "Workdir verified on workstation"})
        return 0
    root = Path(ws["canonical_path"])
    if op == "redact":
        dotenv(request, root)
        emit({"command": redact(request["command"])})
        return 0
    if op in ("file", "files"):
        path = contained(root, request["reference"])
        if op == "files" and path.is_dir():
            entries = [{"name": p.name, "directory": p.is_dir()} for p in path.iterdir()
                       if not p.name.startswith(".env") and p.name not in (".git", ".state", "node_modules", "target")]
            emit({"entries": sorted(entries, key=lambda p: p["name"].lower()), "base": str(root)})
        else:
            limit = 25 * 1024 * 1024 if op == "file" else 256 * 1024
            with path.open("rb") as file:
                data = file.read(limit + 1)
            if len(data) > limit:
                raise ValueError("File exceeds viewer size limit")
            if op == "file":
                sys.stdout.buffer.write(data)
            else:
                emit({"text": data.decode("utf-8"), "base": str(root)})
        return 0
    executable = codex()
    if op == "skills":
        return skills(request, root, executable)
    if op == "probe":
        version = run([executable, "--version"])
        login = run([executable, "login", "status"])
        env = dotenv(request, root)
        emit({"ready": login.returncode == 0 and version.returncode == 0,
              "message": (login.stdout + login.stderr).strip(), "version": version.stdout.strip(),
              "executable": executable, "os": os.uname().sysname, "environment_keys": list(env), "workspace": ws})
        return 0
    if op in ("execute", "terminal"):
        if op == "terminal":
            executable = "/bin/sh"
        return execute(request, ws, executable)
    raise ValueError("Unsupported remote operation")


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.readline(48 * 1024 * 1024))
        sys.exit(main(request))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(redact(str(error)), file=sys.stderr, flush=True)
        sys.exit(1)
