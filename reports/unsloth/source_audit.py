"""Reproducible, read-only source inventory; never imports the audited project."""
import argparse
import collections
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2] / "opensource" / "unsloth"
SOURCE = {".py", ".rs", ".ts", ".tsx", ".js", ".mjs", ".sh", ".ps1", ".bat"}


def inventory():
    paths = subprocess.check_output(["git", "ls-files"], cwd=str(ROOT)).decode().splitlines()
    groups = collections.defaultdict(lambda: {"files": 0, "source_files": 0, "source_lines": 0, "test_files": 0})
    files = []
    routes = []
    unreadable = []
    missing = []
    for relative in paths:
        path = ROOT / relative
        if not path.is_file():
            missing.append(relative)
            continue
        parts = Path(relative).parts
        group = "/".join(parts[:2]) if parts[0] == "studio" and len(parts) > 2 else parts[0] if len(parts) > 1 else "(root)"
        stat = groups[group]
        stat["files"] += 1
        if path.suffix not in SOURCE:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            unreadable.append({"path": relative, "error": str(error)})
            continue
        lines = content.splitlines()
        is_test = any(p in {"tests", "test"} for p in parts) or path.name.startswith("test_") or ".test." in path.name
        stat["source_files"] += 1
        stat["source_lines"] += len(lines)
        stat["test_files"] += int(is_test)
        files.append({"path": relative, "lines": len(lines), "test": is_test})
        if relative.startswith("studio/backend/") and path.suffix == ".py" and not is_test:
            for n, line in enumerate(lines, 1):
                if re.match(r"\s*@(\w+)\.(get|post|put|patch|delete|websocket)\(", line):
                    routes.append({"file": relative, "line": n, "decorator": line.strip()})
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(ROOT)).decode().strip()
    status = subprocess.check_output(["git", "status", "--short"], cwd=str(ROOT)).decode(errors="replace").splitlines()
    result = {"commit": commit, "method": "existing git tracked files; physical source lines including comments, blanks, tests and vendored code; routes are textual decorator occurrences, not expanded runtime endpoints", "groups": dict(sorted(groups.items())), "files": files, "route_decorators": routes, "missing": missing, "unreadable": unreadable, "worktree_status": status}
    target = Path(__file__).with_name("source-index.json")
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"commit": commit, "groups": result["groups"], "route_decorators": len(routes), "missing": missing, "unreadable": unreadable}, ensure_ascii=False, indent=2))


def excerpt(spec):
    name, start, count = spec.rsplit(":", 2)
    lines = (ROOT / name).read_text(encoding="utf-8", errors="replace").splitlines()
    first = int(start)
    print("\n" + name)
    for n in range(first, min(len(lines) + 1, first + int(count))):
        print("{}: {}".format(n, lines[n - 1]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("spec", nargs="*")
    args = parser.parse_args()
    if args.spec:
        for spec in args.spec:
            excerpt(spec)
    else:
        inventory()
