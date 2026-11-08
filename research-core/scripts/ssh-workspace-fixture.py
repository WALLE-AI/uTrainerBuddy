"""Disposable Linux OpenSSH jail; no changes to system accounts or SSH config."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

runtime = Path('/tmp/trainerbuddy-research-runtime')
package = Path(sys.argv[1])
folder = Path(tempfile.mkdtemp(prefix='trainerbuddy-ssh-workspace-'))
jail = folder / 'jail'
workspace = jail / 'workspace'
env = {**os.environ, 'LD_LIBRARY_PATH': f'{runtime}/usr/lib:{runtime}/lib',
       'PATH': f'{runtime}/usr/bin:{runtime}/bin:' + os.environ.get('PATH', '')}
sshd = None
signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit(143))
def run(*args, **kwargs):
    return subprocess.run(args, env=env, check=True, capture_output=True, text=True, timeout=30, **kwargs).stdout
try:
    # APK roots contain real device nodes. Never copy devices as byte streams.
    shutil.copytree(runtime, jail, symlinks=True, ignore=lambda directory, names:
                    {'dev', 'proc', 'sys', 'run', 'tmp'} if Path(directory) == runtime else set())
    for name in ('proc', 'dev', 'var/empty', 'run', 'tmp', 'workspace/cargo/bin'):
        (jail / name).mkdir(parents=True, exist_ok=True)
    (jail / 'tmp').chmod(0o1777)
    shutil.copyfile('/bin/busybox', jail / 'bin/busybox')
    (jail / 'bin/busybox').chmod(0o755)
    for name in subprocess.check_output(['/bin/busybox', '--list'], text=True).splitlines():
        target = jail / 'bin' / name
        if not target.exists() and not target.is_symlink():
            target.symlink_to('/bin/busybox')
    for name, minor in [('null', 3), ('zero', 5), ('random', 8), ('urandom', 9)]:
        os.mknod(jail / 'dev' / name, stat.S_IFCHR | 0o666, os.makedev(1, minor))
        (jail / 'dev' / name).chmod(0o666)
    (jail / 'etc/passwd').write_text('root:x:0:0:root:/root:/bin/sh\nsshd:x:22:22:sshd:/var/empty:/sbin/nologin\nresearcher:x:65534:65534:researcher:/workspace:/bin/sh\n')
    (jail / 'etc/group').write_text('root:x:0:\nsshd:x:22:\nresearcher:x:65534:\n')
    # Invalid, non-locking hash: password login disabled; disposable keys only.
    (jail / 'etc/shadow').write_text('root:!:20000:0:99999:7:::\nsshd:!:20000:0:99999:7:::\nresearcher:x:20000:0:99999:7:::\n')
    (jail / 'etc/shadow').chmod(0o600)
    (jail / 'etc/profile').write_text('export PATH=/workspace/cargo/bin:/usr/bin:/bin:/usr/sbin\n')
    binary = workspace / 'cargo/bin/orx'
    shutil.copyfile(package / 'orx', binary)
    binary.chmod(0o700)
    for name in ('host', 'client', 'wrong'):
        run(str(runtime / 'usr/bin/ssh-keygen'), '-q', '-t', 'ed25519', '-N', '', '-f', str(workspace / name))
    repository = workspace / 'project'
    repository.mkdir()
    (repository / 'train.sh').write_text("#!/bin/bash\necho baseline-start\nsleep \"${1:-3}\"\necho metric.accuracy=0.75\n")
    def git(*args):
        run('chroot', str(jail), '/usr/bin/git', '-C', '/workspace/project', *args)
    git('init', '-q', '--initial-branch=main')
    git('config', 'user.name', 'Research fixture')
    git('config', 'user.email', 'fixture@invalid')
    git('add', '.')
    git('commit', '-qm', 'Fixture baseline')
    for directory, directories, files in os.walk(workspace):
        os.chown(directory, 65534, 65534)
        for name in files:
            os.chown(Path(directory) / name, 65534, 65534)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as network:
        network.connect(('192.0.2.1', 9))
        address = network.getsockname()[0]
    with socket.socket() as listener:
        listener.bind((address, 0))
        port = listener.getsockname()[1]
    (workspace / 'sshd.conf').write_text(f'''Port {port}
ListenAddress {address}
HostKey /workspace/host
PidFile /workspace/sshd.pid
AuthorizedKeysFile /workspace/client.pub
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
StrictModes yes
AllowUsers researcher
AllowTcpForwarding local
GatewayPorts no
PermitTunnel no
X11Forwarding no
PrintMotd no
LogLevel ERROR
SetEnv CARGO_HOME=/workspace/cargo ORX_DATA_DIR=/workspace/data ORX_CACHE_DIR=/workspace/cache XDG_CONFIG_HOME=/workspace/config ORX_RUN_ENGINE=1
''')
    boot = folder / 'start.sh'
    boot.write_text('set -eu\nmount --make-rprivate /\nmount -t proc proc "$1/proc"\nexec chroot "$1" /usr/sbin/sshd -D -e -f /workspace/sshd.conf\n')
    log = (folder / 'sshd.log').open('w+')
    jail_env = {**os.environ, 'LD_LIBRARY_PATH': '/usr/lib:/lib', 'PATH': '/usr/bin:/bin:/usr/sbin'}
    sshd = subprocess.Popen(['/usr/bin/unshare', '-m', '/bin/sh', str(boot), str(jail)], env=jail_env, stderr=log)
    for _ in range(100):
        if sshd.poll() is not None:
            log.seek(0)
            raise RuntimeError('Test sshd exited: ' + log.read())
        try:
            with socket.create_connection((address, port), timeout=.1):
                break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError('Test sshd startup timeout')
    print(json.dumps({'port': port, 'address': address, 'folder': str(workspace),
                      'binary': '/workspace/cargo/bin/orx', 'publicHostKey': (workspace / 'host.pub').read_text().strip()}), flush=True)
    sys.stdin.readline()
finally:
    try:
        if sshd is not None and sshd.poll() is None:
            prefix = ['/usr/bin/nsenter', '-t', str(sshd.pid), '-m', 'chroot', str(jail),
                      '/bin/su', '-s', '/bin/sh', 'researcher', '-c']
            command = 'export ORX_DATA_DIR=/workspace/data ORX_CACHE_DIR=/workspace/cache XDG_CONFIG_HOME=/workspace/config; /workspace/cargo/bin/orx remote-host '
            status = subprocess.run(prefix + [command + 'status'], text=True, capture_output=True, timeout=15)
            lines = [line.removeprefix('ORX_REMOTE_HOST=') for line in status.stdout.splitlines() if line.startswith('ORX_REMOTE_HOST=')]
            if lines:
                state = json.loads(lines[-1])
                if state.get('status') == 'status':
                    stop = {'expectedInstanceId': state['descriptor']['instanceId'], 'expectedPreview': state['preview']}
                    subprocess.run(prefix + [command + 'stop'], input=json.dumps(stop) + '\n',
                                   text=True, capture_output=True, check=True, timeout=20)
    finally:
        if sshd is not None and sshd.poll() is None:
            # Wrappers intentionally outlive SSH and the research core. Reap
            # only processes in this fixture's private mount namespace.
            namespace = os.readlink(f'/proc/{sshd.pid}/ns/mnt')
            owned = []
            for process in Path('/proc').iterdir():
                if not process.name.isdigit() or int(process.name) == sshd.pid:
                    continue
                try:
                    if os.readlink(process / 'ns/mnt') == namespace:
                        owned.append(int(process.name))
                        os.kill(int(process.name), signal.SIGTERM)
                except (FileNotFoundError, ProcessLookupError):
                    pass
            time.sleep(.2)
            for pid in owned:
                try:
                    if os.readlink(f'/proc/{pid}/ns/mnt') == namespace:
                        os.kill(pid, signal.SIGKILL)
                except (FileNotFoundError, ProcessLookupError):
                    pass
            sshd.terminate()
            sshd.wait(timeout=10)
        shutil.rmtree(folder)
