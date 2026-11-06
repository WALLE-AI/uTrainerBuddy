"""Generate a static interface index without importing DataFlow or its dependencies."""
from __future__ import annotations

import ast
import collections
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1] / "opensource" / "DataFlow"


def source_link(path: Path, line: int | None = None) -> str:
    import os
    rel = Path(os.path.relpath(path, OUT)).as_posix()
    return rel + (f"#L{line}" if line else "")


def methods(node: ast.ClassDef) -> dict:
    return {x.name: x for x in node.body if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef))}


def resolve_method(node: ast.ClassDef, name: str, classes: dict, seen=None):
    seen = set() if seen is None else seen
    if node.name in seen:
        return None
    seen.add(node.name)
    own = methods(node).get(name)
    if own:
        return own
    for base in node.bases:
        parent = classes.get(ast.unparse(base))
        if parent:
            result = resolve_method(parent, name, classes, seen)
            if result:
                return result
    return None


def declared_description(node):
    """Extract only constant returns in the zh branch. Never execute repository code."""
    method = methods(node).get("get_desc")
    if not method:
        return ""
    for stmt in method.body:
        if isinstance(stmt, ast.If) and "'zh'" in ast.unparse(stmt.test):
            for child in ast.walk(ast.Module(body=stmt.body, type_ignores=[])):
                if isinstance(child, ast.Return) and child.value:
                    try:
                        value = ast.literal_eval(child.value)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(value, (tuple, list)):
                        value = "\n".join(str(x) for x in value)
                    if isinstance(value, str):
                        return value
    return ""


parsed = {}
for path in sorted((ROOT / "dataflow").rglob("*.py")):
    if "scaffold" in path.parts:
        continue
    parsed[path] = ast.parse(path.read_text(encoding="utf-8-sig"))

entries = []
prompt_count = 0
for path, tree in parsed.items():
    classes = {x.name: x for x in tree.body if isinstance(x, ast.ClassDef)}
    for node in classes.values():
        decorators = [ast.unparse(x) for x in node.decorator_list]
        prompt_count += any("PROMPT_REGISTRY.register" in x for x in decorators)
        if not any("OPERATOR_REGISTRY.register" in x for x in decorators):
            continue
        relative = path.relative_to(ROOT / "dataflow" / "operators")
        entries.append({"domain": relative.parts[0], "path": path, "node": node,
                        "classes": classes, "category": relative.parts[1]})

counts = collections.Counter(x["domain"] for x in entries)
category_counts = collections.Counter(x["category"] for x in entries)
stats = {
    "analysis_date": "2026-11-06",
    "version_file": (ROOT / "dataflow/version.py").read_text(encoding="utf-8").splitlines()[0],
    "python_files_parsed_excluding_scaffold": len(parsed),
    "syntax_errors": 0,
    "registered_operator_classes": len(entries),
    "operators_by_domain": dict(sorted(counts.items())),
    "operators_by_category": dict(sorted(category_counts.items())),
    "registered_prompt_classes": prompt_count,
    "pipeline_python_files": len(list((ROOT / "dataflow/statics/pipelines").rglob("*.py"))),
    "test_files": len(list((ROOT / "test").rglob("test_*.py"))),
    "method": "AST only; explicit registration decorators; no package import or execution",
}
(OUT / "源码统计.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

lines = [
    "# DataFlow 完整算子接口索引", "",
    "本索引通过静态 AST 生成，未导入 DataFlow，未调用模型。配合[模块深度解读报告](./模块深度解读报告.md)阅读。", "",
    f"合计 **{len(entries)} 个显式注册算子，{len(counts)} 个领域**。只统计类装饰器注册；不是运行时注册成功数。", "",
    "每个条目列出定义位置、构造函数和 run 签名。若方法在同文件基类中定义，会列出继承的方法；未显示构造函数时请继续检查基类。", "",
    "“源码自述”来自 get_desc 的中文常量，仅为作者声明，可能不准确；“写入线索”只扫描 run 的直接语法，不追踪辅助函数，不构成完整输出契约。Python 返回值同样只列出静态表达式。", "",
    "## 领域分布", "", "| 领域 | 注册算子数 |", "|---|---:|",
]
for domain, count in sorted(counts.items()):
    lines.append(f"| {domain} | {count} |")
lines += ["", "## 分类分布", "", "| 目录分类 | 数量 |", "|---|---:|"]
for category, count in sorted(category_counts.items()):
    lines.append(f"| {category} | {count} |")

for domain in sorted(counts):
    lines += ["", f"## {domain}（{counts[domain]} 个）", ""]
    for entry in sorted((x for x in entries if x["domain"] == domain), key=lambda x: (x["category"], x["node"].name)):
        node, path, classes = entry["node"], entry["path"], entry["classes"]
        lines += [f"### {node.name}", "",
                  f"分类：`{entry['category']}`；[源码定义]({source_link(path, node.lineno)})。", ""]
        sigs = []
        for name in ["__init__", "run"]:
            method = resolve_method(node, name, classes)
            if method:
                sigs.append(f"{name}({ast.unparse(method.args)})")
        if sigs:
            lines += ["```python", "\n".join(sigs), "```", ""]
        description = declared_description(node)
        if description:
            # A short synopsis keeps this interface reference navigable.
            synopsis = " ".join(description.split())
            if len(synopsis) > 520:
                synopsis = synopsis[:520] + "……（完整说明见源码）"
            lines += ["源码自述：" + synopsis.replace("<", "&lt;").replace(">", "&gt;"), ""]
        run = resolve_method(node, "run", classes)
        if not run:
            lines += ["run 未在本文件及本文件基类中找到，请继续检查导入基类。", ""]
            continue
        write_calls, column_writes, returns = [], [], []
        for child in ast.walk(run):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute) and child.func.attr == "write":
                write_calls.append(ast.unparse(child))
            if isinstance(child, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                column_writes.extend(ast.unparse(x) for x in targets if isinstance(x, ast.Subscript))
            if isinstance(child, ast.Return):
                returns.append(ast.unparse(child.value) if child.value else "None")
        if column_writes:
            lines += ["直接赋值线索：`" + "`、`".join(dict.fromkeys(column_writes)) + "`。", ""]
        if write_calls:
            unique = list(dict.fromkeys(write_calls))
            lines += ["直接 write 调用：", "", "```python", "\n".join(unique), "```", ""]
        else:
            lines += ["run 中未发现直接 `.write(...)`；可能仅返回统计，也可能通过辅助函数写出，请沿调用链核实。", ""]
        lines += ["run 返回表达式：`" + "` / `".join(dict.fromkeys(returns or ["隐式 None"])) + "`。", ""]

(OUT / "算子完整索引.md").write_text("\n".join(lines), encoding="utf-8")
print(json.dumps(stats, ensure_ascii=False, indent=2))
print("Generated interface index and statistics.")
