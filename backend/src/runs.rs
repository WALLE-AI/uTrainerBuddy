use crate::{chat, store::Store};
use anyhow::{anyhow, bail, Result};
use axum::http::Method;
use fs2::FileExt;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn checked_child(directory: &Path, name: &str) -> Result<PathBuf> {
    let path = directory.join(name);
    if fs::symlink_metadata(&path)?.file_type().is_symlink()
        || path.canonicalize()?.parent() != Some(directory.canonicalize()?.as_path())
    {
        bail!("INVALID_RUN_EVIDENCE_PATH");
    }
    Ok(path)
}
fn command_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}
fn read_metrics(directory: &Path, run_id: &str) -> Result<(Vec<Value>, Option<String>)> {
    let path = directory.join("metrics.jsonl");
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((vec![], None)),
        Err(e) => return Err(e.into()),
    };
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        bail!("INVALID_METRIC_FILE");
    }
    if file.metadata()?.len() > 2 * 1024 * 1024 {
        return Ok((
            vec![],
            Some("Metrics exceed the 2 MiB collection limit".into()),
        ));
    }
    let mut raw = String::new();
    file.read_to_string(&mut raw)?;
    let mut metrics = vec![];
    let mut error = None;
    if !raw.is_empty() && !raw.ends_with('\n') {
        error = Some("Partial final metric record".into());
    }
    for line in raw
        .split_inclusive('\n')
        .filter(|l| l.ends_with('\n') && !l.trim().is_empty())
    {
        match serde_json::from_str::<Value>(line) {
            Ok(m)
                if m["schema_version"] == 1
                    && m["run_id"] == run_id
                    && m["value"].as_f64().is_some_and(f64::is_finite)
                    && m["metric"].is_string()
                    && m["step"].as_u64().is_some()
                    && matches!(m["stage"].as_str(), Some("train" | "evaluate" | "setup")) =>
            {
                metrics.push(m)
            }
            _ => error = Some("Invalid metric schema, value or run identity".into()),
        }
        if metrics.len() > 10000 {
            return Ok((
                vec![],
                Some("Metrics exceed the 10000 record collection limit".into()),
            ));
        }
    }
    Ok((metrics, error))
}
fn text<'a>(body: &'a Value, field: &str) -> Result<&'a str> {
    body[field]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 4096 && !v.contains('\0'))
        .ok_or_else(|| anyhow!("INVALID_RUN_REQUEST"))
}
fn safe_id(id: &str) -> Result<&str> {
    trainerbuddy_host::id(id)
}
fn operation_lock(root: &Path) -> Result<fs::File> {
    let directory = root.join(".trainerbuddy");
    fs::create_dir_all(&directory)?;
    if fs::symlink_metadata(&directory)?.file_type().is_symlink()
        || !directory.canonicalize()?.starts_with(root.canonicalize()?)
    {
        bail!("PATH_OUTSIDE_WORKSPACE");
    }
    let path = directory.join("research.lock");
    if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
        bail!("PATH_OUTSIDE_WORKSPACE");
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow!("RESEARCH_OPERATION_BUSY"))?;
    Ok(lock)
}
fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command.current_dir(root).args(args).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output()?;
    if !output.status.success() {
        bail!(
            "Git operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}
pub async fn scope(store: &Store, project: &str, conversation: &str) -> Result<PathBuf> {
    let c = store
        .conversation(conversation)
        .await?
        .ok_or_else(|| anyhow!("NOT_FOUND"))?;
    if c["project_id"] != project {
        bail!("NOT_FOUND");
    }
    let p = crate::project_sync::project(store, project).await?;
    Ok(PathBuf::from(
        p["local_root"]
            .as_str()
            .ok_or_else(|| anyhow!("PROJECT_DIRECTORY_REQUIRED"))?,
    )
    .canonicalize()?)
}
async fn record(
    store: &Store,
    table: &'static str,
    project: &str,
    conversation: &str,
    id: &str,
) -> Result<Value> {
    let (project, conversation, id) = (
        project.to_string(),
        conversation.to_string(),
        id.to_string(),
    );
    store.call(move |db| {
        let raw: Option<String> = db.query_row(&format!("SELECT body FROM {table} WHERE id=? AND project_id=? AND conversation_id=?"), params![id,project,conversation], |r|r.get(0)).optional()?;
        Ok(serde_json::from_str(&raw.ok_or_else(|| anyhow!("NOT_FOUND"))?)?)
    }).await
}
async fn previous(
    store: &Store,
    table: &'static str,
    project: &str,
    conversation: &str,
    body: &Value,
) -> Result<Option<Value>> {
    let (project, conversation, body) =
        (project.to_string(), conversation.to_string(), body.clone());
    let request = text(&body, "request_id")?.to_string();
    store.call(move |db| {
        let prior: Option<(String,String)> = db.query_row(&format!("SELECT request,body FROM {table} WHERE project_id=? AND conversation_id=? AND request_id=?"),params![project,conversation,request],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((old, value)) = prior { if serde_json::from_str::<Value>(&old)? != body { bail!("IDEMPOTENCY_CONFLICT"); } return Ok(Some(serde_json::from_str(&value)?)); }
        Ok(None)
    }).await
}
pub async fn create_experiment(
    store: &Store,
    project: &str,
    conversation: &str,
    body: Value,
) -> Result<Value> {
    let root = scope(store, project, conversation).await?;
    let _operation = operation_lock(&root)?;
    if let Some(v) = previous(store, "experiments", project, conversation, &body).await? {
        return Ok(v);
    }
    let title = text(&body, "title")?.to_string();
    let parent = if let Some(parent) = body["parent_id"].as_str() {
        Some(record(store, "experiments", project, conversation, parent).await?)
    } else {
        None
    };
    let base_root = parent
        .as_ref()
        .and_then(|p| p["worktree"].as_str())
        .map(PathBuf::from)
        .unwrap_or(root.clone());
    let commit = git(&base_root, &["rev-parse", "HEAD"])?;
    let id = chat::id();
    let directory = root.join(".trainerbuddy").join("experiments").join(&id);
    let parent_dir = directory.parent().unwrap();
    fs::create_dir_all(parent_dir)?;
    if !parent_dir.canonicalize()?.starts_with(&root) {
        bail!("PATH_OUTSIDE_WORKSPACE");
    }
    let exclude = git(&root, &["rev-parse", "--git-path", "info/exclude"])?;
    let exclude = root.join(exclude);
    let mut ignored = match fs::read_to_string(&exclude) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    if !ignored.lines().any(|line| line == "/.trainerbuddy/") {
        ignored.push_str("\n/.trainerbuddy/\n");
        fs::write(exclude, ignored)?;
    }
    let branch = format!("buddy/{id}");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &command_path(&directory),
            &commit,
        ],
    )?;
    let value = json!({"id":id,"project_id":project,"conversation_id":conversation,"title":title,"parent_id":body["parent_id"],"branch":branch,"worktree":directory,"base_commit":commit,"created_at":chat::now()});
    let saved = value.clone();
    let conversation = conversation.to_string();
    store.call(move |db| {
        db.execute("INSERT INTO experiments(id,project_id,conversation_id,request_id,request,body) VALUES(?,?,?,?,?,?)",params![saved["id"].as_str(),saved["project_id"].as_str(),conversation,body["request_id"].as_str(),body.to_string(),saved.to_string()])?;
        Ok(())
    }).await?;
    Ok(value)
}

pub async fn prepare(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    body: Value,
) -> Result<Value> {
    let root = scope(store, project, conversation).await?;
    let _operation = operation_lock(&root)?;
    if let Some(v) = previous(store, "runs", project, conversation, &body).await? {
        return Ok(v);
    }
    let exp = record(
        store,
        "experiments",
        project,
        conversation,
        text(&body, "experiment_id")?,
    )
    .await?;
    let plan = crate::research_documents::execute(
        store,
        project,
        conversation,
        "read",
        json!({"id":text(&body,"plan_id")?}),
    )
    .await?;
    if plan["sha256"] != body["plan_hash"] {
        bail!("PLAN_CONFLICT");
    }
    let argv = body["argv"]
        .as_array()
        .filter(|a| {
            !a.is_empty()
                && a.len() <= 64
                && a.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
                })
        })
        .ok_or_else(|| anyhow!("INVALID_RUN_ARGV"))?;
    let timeout = body["timeout_seconds"]
        .as_u64()
        .filter(|n| *n >= 1 && *n <= 3600)
        .ok_or_else(|| anyhow!("INVALID_RUN_TIMEOUT"))?;
    let evaluation = body.get("evaluation").cloned().unwrap_or(Value::Null);
    if !evaluation.is_null() {
        crate::evaluation::validate(&evaluation)?;
    }
    let cwd = PathBuf::from(text(&exp, "worktree")?);
    let snapshot_root = cwd.clone();
    let snapshot_data = data_dir.to_path_buf();
    let snapshot = tokio::task::spawn_blocking(move || {
        crate::project_sync::preview(&snapshot_root, &snapshot_data, None)
    })
    .await??;
    if snapshot["can_publish"] != true {
        bail!("EXPERIMENT_HAS_UNCOMMITTED_CHANGES");
    }
    if !evaluation.is_null()
        && !snapshot["manifest"].as_array().is_some_and(|files| {
            files
                .iter()
                .any(|file| file["sha256"] == evaluation["evaluator_sha256"])
        })
    {
        bail!("EVALUATOR_NOT_IN_SNAPSHOT");
    }
    let exp_id = text(&exp, "id")?.to_string();
    let current_commit = snapshot["commit"].clone();
    let argv_fixed = json!(argv);
    let plan_id = plan["id"].clone();
    let fixed_evaluation = evaluation.clone();
    store
        .call(move |db| {
            let mut stmt =
                db.prepare("SELECT body FROM runs WHERE experiment_id=? ORDER BY rowid")?;
            for row in stmt.query_map([exp_id], |r| r.get::<_, String>(0))? {
                let old: Value = serde_json::from_str(&row?)?;
                if old["argv"] != argv_fixed
                    || old["plan"]["id"] != plan_id
                    || old["evaluation"] != fixed_evaluation
                {
                    bail!("EXPERIMENT_RECIPE_CHANGED_CREATE_CHILD");
                }
                if old["state"] == "succeeded" && old["snapshot"]["commit"] != current_commit {
                    bail!("EXPERIMENT_FROZEN_CREATE_CHILD");
                }
            }
            Ok(())
        })
        .await?;
    let id = chat::id();
    let directory = data_dir.join("runs").join(&id);
    fs::create_dir_all(directory.join("source"))?;
    fs::create_dir(directory.join("artifacts"))?;
    // archive_manifest has already rejected unsafe paths, links, credentials and unsupported entries.
    let mut unpack = Command::new("tar");
    unpack
        .args([
            "-xf",
            &command_path(Path::new(snapshot["archive_path"].as_str().unwrap())),
            "-C",
            &command_path(&directory.join("source")),
        ])
        .stdin(Stdio::null());
    #[cfg(windows)]
    unpack.creation_flags(0x08000000);
    if !unpack.output()?.status.success() {
        bail!("RUN_SNAPSHOT_EXTRACT_FAILED");
    }
    let mut spec = json!({"id":id,"project_id":project,"conversation_id":conversation,"experiment_id":exp["id"],"title":exp["title"],"plan":plan,"snapshot":snapshot,"argv":argv,"timeout_seconds":timeout,"target":"local","created_at":chat::now()});
    if !evaluation.is_null() {
        spec["evaluation_hash"] = json!(crate::evaluation::hash(&evaluation));
        spec["evaluation"] = evaluation;
    }
    spec["spec_hash"] = json!(hash(serde_json::to_string(&spec)?.as_bytes()));
    crate::run_wrapper::write_json(&directory.join("spec.json"), &spec)?;
    let mut value = spec.clone();
    value["state"] = json!("prepared");
    value["evidence_state"] = json!("pending");
    let saved = value.clone();
    store.call(move|db| {
        db.execute("INSERT INTO runs(id,project_id,conversation_id,experiment_id,request_id,request,body) VALUES(?,?,?,?,?,?,?)",params![saved["id"].as_str(),saved["project_id"].as_str(),saved["conversation_id"].as_str(),saved["experiment_id"].as_str(),body["request_id"].as_str(),body.to_string(),saved.to_string()])?;
        Ok(())
    }).await?;
    Ok(value)
}

pub async fn launch(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    id: &str,
    spec_hash: &str,
) -> Result<Value> {
    let value = record(store, "runs", project, conversation, id).await?;
    if value["spec_hash"] != spec_hash {
        bail!("RUN_SPEC_CHANGED");
    }
    if value["state"] != "prepared" {
        return Ok(value);
    }
    let directory = data_dir.join("runs").join(safe_id(id)?);
    let disk: Value = serde_json::from_slice(&fs::read(directory.join("spec.json"))?)?;
    let mut signed = disk.clone();
    signed.as_object_mut().unwrap().remove("spec_hash");
    if hash(serde_json::to_string(&signed)?.as_bytes()) != spec_hash || disk["id"] != id {
        bail!("RUN_SPEC_CHANGED");
    }
    // Verify the extracted executable snapshot immediately before accepting approval.
    for entry in disk["snapshot"]["manifest"]
        .as_array()
        .ok_or_else(|| anyhow!("INVALID_SNAPSHOT"))?
    {
        let path = directory.join("source").join(
            entry["path"]
                .as_str()
                .ok_or_else(|| anyhow!("INVALID_SNAPSHOT"))?,
        );
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            bail!("RUN_SOURCE_CHANGED");
        }
        if hash(&fs::read(&path)?) != entry["sha256"].as_str().unwrap_or_default() {
            bail!("RUN_SOURCE_CHANGED");
        }
    }
    fn count_files(path: &Path) -> Result<usize> {
        let mut count = 0;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                bail!("RUN_SOURCE_CHANGED");
            }
            if kind.is_dir() {
                count += count_files(&entry.path())?;
            } else if kind.is_file() {
                count += 1;
            } else {
                bail!("RUN_SOURCE_CHANGED");
            }
        }
        Ok(count)
    }
    if count_files(&directory.join("source"))?
        != disk["snapshot"]["manifest"].as_array().unwrap().len()
    {
        bail!("RUN_SOURCE_CHANGED");
    }
    let mut next = value;
    next["state"] = json!("preparing");
    next["authorized_at"] = json!(chat::now());
    let saved = next.clone();
    let claimed = store.call(move |db| {
        let tx = db.transaction()?;
        let current: String = tx.query_row("SELECT body FROM runs WHERE id=?",[saved["id"].as_str()],|r|r.get(0))?;
        if serde_json::from_str::<Value>(&current)?["state"] != "prepared" { return Ok(false); }
        crate::research_control::require_active(&tx,saved["project_id"].as_str().unwrap_or_default(),saved["conversation_id"].as_str().unwrap_or_default())?;
        let busy:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE json_extract(body,'$.state') IN ('preparing','running','cancelling','unknown'))",[],|r|r.get(0))?;
        if busy { bail!("LOCAL_COMPUTE_BUSY"); }
        tx.execute("UPDATE runs SET body=? WHERE id=?",params![saved.to_string(),saved["id"].as_str()])?;
        tx.execute("INSERT INTO run_events(project_id,run_id,body) VALUES(?,?,?)",params![saved["project_id"].as_str(),saved["id"].as_str(),json!({"kind":"run.submitted","run_id":saved["id"],"at":chat::now()}).to_string()])?;
        tx.commit()?; Ok(true)
    }).await?;
    if claimed {
        let diagnostic = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("wrapper.log"))?;
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("--run-wrapper")
            .arg(&directory)
            .stdin(Stdio::null())
            .stdout(diagnostic.try_clone()?)
            .stderr(diagnostic);
        #[cfg(windows)]
        command.creation_flags(0x08000000 | 0x00000200);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        if let Err(error) = command.spawn() {
            crate::run_wrapper::write_json(
                &directory.join("receipt.json"),
                &json!({"run_id":id,"spec_hash":spec_hash,"state":"failed","exit_code":null,"error":format!("Cannot start run wrapper: {error}"),"finished_at":chat::now()}),
            )?;
        }
    }
    Ok(next)
}

pub async fn refresh(store: &Store, data_dir: &Path, value: Value) -> Result<Value> {
    if !matches!(
        value["state"].as_str(),
        Some("preparing" | "running" | "cancelling" | "unknown")
    ) {
        return Ok(value);
    }
    let dir = data_dir.join("runs").join(safe_id(text(&value, "id")?)?);
    let mut next = value.clone();
    if dir.join("receipt.json").exists() {
        let receipt: Value = serde_json::from_slice(&fs::read(dir.join("receipt.json"))?)?;
        if receipt["run_id"] != value["id"] || receipt["spec_hash"] != value["spec_hash"] {
            bail!("INVALID_RUN_RECEIPT");
        }
        if !matches!(
            receipt["state"].as_str(),
            Some("succeeded" | "failed" | "cancelled")
        ) {
            bail!("INVALID_RUN_RECEIPT");
        }
        next["state"] = receipt["state"].clone();
        next["receipt"] = receipt;
        let (metrics, mut error) = read_metrics(&dir, text(&value, "id")?)?;
        if !value["evaluation"].is_null() {
            if let Err(e) = crate::evaluation::final_metric(&value, &metrics) {
                error = Some(e.to_string());
            }
        }
        let ready = next["state"] != "succeeded"
            || (error.is_none() && metrics.iter().any(|m| m["stage"] == "evaluate"));
        next["evidence_state"] = json!(if ready { "ready" } else { "incomplete" });
        if !ready {
            next["evidence_error"] =
                json!(error.unwrap_or("No final evaluation metric was recorded".into()));
        }
    } else {
        let locked = match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.join("wrapper.lock"))
        {
            Ok(file) => match file.try_lock_exclusive() {
                Ok(()) => false,
                Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => true,
                Err(e) => return Err(e.into()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        if locked && dir.join("running.json").exists() {
            if next["state"] != "cancelling" {
                next["state"] = json!("running");
            }
        } else if !locked
            && chat::now().saturating_sub(value["authorized_at"].as_u64().unwrap_or(0)) > 15000
        {
            next["state"] = json!("unknown");
            next["error"] = json!("Wrapper is not reachable and no exit receipt exists. Inspect the original task; it will not be relaunched.");
        }
    }
    if next != value {
        let saved = next.clone();
        let old = value.to_string();
        store.call(move|db| {
            let tx=db.transaction()?;
            if tx.execute("UPDATE runs SET body=? WHERE id=? AND body=?",params![saved.to_string(),saved["id"].as_str(),old])? == 1 {
                tx.execute("INSERT INTO run_events(project_id,run_id,body) VALUES(?,?,?)",params![saved["project_id"].as_str(),saved["id"].as_str(),json!({"kind":"run.state","run_id":saved["id"],"state":saved["state"],"at":chat::now()}).to_string()])?;
                if matches!(saved["evidence_state"].as_str(),Some("ready"|"incomplete")) {
                    tx.execute("INSERT OR IGNORE INTO run_notices(run_id,conversation_id,status,body) VALUES(?,?,'pending',?)",params![saved["id"].as_str(),saved["conversation_id"].as_str(),json!({"run_id":saved["id"],"state":saved["state"],"evidence_state":saved["evidence_state"],"evidence_error":saved["evidence_error"],"spec_hash":saved["spec_hash"]}).to_string()])?;
                }
            }
            tx.commit()?; Ok(())
        }).await?;
    }
    record(
        store,
        "runs",
        text(&next, "project_id")?,
        text(&next, "conversation_id")?,
        text(&next, "id")?,
    )
    .await
}

pub async fn get(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    id: &str,
) -> Result<Value> {
    refresh(
        store,
        data_dir,
        record(store, "runs", project, conversation, id).await?,
    )
    .await
}
pub async fn list(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    table: &'static str,
) -> Result<Value> {
    scope(store, project, conversation).await?;
    let (project, conversation) = (project.to_string(), conversation.to_string());
    let values=store.call(move|db| {
        let mut stmt=db.prepare(&format!("SELECT body FROM {table} WHERE project_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 200"))?;
        let rows=stmt.query_map(params![project,conversation],|r|r.get::<_,String>(0))?;
        rows.map(|r|Ok(serde_json::from_str::<Value>(&r?)?)).collect::<Result<Vec<_>>>()
    }).await?;
    let mut results = vec![];
    for value in values {
        results.push(if table == "runs" {
            refresh(store, data_dir, value).await?
        } else {
            value
        });
    }
    Ok(json!(results))
}
pub async fn cancel(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    id: &str,
) -> Result<Value> {
    let mut value = get(store, data_dir, project, conversation, id).await?;
    if matches!(
        value["state"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        return Ok(value);
    }
    value["state"] = json!(if value["state"] == "prepared" {
        "cancelled"
    } else {
        "cancelling"
    });
    fs::write(
        data_dir.join("runs").join(safe_id(id)?).join("cancel"),
        b"cancel",
    )?;
    let saved = value.clone();
    store.call(move|db| {db.execute("UPDATE runs SET body=? WHERE id=? AND json_extract(body,'$.state') NOT IN ('succeeded','failed','cancelled')",params![saved.to_string(),saved["id"].as_str()])?;Ok(())}).await?;
    get(store, data_dir, project, conversation, id).await
}
pub async fn evidence(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    id: &str,
    offset: u64,
) -> Result<Value> {
    let run = get(store, data_dir, project, conversation, id).await?;
    let dir = data_dir.join("runs").join(safe_id(id)?);
    let (log, next_offset) = if dir.join("output.log").exists() {
        let path = checked_child(&dir, "output.log")?;
        if !fs::metadata(&path)?.is_file() {
            bail!("INVALID_RUN_EVIDENCE_PATH");
        }
        let mut f = fs::File::open(path)?;
        let start = offset.min(f.metadata()?.len());
        f.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![];
        f.take(65536).read_to_end(&mut bytes)?;
        (
            String::from_utf8_lossy(&bytes).to_string(),
            start + bytes.len() as u64,
        )
    } else {
        (String::new(), 0)
    };
    let (metrics, metric_error) = read_metrics(&dir, id)?;
    let mut artifacts = vec![];
    for entry in fs::read_dir(checked_child(&dir, "artifacts")?)?.take(200) {
        let entry = entry?;
        let metadata = entry.file_type()?;
        if metadata.is_file() {
            artifacts.push(json!({"name":entry.file_name().to_string_lossy(),"size":entry.metadata()?.len(),"location":"local","run_id":id}));
        }
    }
    Ok(
        json!({"run":run,"log":log,"next_offset":next_offset,"metrics":metrics,"metric_error":metric_error,"artifacts":artifacts}),
    )
}

pub async fn compare(
    store: &Store,
    data_dir: &Path,
    project: &str,
    conversation: &str,
    baseline_id: &str,
    candidate_id: &str,
) -> Result<Value> {
    let baseline = get(store, data_dir, project, conversation, baseline_id).await?;
    let candidate = get(store, data_dir, project, conversation, candidate_id).await?;
    let (bm, be) = read_metrics(
        &data_dir.join("runs").join(safe_id(baseline_id)?),
        baseline_id,
    )?;
    let (cm, ce) = read_metrics(
        &data_dir.join("runs").join(safe_id(candidate_id)?),
        candidate_id,
    )?;
    let mut result = crate::evaluation::compare(&baseline, &candidate, &bm, &cm);
    if be.is_some() || ce.is_some() {
        result = json!({"comparable":false,"reason":"INVALID_METRIC_FILE","baseline_run_id":baseline_id,"candidate_run_id":candidate_id,"baseline_error":be,"candidate_error":ce});
    }
    Ok(result)
}

pub async fn dispatch(
    store: &Store,
    data_dir: &Path,
    method: &Method,
    path: &str,
    q: &HashMap<String, String>,
    body: &Value,
) -> Option<Result<Value>> {
    let p: Vec<_> = path.split('/').collect();
    if p.first() != Some(&"projects") || !matches!(p.get(2), Some(&"experiments" | &"runs")) {
        return None;
    }
    Some(async {
        let project=p[1];
        // HTTP callers must select a source explicitly; Agent callers derive it from the active turn.
        let conversation=q.get("conversation_id").map(String::as_str).or_else(||body["conversation_id"].as_str()).ok_or_else(||anyhow!("CONVERSATION_REQUIRED"))?;
        scope(store,project,conversation).await?;
        if method == Method::POST && p.len() == 4 && p[2] == "runs" && p[3] == "compare" {
            return compare(store,data_dir,project,conversation,text(body,"baseline_run_id")?,text(body,"candidate_run_id")?).await;
        }
        if method == Method::GET && p.get(3) == Some(&"events") {
            let (project,conversation)=(project.to_string(),conversation.to_string());
            return store.call(move|db| {
                let mut stmt=db.prepare("SELECT e.seq,e.body FROM run_events e JOIN runs r ON r.id=e.run_id WHERE e.project_id=? AND r.conversation_id=? ORDER BY e.seq DESC LIMIT 200")?;
                let rows=stmt.query_map(params![project,conversation],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?;
                let mut events=vec![];for row in rows {let (seq,raw)=row?;let mut v:Value=serde_json::from_str(&raw)?;v["seq"]=json!(seq);events.push(v);} Ok(json!(events))
            }).await;
        }
        match (method.as_str(),p[2],p.len(),p.get(4).copied()) {
            ("GET","experiments",3,_)=>list(store,data_dir,project,conversation,"experiments").await,
            ("POST","experiments",3,_)=>create_experiment(store,project,conversation,body.clone()).await,
            ("GET","runs",3,_)=>list(store,data_dir,project,conversation,"runs").await,
            ("POST","runs",3,_)=>prepare(store,data_dir,project,conversation,body.clone()).await,
            ("GET","runs",4,_)=>get(store,data_dir,project,conversation,p[3]).await,
            ("POST","runs",5,Some("approve"))=>launch(store,data_dir,project,conversation,p[3],text(body,"spec_hash")?).await,
            ("POST","runs",5,Some("cancel"))=>cancel(store,data_dir,project,conversation,p[3]).await,
            ("GET","runs",5,Some("evidence"))=>evidence(store,data_dir,project,conversation,p[3],q.get("offset").and_then(|s|s.parse().ok()).unwrap_or(0)).await,
            ("GET","runs",5,Some("artifact"))=>{
                record(store,"runs",project,conversation,p[3]).await?;
                let name=q.get("name").ok_or_else(||anyhow!("INVALID_ARTIFACT_PATH"))?;
                trainerbuddy_host::relative(name)?;
                if name.contains(['/', '\\']) {bail!("INVALID_ARTIFACT_PATH");}
                let dir=data_dir.join("runs").join(safe_id(p[3])?);
                let artifacts=checked_child(&dir,"artifacts")?;
                let path=checked_child(&artifacts,name)?;
                let metadata=fs::symlink_metadata(&path)?;
                if !metadata.is_file() || metadata.file_type().is_symlink(){bail!("INVALID_ARTIFACT_PATH");}
                if metadata.len()>1024*1024{bail!("ARTIFACT_PREVIEW_TOO_LARGE");}
                let content=fs::read(&path)?;
                Ok(json!({"name":name,"content":String::from_utf8(content.clone()).map_err(|_|anyhow!("ARTIFACT_NOT_TEXT"))?,"sha256":hash(&content),"size":content.len(),"run_id":p[3]}))
            },
            _=>Err(anyhow!("NOT_FOUND"))
        }
    }.await)
}

pub async fn tool(
    store: &Store,
    data_dir: &Path,
    conversation: &str,
    name: &str,
    args: Value,
) -> Result<Value> {
    let c = store
        .conversation(conversation)
        .await?
        .ok_or_else(|| anyhow!("NOT_FOUND"))?;
    let project = text(&c, "project_id")?;
    if args.get("project_id").is_some() || args.get("conversation_id").is_some() {
        bail!("INVALID_RUN_SCOPE");
    }
    let allowed: &[&str] = match name {
        "experiment_create" => &["request_id", "title", "parent_id"],
        "run_prepare" => &[
            "request_id",
            "experiment_id",
            "plan_id",
            "plan_hash",
            "argv",
            "timeout_seconds",
            "evaluation",
        ],
        "run_compare" => &["baseline_run_id", "candidate_run_id"],
        "run_get" | "run_cancel" => &["run_id"],
        "run_evidence" => &["run_id", "offset"],
        "experiment_list" | "run_list" => &[],
        _ => bail!("UNKNOWN_RESEARCH_TOOL"),
    };
    if args
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        bail!("INVALID_RUN_REQUEST");
    }
    match name {
        "run_compare" => {
            compare(
                store,
                data_dir,
                project,
                conversation,
                text(&args, "baseline_run_id")?,
                text(&args, "candidate_run_id")?,
            )
            .await
        }
        "experiment_create" => create_experiment(store, project, conversation, args).await,
        "experiment_list" => list(store, data_dir, project, conversation, "experiments").await,
        "run_prepare" => {
            crate::evaluation::validate(&args["evaluation"])?;
            prepare(store, data_dir, project, conversation, args).await
        }
        "run_list" => list(store, data_dir, project, conversation, "runs").await,
        "run_get" => {
            get(
                store,
                data_dir,
                project,
                conversation,
                text(&args, "run_id")?,
            )
            .await
        }
        "run_evidence" => {
            evidence(
                store,
                data_dir,
                project,
                conversation,
                text(&args, "run_id")?,
                args["offset"].as_u64().unwrap_or(0),
            )
            .await
        }
        "run_cancel" => {
            cancel(
                store,
                data_dir,
                project,
                conversation,
                text(&args, "run_id")?,
            )
            .await
        }
        _ => Err(anyhow!("UNKNOWN_RESEARCH_TOOL")),
    }
}

pub fn start_engine(state: &std::sync::Arc<crate::api::AppState>) {
    let weak = std::sync::Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            let Some(state) = weak.upgrade() else {
                break;
            };
            if let Err(error) = tick(&state).await {
                eprintln!("Run engine: {error:#}");
            }
        }
    });
}

async fn tick(state: &std::sync::Arc<crate::api::AppState>) -> Result<()> {
    let store = &state.chat.store;
    let active=store.call(|db| {
        let mut stmt=db.prepare("SELECT body FROM runs WHERE json_extract(body,'$.state') IN ('preparing','running','cancelling','unknown')")?;
        let rows=stmt.query_map([],|r|r.get::<_,String>(0))?;
        rows.map(|r|Ok(serde_json::from_str::<Value>(&r?)?)).collect::<Result<Vec<_>>>()
    }).await?;
    for run in active {
        if let Err(error) = refresh(store, &state.chat.data_dir, run.clone()).await {
            eprintln!("Cannot reconcile run {}: {error:#}", run["id"]);
        }
    }
    let busy = json!(state
        .chat
        .active
        .lock()
        .await
        .keys()
        .cloned()
        .collect::<Vec<_>>())
    .to_string();
    let notices=store.call(move|db| {
        db.execute("UPDATE run_notices SET status='conversation_deleted' WHERE status IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=run_notices.conversation_id)",[])?;
        let mut stmt=db.prepare("SELECT n.run_id,n.conversation_id,n.body FROM run_notices n JOIN runs r ON r.id=n.run_id LEFT JOIN run_notice_delivery d ON d.run_id=n.run_id WHERE n.status='pending' AND COALESCE(d.next_attempt_at,0)<=? AND NOT EXISTS(SELECT 1 FROM research_controls c WHERE c.project_id=r.project_id AND c.conversation_id=n.conversation_id AND c.paused=1) AND n.conversation_id NOT IN (SELECT value FROM json_each(?)) ORDER BY COALESCE(d.next_attempt_at,0),n.rowid LIMIT 10")?;
        let rows=stmt.query_map(params![chat::now(),busy],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await?;
    for (run, conversation, body) in notices {
        if state.chat.active.lock().await.contains_key(&conversation) {
            continue;
        }
        if store.conversation(&conversation).await?.is_none() {
            store
                .call(move |db| {
                    db.execute(
                        "UPDATE run_notices SET status='conversation_deleted' WHERE run_id=?",
                        [run],
                    )?;
                    Ok(())
                })
                .await?;
            continue;
        }
        let request = json!({"loading_id":format!("run-result-{run}"),"research_mode":"quick","content":format!("[uTrainerBuddy run result — backend data] {body}\nRead this run with run_evidence before making any claims. Analyze the actual evidence, cite the run ID and propose next steps. This notification does not authorize a new run. If evidence is missing, explain that explicitly.")});
        let attempt_run = run.clone();
        store.call(move|db|{
            db.execute("INSERT INTO run_notice_delivery(run_id,attempts,next_attempt_at) VALUES(?,1,?) ON CONFLICT(run_id) DO UPDATE SET attempts=attempts+1,next_attempt_at=excluded.next_attempt_at",params![attempt_run,chat::now()+4000])?;
            Ok(())
        }).await?;
        match state
            .chat
            .send_research_result(&conversation, request)
            .await
        {
            Ok(_) => {
                store.call(move|db|{
                    let tx=db.transaction()?;
                    tx.execute("UPDATE run_notices SET status='accepted' WHERE run_id=? AND status='pending'",[&run])?;
                    tx.execute("UPDATE run_notice_delivery SET accepted_at=?,next_attempt_at=0,last_error=NULL WHERE run_id=?",params![chat::now(),run])?;
                    tx.commit()?;Ok(())
                }).await?;
            }
            Err(error) => {
                crate::research_control::delivery_error(store, run, error.to_string()).await?;
            }
        }
    }
    Ok(())
}
