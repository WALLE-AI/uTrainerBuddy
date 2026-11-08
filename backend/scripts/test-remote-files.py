"""Run on Linux: python backend/scripts/test-remote-files.py."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if sys.platform != "linux":
    raise SystemExit("This test requires Linux directory-fd semantics")

source = Path(__file__).resolve().parents[1] / "src"
with tempfile.TemporaryDirectory(prefix="trainer-files-") as temporary:
    root = Path(temporary) / "workspace"
    root.mkdir()
    (root / "nested").mkdir()
    (root / "bulk").mkdir()
    text = "hello \u4e2d\u6587\n"
    (root / "nested" / "data.jsonl").write_text(text, encoding="utf-8")
    unusual = "quote'; $(touch injected).txt"
    (root / unusual).write_text("literal path", encoding="utf-8")
    (root / "empty.txt").touch()
    (root / "binary.bin").write_bytes(b"\x00\xff")
    with (root / "large.txt").open("wb") as f:
        f.truncate(1024 * 1024 + 1)
    with (root / "large.png").open("wb") as f:
        f.truncate(20 * 1024 * 1024 + 1)
    (root / "small.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (root / "private.txt").write_text("private", encoding="utf-8")
    (root / "private.txt").chmod(0)
    (Path(temporary) / "secret.txt").write_text("outside", encoding="utf-8")
    os.symlink(root / "nested" / "data.jsonl", root / "inside-link.txt")
    os.symlink(Path(temporary) / "secret.txt", root / "outside-link.txt")
    os.symlink(Path(temporary), root / "outside-dir")
    os.mkfifo(root / "pipe")
    for index in range(501):
        (root / "bulk" / f"file-{index:04d}.txt").touch()
    config = {"workdir": str(root)}
    script = "CONFIG = " + json.dumps(json.dumps(config)) + "\n" + (source / "compute_probe.py").read_text(encoding="utf-8") + "\n" + (source / "remote_files.py").read_text(encoding="utf-8")
    child = subprocess.Popen([sys.executable, "-u", "-c", "import sys; exec(sys.stdin.readline())"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        child.stdin.write("exec(" + json.dumps(script) + ")\n")
        child.stdin.flush()
        snapshot = json.loads(child.stdout.readline())
        assert snapshot["workdir"]["exists"]
        sequence = 0

        def request(op, path="", cursor=0, error=None):
            global sequence
            sequence += 1
            child.stdin.write(json.dumps({"id": sequence, "op": op, "path": path, "cursor": cursor}) + "\n")
            child.stdin.flush()
            response = json.loads(child.stdout.readline())
            assert response["id"] == sequence
            if error:
                assert response.get("error") == error, response
                return None
            assert "error" not in response, response
            return response["data"]

        listing = request("list")
        names = {entry["name"] for entry in listing["entries"]}
        assert unusual in names and "nested" in names
        assert base64.b64decode(request("read", "nested/data.jsonl")["content_base64"]).decode() == text
        assert base64.b64decode(request("read", "inside-link.txt")["content_base64"]).decode() == text
        assert base64.b64decode(request("read", unusual)["content_base64"]) == b"literal path"
        assert request("read", "empty.txt")["size"] == 0
        assert base64.b64decode(request("read", "small.png")["content_base64"]).startswith(b"\x89PNG")
        request("read", "../secret.txt", error="PATH_OUTSIDE_WORKSPACE")
        request("read", "/etc/passwd", error="PATH_OUTSIDE_WORKSPACE")
        request("read", "outside-link.txt", error="PATH_OUTSIDE_WORKSPACE")
        request("list", "outside-dir", error="PATH_OUTSIDE_WORKSPACE")
        request("read", "missing.txt", error="REMOTE_FILE_NOT_FOUND")
        request("read", "large.txt", error="FILE_TOO_LARGE")
        request("read", "large.png", error="FILE_TOO_LARGE")
        request("read", "binary.bin", error="UNSUPPORTED_FILE_TYPE")
        request("read", "pipe", error="UNSUPPORTED_FILE_TYPE")
        request("read", "nested", error="UNSUPPORTED_FILE_TYPE")
        request("list", "empty.txt", error="NOT_A_DIRECTORY")
        if os.getuid() != 0:
            request("read", "private.txt", error="REMOTE_FILE_PERMISSION_DENIED")
        first = request("list", "bulk")
        assert len(first["entries"]) == 500 and first["next_cursor"] == 500
        second = request("list", "bulk", first["next_cursor"])
        assert len(second["entries"]) == 1 and second["next_cursor"] is None
        assert not (root / "injected").exists()
        print("PASS Linux file protocol: directory paging, UTF-8, literal paths, text/image reads, permission errors, symlink boundaries, large/binary/special file limits")
    finally:
        child.stdin.close()
        child.wait(timeout=5)
        if child.returncode:
            raise RuntimeError(child.stderr.read())
