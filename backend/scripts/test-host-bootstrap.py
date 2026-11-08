"""Linux integration test of the exact Python bootstrap and the real Rust host."""
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

source = Path(__file__).resolve().parents[1] / "src"
binary = Path(__file__).resolve().parents[1] / "host-binaries/linux-x86_64/trainerbuddy-host"
host_bytes = binary.read_bytes()
sha = hashlib.sha256(host_bytes).hexdigest()
with tempfile.TemporaryDirectory(prefix="trainer-bootstrap-") as root:
    script = "CONFIG = " + json.dumps(json.dumps({"workdir": root})) + "\n"
    script += "\n".join((source / name).read_text() for name in ["compute_probe.py", "host_bridge.py", "remote_files.py"])
    child = subprocess.Popen([sys.executable, "-u", "-c", "import sys; exec(sys.stdin.readline())"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        child.stdin.write("exec(" + json.dumps(script) + ")\n")
        child.stdin.flush()
        assert json.loads(child.stdout.readline())["workdir"]["exists"]
        sequence = 0

        def request(op, **fields):
            global sequence
            sequence += 1
            child.stdin.write(json.dumps({"id": sequence, "op": op, **fields}) + "\n")
            child.stdin.flush()
            response = json.loads(child.stdout.readline())
            assert response["id"] == sequence, response
            assert "error" not in response, response
            return response["data"]

        def rpc(op, **fields):
            data = request("host_request", request={"op": op, **fields})
            assert "host_error" not in data, data
            return data

        def install():
            offset = request("host_install_begin", sha256=sha, size=len(host_bytes))["offset"]
            while offset < len(host_bytes):
                chunk = host_bytes[offset:offset + 256 * 1024]
                offset = request("host_install_chunk", offset=offset, bytes=base64.b64encode(chunk).decode())["offset"]
            assert request("host_install_finish")["started"]
            hello = rpc("hello")
            assert hello["protocol_version"] == 1 and hello["binary_sha256"] == sha

        install()
        content = b'print("Linux bootstrap tested")\n'
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as output:
            info = tarfile.TarInfo("train.py")
            info.size, info.mode = len(content), 0o644
            output.addfile(info, io.BytesIO(content))
        payload = archive.getvalue()
        archive_sha = hashlib.sha256(payload).hexdigest()
        identity = {"project": "linux-project", "sha256": archive_sha, "size": len(payload)}
        rpc("put_chunk", **identity, offset=0, bytes=base64.b64encode(payload).decode())
        rpc("complete_blob", **identity)
        manifest = [{"path": "train.py", "size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "executable": False}]
        receipt = rpc("publish_snapshot", **identity, snapshot="linux-snapshot", commit="fixture", manifest=manifest)
        assert receipt["complete"]
        path = receipt["repo_path"] + "/train.py"
        assert base64.b64decode(request("read", path=path)["content_base64"]) == content
        assert request("list", path=receipt["repo_path"])["entries"][0]["name"] == "train.py"
        install()  # Reuse the verified executable, restart the host without another upload.
        assert rpc("inspect_release", **identity, snapshot="linux-snapshot")["complete"]
        print("PASS Linux bootstrap: scoped installation, executable descriptor, host digest/handshake, real archive publication, file reads and cached restart")
    finally:
        child.stdin.close()
        child.wait(timeout=10)
        if child.returncode:
            raise RuntimeError(child.stderr.read())
