# Read-only file protocol appended to the probe. Root is fixed at connection time.
import base64
import errno
import stat
import sys

root_path = os.path.realpath(workdir)
root_fd = None


def open_scoped(path, directory=False):
    global root_fd
    if not isinstance(path, str) or len(path) > 4096 or path.startswith("/") or "\x00" in path or ".." in path.split("/"):
        raise ValueError("PATH_OUTSIDE_WORKSPACE")
    if root_fd is None:
        root_fd = os.open(root_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    resolved = os.path.realpath(os.path.join(root_path, path))
    if os.path.commonpath([root_path, resolved]) != root_path:
        raise ValueError("PATH_OUTSIDE_WORKSPACE")
    relative = os.path.relpath(resolved, root_path)
    parts = [] if relative == "." else relative.split(os.sep)
    fd = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if directory or index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        if directory and not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise ValueError("NOT_A_DIRECTORY")
        if not directory and not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("UNSUPPORTED_FILE_TYPE")
        return fd
    except BaseException:
        os.close(fd)
        raise


def list_files(request):
    fd = open_scoped(request.get("path", ""), directory=True)
    try:
        entries = []
        truncated = False
        with os.scandir(fd) as listing:
            for entry in listing:
                if len(entries) == 10000:
                    truncated = True
                    break
                if any(0xD800 <= ord(c) <= 0xDFFF for c in entry.name):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                    if entry.is_symlink():
                        child_path = os.path.join(request.get("path", ""), entry.name)
                        try:
                            child_fd = open_scoped(child_path, directory=True)
                        except NotADirectoryError:
                            child_fd = open_scoped(child_path)
                        try:
                            info = os.fstat(child_fd)
                        finally:
                            os.close(child_fd)
                    kind = "dir" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "special"
                    entries.append({"name": entry.name, "type": kind, "size": info.st_size, "symlink": entry.is_symlink()})
                except (OSError, ValueError):
                    entries.append({"name": entry.name, "type": "special", "size": None, "symlink": entry.is_symlink()})
        entries.sort(key=lambda item: (item["type"] != "dir", item["name"]))
        cursor = request.get("cursor", 0)
        if not isinstance(cursor, int) or cursor < 0 or cursor > 10000:
            raise ValueError("INVALID_FILE_REQUEST")
        page = entries[cursor:cursor + 500]
        end = cursor + len(page)
        return {"entries": page, "next_cursor": end if end < len(entries) else None, "truncated": truncated, "root": root_path}
    finally:
        os.close(fd)


def read_file(request):
    path = request.get("path", "")
    fd = open_scoped(path)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        extension = os.path.splitext(path)[1].lower()
        media = extension in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif", ".pdf"}
        limit = 20 * 1024 * 1024 if media else 1024 * 1024
        if info.st_size > limit:
            raise ValueError("FILE_TOO_LARGE")
        data = source.read(limit + 1)
        if len(data) > limit:
            raise ValueError("FILE_TOO_LARGE")
        if not media:
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                raise ValueError("UNSUPPORTED_FILE_TYPE")
            if b"\x00" in data:
                raise ValueError("UNSUPPORTED_FILE_TYPE")
        return {"content_base64": base64.b64encode(data).decode("ascii"), "size": len(data), "modified_at": info.st_mtime, "path": path}


for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 8 * 1024 * 1024:
            raise ValueError("INVALID_FILE_REQUEST")
        request = json.loads(line)
        request_id = request.get("id")
        if request.get("op", "").startswith("host_"):
            data = host_bridge(request)
        elif request.get("op") == "list":
            data = list_files(request)
        elif request.get("op") == "read":
            data = read_file(request)
        else:
            raise ValueError("INVALID_FILE_REQUEST")
        response = {"id": request_id, "data": data}
    except FileNotFoundError:
        response = {"id": request_id, "error": "REMOTE_FILE_NOT_FOUND"}
    except PermissionError:
        response = {"id": request_id, "error": "REMOTE_FILE_PERMISSION_DENIED"}
    except NotADirectoryError:
        response = {"id": request_id, "error": "NOT_A_DIRECTORY"}
    except ValueError as error:
        allowed = {"PATH_OUTSIDE_WORKSPACE", "INVALID_FILE_REQUEST", "FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE", "NOT_A_DIRECTORY", "HOST_NOT_READY", "INVALID_HOST_RESPONSE", "UNSAFE_MANAGED_DIRECTORY", "INVALID_HOST_PACKAGE", "INVALID_OFFSET", "DIGEST_MISMATCH"}
        response = {"id": request_id, "error": str(error) if str(error) in allowed else "INVALID_FILE_REQUEST"}
    except OSError as error:
        response = {"id": request_id, "error": "PATH_OUTSIDE_WORKSPACE" if error.errno == errno.ELOOP else "REMOTE_FILE_IO_FAILED"}
    except Exception:
        response = {"id": request_id, "error": "REMOTE_FILE_IO_FAILED"}
    print(json.dumps(response), flush=True)
