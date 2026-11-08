# Bootstrap only: install a digest-verified Rust host, then relay its bounded protocol.
import atexit
import hashlib

host_process = None
install_fd = None
install_dir_fd = None
install_sha = None
install_size = 0
install_existing = False


def stop_host():
    global host_process
    if host_process is not None:
        host_process.terminate()
        try:
            host_process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            host_process.kill()
            host_process.wait()
        host_process = None


atexit.register(stop_host)


def host_bridge(request):
    global host_process, install_fd, install_dir_fd, install_sha, install_size, install_existing
    op = request.get("op")
    if op == "host_install_begin":
        digest = request.get("sha256", "")
        size = request.get("size", 0)
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest) or not isinstance(size, int) or size <= 0 or size > 64 * 1024 * 1024:
            raise ValueError("INVALID_HOST_PACKAGE")
        stop_host()
        if install_fd is not None:
            os.close(install_fd)
            install_fd = None
        if install_dir_fd is not None:
            os.close(install_dir_fd)
            install_dir_fd = None
        install_existing = False
        directory = open_scoped("", directory=True)
        try:
            for name in [".trainerbuddy", "hosts", digest]:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=directory)
                except FileExistsError:
                    pass
                next_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = next_fd
                info = os.fstat(directory)
                if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                    raise ValueError("UNSAFE_MANAGED_DIRECTORY")
            install_dir_fd = os.dup(directory)
            try:
                existing = os.open("trainerbuddy-host", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                info = os.fstat(existing)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_nlink != 1:
                    os.close(existing)
                    raise ValueError("UNSAFE_MANAGED_DIRECTORY")
                hasher = hashlib.sha256()
                while True:
                    chunk = os.read(existing, 65536)
                    if not chunk:
                        break
                    hasher.update(chunk)
                if info.st_size == size and hasher.hexdigest() == digest:
                    install_fd, install_sha, install_size, install_existing = existing, digest, size, True
                    return {"offset": size}
                os.close(existing)
            install_fd = os.open("host.part", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            info = os.fstat(install_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_nlink != 1:
                raise ValueError("UNSAFE_MANAGED_DIRECTORY")
            install_sha, install_size = digest, size
            if info.st_size > size:
                os.ftruncate(install_fd, 0)
            return {"offset": os.fstat(install_fd).st_size}
        finally:
            os.close(directory)
    if op == "host_install_chunk":
        if install_fd is None:
            raise ValueError("HOST_NOT_READY")
        offset = request.get("offset")
        data = base64.b64decode(request.get("bytes", ""), validate=True)
        length = os.fstat(install_fd).st_size
        if offset != length or len(data) > 256 * 1024 or length + len(data) > install_size:
            raise ValueError("INVALID_OFFSET")
        os.lseek(install_fd, offset, os.SEEK_SET)
        view = memoryview(data)
        while view:
            written = os.write(install_fd, view)
            view = view[written:]
        os.fsync(install_fd)
        return {"offset": os.fstat(install_fd).st_size}
    if op == "host_install_finish":
        if install_fd is None:
            raise ValueError("HOST_NOT_READY")
        os.lseek(install_fd, 0, os.SEEK_SET)
        hasher = hashlib.sha256()
        while True:
            data = os.read(install_fd, 65536)
            if not data:
                break
            hasher.update(data)
        if hasher.hexdigest() != install_sha or os.fstat(install_fd).st_size != install_size:
            os.ftruncate(install_fd, 0)
            raise ValueError("DIGEST_MISMATCH")
        if not install_existing:
            os.fchmod(install_fd, 0o700)
            os.fsync(install_fd)
            os.rename("host.part", "trainerbuddy-host", src_dir_fd=install_dir_fd, dst_dir_fd=install_dir_fd)
            os.fsync(install_dir_fd)
            # Linux refuses exec while a writable descriptor is open (ETXTBSY).
            os.close(install_fd)
            install_fd = os.open("trainerbuddy-host", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=install_dir_fd)
        root_handle = open_scoped("", directory=True)
        try:
            host_process = subprocess.Popen([f"/proc/self/fd/{install_fd}", "serve", "--root", f"/proc/self/fd/{root_handle}"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(install_fd, root_handle))
        finally:
            os.close(root_handle)
        return {"started": True}
    if op == "host_request":
        if host_process is None or host_process.poll() is not None:
            raise ValueError("HOST_NOT_READY")
        nested = request.get("request", {})
        nested["id"] = request.get("id")
        host_process.stdin.write(json.dumps(nested).encode("utf-8") + b"\n")
        host_process.stdin.flush()
        line = host_process.stdout.readline(8 * 1024 * 1024 + 1)
        if len(line) > 8 * 1024 * 1024 or not line.endswith(b"\n"):
            stop_host()
            raise ValueError("INVALID_HOST_RESPONSE")
        response = json.loads(line)
        if response.get("id") != nested["id"]:
            raise ValueError("INVALID_HOST_RESPONSE")
        if response.get("error"):
            return {"host_error": response["error"]}
        return response.get("data")
    raise ValueError("INVALID_FILE_REQUEST")
