"""Verify extracted build inputs against the already SHA-pinned Git archive."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile

archive, source = Path(sys.argv[1]), Path(sys.argv[2])
apply_patches = '--apply-patches' in sys.argv[3:]
patches = {}
patch_root = Path(__file__).resolve().parents[1] / 'patches'
lock = json.loads((patch_root.parent / 'upstream.lock.json').read_text())
for patch_file in sorted(patch_root.glob('*.json')):
    patch = json.loads(patch_file.read_text(encoding='utf-8'))
    if patch['upstream_commit'] != lock['commit']:
        raise RuntimeError('Patch baseline mismatch: ' + patch_file.name)
    for file in patch['files']:
        patches.setdefault(file['path'], []).extend(file['replacements'])
expected = set()
def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
    return result.digest()

with tarfile.open(archive, "r:") as snapshot:
    for member in snapshot:
        path = source / member.name
        if member.isdir():
            continue
        expected.add(member.name)
        if member.issym():
            if not path.is_symlink() or os.readlink(path) != member.linkname:
                raise RuntimeError("Source link differs from pinned archive: " + member.name)
        elif member.isfile():
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Source file type differs: " + member.name)
            original_bytes = snapshot.extractfile(member).read()
            desired = original_bytes
            for replacement in patches.get(member.name, []):
                old, new = replacement['old'].encode(), replacement['new'].encode()
                if desired.count(old) != 1:
                    raise RuntimeError('Patch context is not unique: ' + member.name)
                desired = desired.replace(old, new, 1)
            if apply_patches and member.name in patches:
                current = path.read_bytes()
                if current not in (original_bytes, desired):
                    raise RuntimeError('Refusing to overwrite unrecognized source edits: ' + member.name)
                if current != desired:
                    path.write_bytes(desired)
            original = hashlib.sha256(desired).digest()
            with path.open("rb") as actual:
                if digest(actual) != original:
                    raise RuntimeError("Source file differs from pinned archive: " + member.name)
        else:
            raise RuntimeError("Unsupported archive entry: " + member.name)
for directory, directories, files in os.walk(source):
    relative = Path(directory).relative_to(source).as_posix()
    if relative == "ui":
        directories[:] = [name for name in directories if name not in ("dist", "node_modules")]
    if relative == "ui/src":
        directories[:] = [name for name in directories if name != "paraglide"]
    if relative == "ui/project.inlang":
        # Inlang's compiler generates this cache; tracked settings are still
        # verified byte-for-byte against the archive above.
        directories[:] = [name for name in directories if name != "cache"]
    for name in files:
        path = (Path(directory) / name).relative_to(source).as_posix()
        generated = {".trainerbuddy-source.json", "ui/project.inlang/.gitignore",
                     "ui/project.inlang/.meta.json", "ui/project.inlang/README.md"}
        if path not in generated and path not in expected:
            raise RuntimeError("Unexpected file in pinned source: " + path)
if not set(patches).issubset(expected):
    raise RuntimeError('Patch names a file outside the pinned source archive')
print(json.dumps({"verified_source_files": len(expected), "patched_source_files": len(patches)}))
