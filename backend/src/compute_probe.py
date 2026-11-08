# Executed only as a fixed SSH preflight script. CONFIG is a JSON string supplied by Rust.
import csv
import io
import json
import os
import platform
import shutil
import subprocess

config = json.loads(CONFIG)
workdir = config.get("workdir") or os.path.expanduser("~")
workdir = os.path.realpath(os.path.expanduser(workdir))
gpus = []
gpu_error = None
try:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=uuid,name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=8, check=True,
    )
    for row in csv.reader(io.StringIO(result.stdout)):
        uuid, name, total, free, driver = [cell.strip() for cell in row]
        gpus.append({"uuid": uuid, "name": name, "memory_total_mib": float(total), "memory_free_mib": float(free), "driver": driver})
except FileNotFoundError:
    gpu_error = "NVIDIA_SMI_MISSING"
except (OSError, subprocess.SubprocessError, ValueError):
    gpu_error = "GPU_PROBE_FAILED"

print(json.dumps({
    "protocol_version": 1,
    "hostname": platform.node(),
    "os": platform.system(),
    "arch": platform.machine(),
    "python": platform.python_version(),
    "gpus": gpus,
    "gpu_error": gpu_error,
    "workdir": {"path": workdir, "exists": os.path.isdir(workdir), "writable": os.path.isdir(workdir) and os.access(workdir, os.W_OK)},
    "host": {"installed": shutil.which("trainerbuddy-host") is not None, "protocol_version": None, "ready": False},
}))
