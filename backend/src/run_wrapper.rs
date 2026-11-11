use anyhow::{anyhow, Context, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::process::Command;

pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", crate::chat::id()));
    use std::io::Write;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub async fn run(directory: &Path) -> Result<()> {
    let directory = directory.canonicalize()?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("wrapper.lock"))?;
    lock.try_lock_exclusive()
        .context("Run already has a wrapper")?;
    // Durable start fence: an uncertain/crashed launch is inspected, never repeated.
    let fence = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("started"))?;
    fence.sync_all()?;
    let spec: Value = serde_json::from_slice(&fs::read(directory.join("spec.json"))?)?;
    let start = crate::chat::now();
    // An internal error is not proof that the payload and all descendants exited.
    // Preserve the start fence and let the backend report unknown for inspection.
    let mut receipt = execute(&directory, &spec, start).await?;
    receipt["run_id"] = spec["id"].clone();
    receipt["spec_hash"] = spec["spec_hash"].clone();
    receipt["started_at"] = json!(start);
    receipt["finished_at"] = json!(crate::chat::now());
    write_json(&directory.join("receipt.json"), &receipt)?;
    Ok(())
}

async fn execute(directory: &Path, spec: &Value, start: u64) -> Result<Value> {
    if directory.join("cancel").exists() {
        return Ok(json!({"state":"cancelled","exit_code":null}));
    }
    let argv = spec["argv"]
        .as_array()
        .ok_or_else(|| anyhow!("Invalid argv"))?;
    let program = argv
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Missing executable"))?;
    let stdout = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(directory.join("output.log"))?;
    let stderr = stdout.try_clone()?;
    let mut command = Command::new(program);
    command
        .args(argv.iter().skip(1).map(|v| v.as_str().unwrap_or_default()))
        .current_dir(directory.join("source"))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .env(
            "TRAINERBUDDY_RUN_ID",
            spec["id"].as_str().unwrap_or_default(),
        )
        .env("TRAINERBUDDY_OUTPUT_DIR", directory.join("artifacts"))
        .env("TRAINERBUDDY_METRICS_FILE", directory.join("metrics.jsonl"))
        .env(
            "TRAINERBUDDY_EVALUATION_HASH",
            spec["evaluation_hash"].as_str().unwrap_or_default(),
        )
        .env(
            "TRAINERBUDDY_EVALUATION_SPEC",
            spec["evaluation"].to_string(),
        )
        .env("PYTHONUNBUFFERED", "1")
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .context("Cannot start the approved training command")?;
    let pid = child
        .id()
        .ok_or_else(|| anyhow!("Missing process identity"))?;
    let _group = match crate::harness::process_group::ProcessGroup::attach(pid) {
        Ok(group) => group,
        Err(error) => {
            child.kill().await?;
            child.wait().await?;
            return Err(error);
        }
    };
    write_json(
        &directory.join("running.json"),
        &json!({"run_id":spec["id"],"pid":pid,"wrapper_pid":std::process::id(),"started_at":start}),
    )?;
    let timer = Instant::now();
    let limit = Duration::from_secs(spec["timeout_seconds"].as_u64().unwrap_or(60));
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(
                json!({"state":if status.success(){"succeeded"}else{"failed"},"exit_code":status.code()}),
            );
        }
        let cancelled = directory.join("cancel").exists();
        if cancelled || timer.elapsed() >= limit {
            #[cfg(unix)]
            {
                let status = Command::new("kill")
                    .args(["-TERM", "--", &format!("-{pid}")])
                    .status()
                    .await?;
                if !status.success() && child.try_wait()?.is_none() {
                    return Err(anyhow!("Cannot terminate process group"));
                }
            }
            child.kill().await?;
            let status = child.wait().await?;
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .status()
                    .await;
            }
            // On Windows the job object closes before execute returns, terminating descendants.
            return Ok(
                json!({"state":if cancelled{"cancelled"}else{"failed"},"exit_code":status.code(),"error":if cancelled{None}else{Some("RUN_TIMEOUT")}}),
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
