"""Disposable real SSH password endpoint for acceptance (requires Paramiko).

Listens only on loopback and forwards the actual bridge bytes to the existing
linux-example workstation. No canned API/CLI responses, remote users, or
remote configuration changes. The generated password is a test credential.
"""
import json
import logging
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time

import paramiko

logging.getLogger("paramiko").addHandler(logging.NullHandler())
logging.getLogger("paramiko").propagate = False
password = secrets.token_urlsafe(24)
host_key = paramiko.RSAKey.generate(2048)


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.command = None
        self.ready = threading.Event()

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, supplied):
        return paramiko.AUTH_SUCCESSFUL if username == "acceptance" and secrets.compare_digest(password, supplied) else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        text = command.decode("utf-8")
        if not text.startswith('PATH="$HOME/.local/bin:') or '"ae-remote-bridge"' not in text:
            return False
        self.command = text
        self.ready.set()
        return True


def serve(client):
    transport = paramiko.Transport(client)
    process = None
    try:
        transport.add_server_key(host_key)
        server = Server()
        transport.start_server(server=server)
        channel = transport.accept(12)
        if channel is None or not server.ready.wait(12):
            return  # ssh-keyscan only performs key exchange, never authentication.
        process = subprocess.Popen(
            ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "linux-example", server.command],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

        def input_stream():
            try:
                while data := channel.recv(65536):
                    process.stdin.write(data)
                    process.stdin.flush()
            except (EOFError, OSError):
                pass  # Peer/process already closed the stream.
            finally:
                process.stdin.close()

        def output_stream(source, send):
            try:
                while data := source.read1(65536):
                    send(data)
            except OSError:
                pass  # Closing the disposable SSH client cancels forwarding.

        threading.Thread(target=input_stream, daemon=True).start()
        readers = [threading.Thread(target=output_stream, args=(process.stdout, channel.sendall)), threading.Thread(target=output_stream, args=(process.stderr, channel.sendall_stderr))]
        for reader in readers:
            reader.start()
        status = process.wait(timeout=70)
        for reader in readers:
            reader.join(timeout=3)
        channel.send_exit_status(status)
    except (EOFError, OSError, paramiko.SSHException, subprocess.TimeoutExpired):
        if process and process.poll() is None:
            process.kill()
            process.wait()
    finally:
        transport.close()


with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    listener.settimeout(1)
    Path(sys.argv[1]).write_text(json.dumps({"port": listener.getsockname()[1], "password": password}), encoding="utf-8")
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            client, _ = listener.accept()
        except socket.timeout:
            continue
        threading.Thread(target=serve, args=(client,), daemon=True).start()
