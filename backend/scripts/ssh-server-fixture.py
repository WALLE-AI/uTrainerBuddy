"""Loopback password SSH server for testing the actual system OpenSSH/askpass path."""
import json
import base64
import socket
import sys
import threading
import time
try:
    import paramiko
except ImportError as error:
    # Some Anaconda distributions pair old bcrypt metadata with a newer native
    # module. This generated-key test does not use encrypted-key functions.
    if "bcrypt" not in str(error):
        raise
    import importlib.util
    import pathlib
    root = pathlib.Path(importlib.util.find_spec("bcrypt").origin).parent
    native = next(root.glob("_bcrypt*.pyd"))
    spec = importlib.util.spec_from_file_location("_bcrypt", native)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules["bcrypt"] = module
    import paramiko

key = paramiko.ECDSAKey.generate()
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(10)
port = listener.getsockname()[1]
with open(sys.argv[1], "w", encoding="utf-8") as trust:
    trust.write(f"[127.0.0.1]:{port} {key.get_name()} {key.get_base64()}\n")


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.execute = threading.Event()

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, password):
        valid = username == "researcher" and password == "fixture password ! $ ' space"
        print(json.dumps({"event": "authentication", "accepted": valid}), flush=True)
        return paramiko.AUTH_SUCCESSFUL if valid else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        if command != b"python3 -u -c 'import sys; exec(sys.stdin.readline())'":
            return False
        self.execute.set()
        return True


def serve(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(key)
        server = Server()
        transport.start_server(server=server)
        channel = transport.accept(10)
        if channel is None or not server.execute.wait(10):
            return
        stream = channel.makefile("rb")
        received = stream.readline()
        assert received.startswith(b"exec(") and b"CONFIG = " in received
        assert b"fixture password" not in received
        snapshot = {"protocol_version": 1, "hostname": "real-ssh-fixture", "os": "Linux", "arch": "x86_64", "python": "3.12", "gpus": [], "gpu_error": "NVIDIA_SMI_MISSING", "workdir": {"path": "/workspace", "exists": True, "writable": True}, "host": {"installed": False, "ready": False, "protocol_version": None}}
        channel.sendall(json.dumps(snapshot).encode() + b"\n")
        for line in stream:
            request = json.loads(line)
            if request.get("op") == "list":
                data = {"entries": [{"name": "readme.txt", "type": "file", "size": 6, "symlink": False}], "next_cursor": None, "truncated": False, "root": "/workspace"}
            else:
                data = {"content_base64": base64.b64encode(b"hello\n").decode(), "size": 6, "modified_at": 123, "path": request["path"]}
            channel.sendall(json.dumps({"id": request["id"], "data": data}).encode() + b"\n")
        channel.send_exit_status(0)
        time.sleep(0.1)
        channel.close()
    finally:
        transport.close()


print(json.dumps({"port": port}), flush=True)
while True:
    client, _ = listener.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
