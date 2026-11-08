"""Real, isolated Linux tests of the pinned core; no user workspace or Agent credentials."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading
import time

package = Path(__file__).resolve().parents[1] / "dist/linux-x86_64"
runtime = Path("/tmp/trainerbuddy-research-runtime")
with tempfile.TemporaryDirectory(prefix="trainerbuddy-core-") as temporary:
    folder = Path(temporary)
    binary = folder / "orx"
    shutil.copyfile(package / "orx", binary)
    binary.chmod(0o700)
    env = {**os.environ, "ORX_DATA_DIR": str(folder / "data"),
           "XDG_CONFIG_HOME": str(folder / "config"), "XDG_CACHE_HOME": str(folder / "cache"),
           "ORX_RUN_ENGINE": "1", "ORX_NO_TELEMETRY": "1",
           "PATH": f"{runtime}/usr/bin:{runtime}/bin:" + os.environ.get("PATH", ""),
           "LD_LIBRARY_PATH": f"{runtime}/usr/lib:{runtime}/lib",
           "GIT_EXEC_PATH": str(runtime / "usr/libexec/git-core"),
           "GIT_TEMPLATE_DIR": str(runtime / "usr/share/git-core/templates")}

    def command(*args, input=None):
        result = subprocess.run([str(binary), "--no-telemetry", *args], env=env, input=input,
                                text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, args, result.stdout, result.stderr)
        return result.stdout

    def marked(text):
        lines = [line[len("ORX_REMOTE_HOST="):] for line in text.splitlines() if line.startswith("ORX_REMOTE_HOST=")]
        assert lines, text
        return json.loads(lines[-1])

    attachment = None
    heartbeat_stop = threading.Event()
    def heartbeat():
        while not heartbeat_stop.wait(5):
            if attachment is not None:
                try:
                    attachment.stdin.write("ping\n")
                    attachment.stdin.flush()
                except (OSError, ValueError):
                    return
    heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
    try:
        descriptor = marked(command("remote-host", "ensure"))
        instance = descriptor["instanceId"]
        token = secrets.token_hex(32)
        attachment = subprocess.Popen([str(binary), "--no-telemetry", "remote-host", "attach", "--expected-instance", instance],
                                      env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        attachment.stdin.write(token + "\n")
        attachment.stdin.flush()
        assert attachment.stdout.readline().strip() == "ORX_REMOTE_ATTACHED=1"
        heartbeat_thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", descriptor["port"], timeout=15)

        def request(method, path, body=None, credential=None):
            credential = token if credential is None else credential
            headers = {"Authorization": "Bearer " + credential, "Content-Type": "application/json"}
            connection.request(method, path, None if body is None else json.dumps(body), headers)
            response = connection.getresponse()
            content = response.read()
            try:
                data = json.loads(content) if content else None
            except ValueError:
                data = content.decode("utf-8", errors="replace")
            return response.status, data

        status, health = request("GET", "/api/health")
        assert status == 200 and health["instanceId"] == instance and health["dashboardProtocol"] == 5, (status, health)
        dashboard_path = package / "dashboard.manifest.json"
        dashboard = json.loads(dashboard_path.read_text())
        for asset_path, expected in dashboard["files"].items():
            connection.request("GET", "/" + asset_path, headers={"Authorization": "Bearer " + token})
            response = connection.getresponse()
            asset = response.read()
            assert response.status == 200, asset_path
            assert len(asset) == expected["size"], asset_path
            assert hashlib.sha256(asset).hexdigest() == expected["sha256"], asset_path
        print(f"PASS embedded Linux dashboard: {len(dashboard['files'])} assets", flush=True)
        assert request("GET", "/api/projects")[0] == 200
        engine_status, engine = request("GET", "/api/settings/run-engine")
        assert engine_status == 200 and engine["enabled"] is True and engine["forcedBy"] is not None, (engine_status, engine)
        # Submit through the actual CLI/Engine; Git, snapshots and wrapper are not mocked.
        repository = folder / "project"
        repository.mkdir()
        def git(*args):
            return subprocess.run(["git", "-C", str(repository), *args], env=env, check=True,
                                  capture_output=True, text=True, timeout=15).stdout
        git("init", "-q", "--initial-branch=main")
        git("config", "user.name", "Core Test")
        git("config", "user.email", "test@invalid")
        (repository / "train.sh").write_text("printf 'baseline-start\\n'\nsleep 3\nprintf 'metric.accuracy=0.75\\n'\n")
        git("add", ".")
        git("commit", "-qm", "baseline")
        status, project = request("POST", "/api/projects", {"name": "Core baseline", "path": str(repository),
                                                           "runCommand": "bash train.sh", "githubSyncEnabled": False})
        assert status == 200, (status, project)
        project_id = project["project"]["id"]
        command("create-experiment", project_id, "--baseline", "--title", "Baseline", "--run-command", "bash train.sh")
        status, experiments = request("GET", f"/api/projects/{project_id}/experiments")
        assert status == 200 and len(experiments["experiments"]) == 1, (status, experiments)
        experiment_id = experiments["experiments"][0]["id"]
        command("exp", "run", experiment_id, "--backend", "local")
        status, runs = request("GET", f"/api/projects/{project_id}/runs")
        assert status == 200 and len(runs["runs"]) == 1, (status, runs)
        run_id = runs["runs"][0]["id"]
        print("Real experiment submitted: " + run_id, flush=True)
        status, _ = request("GET", "/api/projects", credential="incorrect-attachment")
        assert status in (401, 403), status
        attachment.stdin.close()
        attachment.wait(timeout=10)
        attachment = None
        second = marked(command("remote-host", "ensure", "--expected-instance", instance))
        assert second["instanceId"] == instance, "Detach must retain the persistent workspace instance"
        token = secrets.token_hex(32)
        attachment = subprocess.Popen([str(binary), "--no-telemetry", "remote-host", "attach", "--expected-instance", instance],
                                      env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        attachment.stdin.write(token + "\n")
        attachment.stdin.flush()
        assert attachment.stdout.readline().strip() == "ORX_REMOTE_ATTACHED=1"
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status, detail = request("GET", f"/api/runs/{run_id}")
            assert status == 200, (status, detail)
            run = detail["run"]
            if run["status"] in ("done", "failed", "cancelled", "lost"):
                assert run["status"] == "done", run
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Real experiment did not settle: " + json.dumps(detail))
        log = command("logs", run_id)
        assert "metric.accuracy=0.75" in log, log
        assert len(request("GET", f"/api/projects/{project_id}/runs")[1]["runs"]) == 1
        print("PASS pinned Linux research core: identity/protocol, attachment authentication, real Git experiment, native Local Engine/wrapper execution, detach/reattach, one original run and collected log")
    finally:
        heartbeat_stop.set()
        if attachment:
            attachment.stdin.close()
            attachment.wait(timeout=10)
        try:
            state = marked(command("remote-host", "status"))
            if state.get("status") == "status":
                stop = {"expectedInstanceId": state["descriptor"]["instanceId"], "expectedPreview": state["preview"]}
                command("remote-host", "stop", input=json.dumps(stop) + "\n")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        command("remote-host", "status")
                    except subprocess.CalledProcessError:
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Isolated core did not stop within its cleanup budget")
        except (subprocess.CalledProcessError, AssertionError, KeyError) as error:
            raise RuntimeError("Isolated core shutdown needs inspection: " + str(error)) from error
