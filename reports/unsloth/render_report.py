"""Materialize the report's source links and generate a navigable module/API index."""
import collections
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1] / "opensource" / "unsloth"
REPORT = HERE / "Unsloth源码深度解读报告.md"
INDEX = json.loads((HERE / "source-index.json").read_text(encoding="utf-8"))
EMPTY_FILES = {entry["path"] for entry in INDEX["files"] if entry["lines"] == 0}


def link(name, line=1):
    if name in EMPTY_FILES:
        return "[{}]({})".format(name, (ROOT / name).as_posix())
    return "[{}:{}]({}:{})".format(name, line, (ROOT / name).as_posix(), line)


def stats():
    rows = ["| 目录 | 可读源码文件 | 物理源码行 | 识别出的测试文件 |",
            "|---|---:|---:|---:|"]
    for name, data in INDEX["groups"].items():
        if data["source_files"]:
            rows.append("| `{}` | {:,} | {:,} | {:,} |".format(
                name, data["source_files"], data["source_lines"], data["test_files"]))
    rows.append("| **合计** | **{:,}** | **{:,}** | **{:,}** |".format(
        sum(v["source_files"] for v in INDEX["groups"].values()),
        sum(v["source_lines"] for v in INDEX["groups"].values()),
        sum(v["test_files"] for v in INDEX["groups"].values())))
    return "<!-- SOURCE_STATS_START -->\n" + "\n".join(rows) + "\n<!-- SOURCE_STATS_END -->"


text = REPORT.read_text(encoding="utf-8")
text = text.replace("{{MODULE_STATS}}", stats())
text = re.sub(r"<!-- SOURCE_STATS_START -->.*?<!-- SOURCE_STATS_END -->", lambda _: stats(), text, flags=re.S)
text = re.sub(r"\[\[([^\]]+):(\d+)\]\]", lambda m: link(m[1], int(m[2])), text)
REPORT.write_text(text, encoding="utf-8")

groups = collections.defaultdict(list)
for entry in INDEX["files"]:
    name = entry["path"]
    if entry["test"]:
        continue
    parts = name.split("/")
    if name.startswith("studio/frontend/src/features/"):
        key = "/".join(parts[:5])
    elif name.startswith("studio/backend/core/"):
        key = "/".join(parts[:4]) if len(parts) > 4 else "studio/backend/core (顶层)"
    elif name.startswith("studio/backend/"):
        key = "/".join(parts[:3]) if len(parts) > 3 else "studio/backend (顶层)"
    elif name.startswith("studio/frontend/"):
        key = "/".join(parts[:3]) if len(parts) > 3 else "studio/frontend (顶层)"
    elif name.startswith("studio/src-tauri/"):
        key = "studio/src-tauri"
    else:
        key = "/".join(parts[:2]) if len(parts) > 2 else parts[0] if len(parts) > 1 else "(根目录)"
    groups[key].append(entry)

out = ["# Unsloth 模块与接口索引", "",
       "基准提交：`{}`。本索引由本地已跟踪源码生成，用于导航；文件名和规模不代替对实现的逐行审核。".format(INDEX["commit"]), "",
       "## 1. 统计与口径", "", stats(), "",
       "详细口径、缺失文件和工作树状态见 source-index.json。下表的非测试模块统计按路径归组；Rust 内嵌测试仍包含在文件行数中。", "",
       "## 2. 子模块导航", "",
       "每个目录列出源码文件数、物理行数和最多三个较大的文件；入口不一定是最大的文件，应结合主报告的调用链阅读。", "",
       "| 子模块 | 非测试源码文件 | 物理源码行 | 文件导航（按行数） |", "|---|---:|---:|---|"]
for name, entries in sorted(groups.items()):
    top = sorted(entries, key=lambda e: (-e["lines"], e["path"]))[:3]
    nav = "<br>".join("{}（{:,} 行）".format(link(e["path"]), e["lines"]) for e in top)
    out.append("| `{}` | {} | {:,} | {} |".format(name, len(entries), sum(e["lines"] for e in entries), nav))
out.extend(["", "## 3. 路由源码清单", "",
            "下面是路由装饰器出现位置，**不是展开前缀后的完整 URL 列表，也不是运行时注册/授权可用性的证明**。多行装饰器只展示首行，可点击定位完整声明；router 的挂载前缀见 backend/main.py。", "",
            "| 源码位置 | 装饰器首行 |", "|---|---|"])
for route in INDEX["route_decorators"]:
    decorator = route["decorator"].replace("|", "&#124;").replace("`", "&#96;")
    out.append("| {} | `{}` |".format(link(route["file"], route["line"]), decorator))
index_file = HERE / "模块与接口索引.md"
index_file.write_text("\n".join(out) + "\n", encoding="utf-8")

errors = []
cache = {}
count = 0
for doc in (REPORT, index_file):
    content = doc.read_text(encoding="utf-8")
    for m in re.finditer(r"\]\(([A-Z]:/[^\n)]+?)\)", content):
        target = m[1]
        parsed = re.match(r"^(.*):(\d+)$", target)
        filename, line = (parsed[1], int(parsed[2])) if parsed else (target, None)
        count += 1
        if filename not in cache:
            try:
                cache[filename] = len(Path(filename).read_text(encoding="utf-8").splitlines())
            except (OSError, UnicodeError) as error:
                errors.append("{}: {}".format(filename, error))
                cache[filename] = 0
        if line is not None and (line < 1 or line > cache[filename]):
            errors.append("{}:{} outside file".format(filename, line))
    if content.count("```") % 2:
        errors.append("{}: unpaired fenced code blocks".format(doc.name))
    if "[[" in content or "{{MODULE_STATS}}" in content:
        errors.append("{}: unresolved source marker".format(doc.name))
result = {"commit": INDEX["commit"], "checked_source_links": count, "linked_source_files": len(cache),
          "report_characters": len(REPORT.read_text(encoding="utf-8")), "module_groups": len(groups),
          "route_decorators": len(INDEX["route_decorators"]), "errors": errors,
          "validation_scope": "source link existence and line bounds, generated source markers, fenced block pairing; no project or GPU execution"}
(HERE / "report-validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(1 if errors else 0)
