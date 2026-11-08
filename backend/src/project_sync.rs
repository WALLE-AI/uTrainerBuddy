use crate::{api::AppState, chat, store::Store};
use anyhow::{anyhow, bail, Result};
use axum::http::Method;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use trainerbuddy_host as host;

pub async fn project(store: &Store, id: &str) -> Result<Value> {
    let id = id.to_owned();
    store
        .call(move |db| {
            let raw: Option<String> = db
                .query_row("SELECT body FROM projects WHERE id=?", [id], |r| r.get(0))
                .optional()?;
            raw.map(|s| serde_json::from_str(&s).map_err(anyhow::Error::from))
                .transpose()?
                .ok_or_else(|| anyhow!("NOT_FOUND"))
        })
        .await
}
async fn binding(s: &Arc<AppState>, id: &str) -> Result<Value> {
    project(&s.chat.store, id).await?;
    let id = id.to_owned();
    s.chat
        .store
        .call(move |db| {
            let raw: Option<String> = db
                .query_row(
                    "SELECT body FROM project_compute_bindings WHERE project_id=?",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(raw
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(Value::Null))
        })
        .await
}
async fn save_binding(s: &Arc<AppState>, id: &str, body: &Value) -> Result<Value> {
    let mut p = project(&s.chat.store, id).await?;
    let target = s.compute.inspect().await;
    if target["profile"].is_null() {
        bail!("COMPUTE_NOT_CONFIGURED");
    }
    if target["files_available"] != true {
        bail!("SSH_SESSION_CLOSED");
    }
    let root = body["local_root"]
        .as_str()
        .or_else(|| p["local_root"].as_str())
        .ok_or_else(|| anyhow!("PROJECT_DIRECTORY_CONFLICT"))?;
    let root = Path::new(root)
        .canonicalize()
        .map_err(|_| anyhow!("WORKSPACE_PATH_UNAVAILABLE"))?;
    if !root.is_dir() {
        bail!("WORKSPACE_PATH_UNAVAILABLE");
    }
    let subdir = body["remote_subdir"]
        .as_str()
        .unwrap_or("")
        .trim_matches('/');
    if !subdir.is_empty() {
        host::relative(subdir)?;
    }
    let previous = binding(s, id).await?;
    let revision = previous["revision"].as_u64().unwrap_or(0);
    if body["expected_revision"].as_u64().unwrap_or(0) != revision {
        bail!("BINDING_CONFLICT");
    }
    let mut conversations = Vec::new();
    for mut c in s.chat.store.conversations().await? {
        if c["project_id"] == id && c["extra"]["workspace"] != root.to_string_lossy().as_ref() {
            if s.chat
                .active
                .lock()
                .await
                .contains_key(c["id"].as_str().unwrap_or(""))
            {
                bail!("PROJECT_BUSY");
            }
            c["extra"]["workspace"] = json!(root);
            conversations.push(c);
        }
    }
    p["local_root"] = json!(root);
    p["state"] = json!("ready");
    let value = json!({"id":previous["id"].as_str().map(str::to_owned).unwrap_or_else(chat::id),"project_id":id,"target_id":target["target_id"],"local_root":root,"remote_subdir":subdir,"remote_root":target["snapshot"]["workdir"]["path"],"revision":revision+1,"last_snapshot":null});
    let (id, expected, result) = (id.to_owned(), revision, value.clone());
    s.chat.store.call(move|db|{let tx=db.transaction()?;let current:Option<String>=tx.query_row("SELECT body FROM project_compute_bindings WHERE project_id=?",[&id],|r|r.get(0)).optional()?;let rev=current.map(|v|serde_json::from_str::<Value>(&v)).transpose()?.unwrap_or(Value::Null)["revision"].as_u64().unwrap_or(0);if rev!=expected{bail!("BINDING_CONFLICT");}for c in conversations {tx.execute("UPDATE conversations SET body=? WHERE id=?",params![c.to_string(),c["id"].as_str()])?;}tx.execute("UPDATE projects SET body=? WHERE id=?",params![p.to_string(),id])?;tx.execute("INSERT INTO project_compute_bindings(project_id,body) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body",params![id,result.to_string()])?;tx.commit()?;Ok(())}).await?;
    Ok(value)
}
fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|_| anyhow!("GIT_UNAVAILABLE"))?;
    if !out.status.success() {
        bail!("PROJECT_GIT_REQUIRED");
    }
    if out.stdout.len() > 8 * 1024 * 1024 {
        bail!("SNAPSHOT_TOO_LARGE");
    }
    Ok(out.stdout)
}
fn preview(root: &Path, data_dir: &Path, expected: Option<&str>) -> Result<Value> {
    let top = String::from_utf8(git(root, &["rev-parse", "--show-toplevel"])?)?;
    if Path::new(top.trim()).canonicalize()? != root.canonicalize()? {
        bail!("PROJECT_GIT_ROOT_REQUIRED");
    }
    let commit = String::from_utf8(git(root, &["rev-parse", "HEAD"])?)?
        .trim()
        .to_owned();
    if expected.is_some_and(|s| s != commit) {
        bail!("SNAPSHOT_STALE");
    }
    let changes = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !changes.is_empty() {
        return Ok(
            json!({"can_publish":false,"commit":commit,"dirty":true,"changes":String::from_utf8_lossy(&changes).split('\0').filter(|s|!s.is_empty()).take(200).collect::<Vec<_>>()}),
        );
    }
    let cache = data_dir.join("source-snapshots");
    let tree = git(root, &["ls-tree", "-r", "-l", "-z", &commit])?;
    let mut total = 0u64;
    let mut count = 0;
    for entry in tree.split(|b| *b == 0).filter(|entry| !entry.is_empty()) {
        let header = entry.split(|b| *b == b'\t').next().unwrap_or_default();
        let header = String::from_utf8_lossy(header);
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields
            .first()
            .is_some_and(|mode| matches!(*mode, "160000" | "120000"))
        {
            bail!("SNAPSHOT_UNSUPPORTED_ENTRY");
        }
        let size = fields
            .get(3)
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| anyhow!("SNAPSHOT_UNSUPPORTED_ENTRY"))?;
        count += 1;
        total = total
            .checked_add(size)
            .ok_or_else(|| anyhow!("SNAPSHOT_TOO_LARGE"))?;
        if size > 32 * 1024 * 1024 || total > host::MAX_SOURCE || count > 20000 {
            bail!("SNAPSHOT_TOO_LARGE");
        }
    }
    std::fs::create_dir_all(&cache)?;
    let tmp = cache.join(format!("{}.part", chat::id()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&tmp)?;
    let mut command = std::process::Command::new("git");
    command
        .current_dir(root)
        .args([
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.eol=lf",
            "archive",
            "--format=tar",
            &commit,
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::from(file));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if !command.output()?.status.success() {
        let _ = std::fs::remove_file(tmp);
        bail!("SNAPSHOT_ARCHIVE_FAILED");
    }
    let result = (|| -> Result<Value> {
        let size = std::fs::metadata(&tmp)?.len();
        if size > host::MAX_SOURCE {
            bail!("SNAPSHOT_TOO_LARGE");
        }
        let manifest = host::archive_manifest(&tmp)?;
        if serde_json::to_vec(&manifest)?.len() as u64 > host::MAX_FRAME - 16384 {
            bail!("SNAPSHOT_TOO_LARGE");
        }
        let digest = host::file_digest(&mut File::open(&tmp)?)?;
        let destination = cache.join(format!("{digest}.tar"));
        if destination.exists() {
            if host::file_digest(&mut File::open(&destination)?)? != digest {
                bail!("DIGEST_MISMATCH");
            }
            std::fs::remove_file(&tmp)?;
        } else {
            std::fs::rename(&tmp, &destination)?;
        }
        Ok(
            json!({"can_publish":true,"dirty":false,"commit":commit,"sha256":digest,"size":size,"file_count":manifest.len(),"manifest":manifest,"archive_path":destination}),
        )
    })();
    if tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
async fn snapshot(
    s: &Arc<AppState>,
    project_id: &str,
    expected: Option<String>,
    save: bool,
) -> Result<Value> {
    let p = project(&s.chat.store, project_id).await?;
    let root = PathBuf::from(
        p["local_root"]
            .as_str()
            .ok_or_else(|| anyhow!("PROJECT_DIRECTORY_CONFLICT"))?,
    );
    let data_dir = s.chat.data_dir.clone();
    let mut value =
        tokio::task::spawn_blocking(move || preview(&root, &data_dir, expected.as_deref()))
            .await??;
    if save && value["can_publish"] == true {
        let id = project_id.to_string();
        let digest = value["sha256"].clone();
        let old=s.chat.store.call(move|db|{let raw:Option<String>=db.query_row("SELECT body FROM source_snapshots WHERE project_id=? AND json_extract(body,'$.sha256')=?",params![id,digest.as_str()],|r|r.get(0)).optional()?;Ok(raw.map(|v|serde_json::from_str::<Value>(&v)).transpose()?)}).await?;
        if let Some(old) = old {
            return Ok(old);
        }
        value["id"] = json!(chat::id());
        value["project_id"] = json!(project_id);
        value["created_at"] = json!(chat::now());
        let next = value.clone();
        s.chat
            .store
            .call(move |db| {
                db.execute(
                    "INSERT INTO source_snapshots(id,project_id,body) VALUES(?,?,?)",
                    params![
                        next["id"].as_str(),
                        next["project_id"].as_str(),
                        next.to_string()
                    ],
                )?;
                Ok(())
            })
            .await?;
    }
    Ok(value)
}
pub fn host_package() -> Result<(PathBuf, Value)> {
    let folder = std::env::var_os("TRAINERBUDDY_HOST_PACKAGE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("host-binaries/linux-x86_64")
        });
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(folder.join("manifest.json"))
            .map_err(|_| anyhow!("HOST_PACKAGE_MISSING"))?,
    )?;
    let binary = folder.join("trainerbuddy-host");
    let mut file = File::open(&binary).map_err(|_| anyhow!("HOST_PACKAGE_MISSING"))?;
    if file.metadata()?.len() != manifest["size"].as_u64().unwrap_or(0)
        || host::file_digest(&mut file)? != manifest["sha256"].as_str().unwrap_or("")
    {
        bail!("INVALID_HOST_PACKAGE");
    }
    Ok((binary, manifest))
}
pub async fn host_rpc(
    s: &Arc<AppState>,
    target: &str,
    connection: &str,
    request: Value,
) -> Result<Value> {
    let data = s
        .compute
        .rpc(
            target,
            connection,
            json!({"op":"host_request","request":request}),
        )
        .await?;
    if let Some(code) = data["host_error"].as_str() {
        bail!("{}", code);
    }
    Ok(data)
}
async fn install_host(s: &Arc<AppState>, body: &Value) -> Result<Value> {
    let target = s.compute.inspect().await;
    let target_id = target["target_id"]
        .as_str()
        .ok_or_else(|| anyhow!("SSH_SESSION_CLOSED"))?;
    let connection = target["connection_id"]
        .as_str()
        .ok_or_else(|| anyhow!("SSH_SESSION_CLOSED"))?;
    if body["connection_id"] != connection {
        bail!("COMPUTE_SESSION_CHANGED");
    }
    if target["snapshot"]["arch"] != "x86_64" || target["snapshot"]["os"] != "Linux" {
        bail!("HOST_ARCH_UNSUPPORTED");
    }
    let (binary, manifest) = host_package()?;
    let begin = s
        .compute
        .rpc(
            target_id,
            connection,
            json!({"op":"host_install_begin","sha256":manifest["sha256"],"size":manifest["size"]}),
        )
        .await?;
    let mut offset = begin["offset"]
        .as_u64()
        .ok_or_else(|| anyhow!("INVALID_HOST_RESPONSE"))?;
    let mut file = File::open(binary)?;
    file.seek(SeekFrom::Start(offset))?;
    loop {
        let mut bytes = vec![0; host::CHUNK];
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        let result=s.compute.rpc(target_id,connection,json!({"op":"host_install_chunk","offset":offset,"bytes":host::encode(&bytes[..count])})).await?;
        offset = result["offset"]
            .as_u64()
            .ok_or_else(|| anyhow!("INVALID_HOST_RESPONSE"))?;
    }
    s.compute
        .rpc(target_id, connection, json!({"op":"host_install_finish"}))
        .await?;
    let hello = host_rpc(s, target_id, connection, json!({"op":"hello"})).await?;
    if hello["protocol_version"] != host::PROTOCOL || hello["binary_sha256"] != manifest["sha256"] {
        bail!("HOST_PROTOCOL_MISMATCH");
    }
    Ok(hello)
}
pub async fn transfer(s: &Arc<AppState>, id: &str) -> Result<Value> {
    let id = id.to_owned();
    s.chat
        .store
        .call(move |db| {
            let raw: Option<String> = db
                .query_row("SELECT body FROM transfers WHERE id=?", [id], |r| r.get(0))
                .optional()?;
            raw.map(|v| serde_json::from_str(&v).map_err(anyhow::Error::from))
                .transpose()?
                .ok_or_else(|| anyhow!("NOT_FOUND"))
        })
        .await
}
async fn persist_transfer(s: &Arc<AppState>, value: &Value) -> Result<()> {
    let mut value = value.clone();
    s.chat
        .store
        .call(move |db| {
            let raw: String = db.query_row(
                "SELECT body FROM transfers WHERE id=?",
                [value["id"].as_str()],
                |r| r.get(0),
            )?;
            let current: Value = serde_json::from_str(&raw)?;
            if current["status"] == "completed" && value["status"] != "completed" {
                bail!("TRANSFER_TERMINAL");
            }
            if current["cancel_requested"] == true && value["status"] != "queued" {
                value["cancel_requested"] = json!(true);
            }
            db.execute(
                "UPDATE transfers SET body=? WHERE id=?",
                params![value.to_string(), value["id"].as_str()],
            )?;
            Ok(())
        })
        .await
}
async fn cancelled(s: &Arc<AppState>, id: &str) -> Result<()> {
    let value = transfer(s, id).await?;
    if value["cancel_requested"] == true {
        bail!("TRANSFER_CANCELLED");
    }
    if binding(s, value["project_id"].as_str().unwrap()).await?["revision"]
        != value["binding"]["revision"]
    {
        bail!("BINDING_CONFLICT");
    }
    Ok(())
}
async fn progress(
    s: &Arc<AppState>,
    id: &str,
    status: &str,
    offset: u64,
    total: u64,
) -> Result<Value> {
    let mut value = transfer(s, id).await?;
    value["status"] = json!(status);
    value["confirmed_bytes"] = json!(offset);
    value["total_bytes"] = json!(total);
    value["updated_at"] = json!(chat::now());
    value["error"] = Value::Null;
    persist_transfer(s, &value).await?;
    Ok(value)
}
async fn launch(s: Arc<AppState>, id: String) {
    if !s.sync_active.lock().await.insert(id.clone()) {
        return;
    }
    tokio::spawn(async move {
        let outcome = run(&s, &id).await;
        if let Err(error) = outcome {
            if let Ok(mut value) = transfer(&s, &id).await {
                let code = error.to_string();
                value["error"] = json!(code);
                value["status"] = json!(match code.as_str() {
                    "TRANSFER_CANCELLED" => "cancelled",
                    "SSH_SESSION_CLOSED" | "HOST_NOT_READY" => "waiting_connection",
                    _ if value["status"] == "publishing" => "unreconciled",
                    _ => "failed",
                });
                let _ = persist_transfer(&s, &value).await;
            }
        }
        s.sync_active.lock().await.remove(&id);
    });
}
async fn run(s: &Arc<AppState>, id: &str) -> Result<()> {
    let value = transfer(s, id).await?;
    let project_id = value["project_id"].as_str().unwrap();
    let saved_binding = &value["binding"];
    let current = binding(s, project_id).await?;
    if current["revision"] != saved_binding["revision"] {
        bail!("BINDING_CONFLICT");
    }
    let target = s.compute.inspect().await;
    if target["target_id"] != saved_binding["target_id"] {
        bail!("COMPUTE_TARGET_CHANGED");
    }
    let target_id = target["target_id"].as_str().unwrap();
    let connection = target["connection_id"]
        .as_str()
        .ok_or_else(|| anyhow!("SSH_SESSION_CLOSED"))?;
    let mut request = json!({"project":project_id,"managed_subdir":saved_binding["remote_subdir"]});
    if value["kind"] == "download" {
        return download(s, id, &value, target_id, connection).await;
    }
    let snapshot = &value["snapshot"];
    let path = Path::new(snapshot["archive_path"].as_str().unwrap());
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    if host::file_digest(&mut file)? != snapshot["sha256"] {
        bail!("DIGEST_MISMATCH");
    }
    request["snapshot"] = snapshot["id"].clone();
    request["sha256"] = snapshot["sha256"].clone();
    request["size"] = json!(total);
    cancelled(s, id).await?;
    request["op"] = json!("has_blob");
    let remote = host_rpc(s, target_id, connection, request.clone()).await?;
    let mut offset = remote["offset"]
        .as_u64()
        .ok_or_else(|| anyhow!("INVALID_HOST_RESPONSE"))?;
    if offset > total {
        bail!("INVALID_OFFSET");
    }
    file.seek(SeekFrom::Start(offset))?;
    while offset < total {
        cancelled(s, id).await?;
        progress(s, id, "uploading", offset, total).await?;
        let mut bytes = vec![0; (total - offset).min(host::CHUNK as u64) as usize];
        file.read_exact(&mut bytes)?;
        request["op"] = json!("put_chunk");
        request["offset"] = json!(offset);
        request["bytes"] = json!(host::encode(&bytes));
        let answer = host_rpc(s, target_id, connection, request.clone()).await?;
        let confirmed = answer["offset"]
            .as_u64()
            .ok_or_else(|| anyhow!("INVALID_HOST_RESPONSE"))?;
        if confirmed != offset + bytes.len() as u64 {
            bail!("INVALID_OFFSET");
        }
        offset = confirmed;
    }
    cancelled(s, id).await?;
    progress(s, id, "verifying", total, total).await?;
    request["op"] = json!("complete_blob");
    request.as_object_mut().unwrap().remove("bytes");
    host_rpc(s, target_id, connection, request.clone()).await?;
    cancelled(s, id).await?;
    progress(s, id, "publishing", total, total).await?;
    request["op"] = json!("publish_snapshot");
    request["manifest"] = snapshot["manifest"].clone();
    request["commit"] = snapshot["commit"].clone();
    let receipt = host_rpc(s, target_id, connection, request).await?;
    if receipt["complete"] != true
        || receipt["sha256"] != snapshot["sha256"]
        || receipt["snapshot_id"] != snapshot["id"]
    {
        bail!("INVALID_HOST_RESPONSE");
    }
    let mut completed = transfer(s, id).await?;
    completed["status"] = json!("completed");
    completed["confirmed_bytes"] = json!(total);
    completed["total_bytes"] = json!(total);
    completed["updated_at"] = json!(chat::now());
    completed["error"] = Value::Null;
    completed["receipt"] = receipt;
    let mut next = current;
    next["last_snapshot"] = snapshot.clone();
    next["last_snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("manifest");
    next["last_snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("archive_path");
    next["last_snapshot"]["receipt"] = completed["receipt"].clone();
    let id = project_id.to_owned();
    s.chat.store.call(move|db|{let tx=db.transaction()?;tx.execute("UPDATE transfers SET body=? WHERE id=?",params![completed.to_string(),completed["id"].as_str()])?;tx.execute("UPDATE project_compute_bindings SET body=? WHERE project_id=? AND json_extract(body,'$.revision')=?",params![next.to_string(),id,next["revision"].as_u64()])?;tx.commit()?;Ok(())}).await?;
    Ok(())
}
async fn download(
    s: &Arc<AppState>,
    id: &str,
    value: &Value,
    target: &str,
    connection: &str,
) -> Result<()> {
    let project = value["project_id"].as_str().unwrap();
    let path = value["path"].as_str().unwrap();
    let folder = s.chat.data_dir.join("results").join(project).join(id);
    tokio::fs::create_dir_all(&folder).await?;
    let name = path.split('/').next_back().unwrap_or("result");
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(180)
        .collect();
    let final_path = folder.join(format!("result_{clean}"));
    if final_path.exists() {
        let mut existing = File::open(&final_path)?;
        let size = existing.metadata()?.len();
        if value["source_sha256"]
            .as_str()
            .is_some_and(|hash| host::file_digest(&mut existing).is_ok_and(|actual| actual == hash))
            && value["total_bytes"] == size
        {
            let mut done = transfer(s, id).await?;
            done["status"] = json!("completed");
            done["local_path"] = json!(final_path);
            done["confirmed_bytes"] = json!(size);
            done["error"] = Value::Null;
            return persist_transfer(s, &done).await;
        }
        bail!("DOWNLOAD_DESTINATION_EXISTS");
    }
    let part = folder.join("content.part");
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&part)?;
    let mut offset = file.metadata()?.len();
    let saved_hash = value["source_sha256"].as_str().map(str::to_owned);
    let mut hash = saved_hash;
    let mut total: u64;
    loop {
        cancelled(s, id).await?;
        let data=host_rpc(s,target,connection,json!({"op":"read_chunk","project":project,"path":path,"offset":offset,"expected_sha256":hash})).await?;
        let source_hash = data["sha256"]
            .as_str()
            .ok_or_else(|| anyhow!("INVALID_HOST_RESPONSE"))?
            .to_owned();
        if hash.is_none() {
            hash = Some(source_hash.clone());
            let mut task = transfer(s, id).await?;
            task["source_sha256"] = json!(source_hash);
            persist_transfer(s, &task).await?;
        }
        total = data["size"]
            .as_u64()
            .ok_or_else(|| anyhow!("INVALID_HOST_RESPONSE"))?;
        let bytes = host::decode(data["bytes"].as_str().unwrap_or(""))?;
        if bytes.len() > host::CHUNK
            || data["offset"] != offset
            || offset + bytes.len() as u64 > total
        {
            bail!("INVALID_HOST_RESPONSE");
        }
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&bytes)?;
        file.sync_data()?;
        offset += bytes.len() as u64;
        progress(s, id, "downloading", offset, total).await?;
        if data["eof"] == true {
            break;
        }
        if bytes.is_empty() {
            bail!("INVALID_HOST_RESPONSE");
        }
    }
    cancelled(s, id).await?;
    progress(s, id, "verifying", offset, total).await?;
    if offset != total || Some(host::file_digest(&mut file)?) != hash {
        file.set_len(0)?;
        file.sync_all()?;
        bail!("DIGEST_MISMATCH");
    }
    file.sync_all()?;
    drop(file);
    if final_path.exists() {
        bail!("DOWNLOAD_DESTINATION_EXISTS");
    }
    tokio::fs::rename(part, &final_path).await?;
    let mut done = transfer(s, id).await?;
    done["status"] = json!("completed");
    done["confirmed_bytes"] = json!(offset);
    done["total_bytes"] = json!(total);
    done["updated_at"] = json!(chat::now());
    done["error"] = Value::Null;
    done["local_path"] = json!(final_path);
    persist_transfer(s, &done).await
}
async fn create_transfer(
    s: &Arc<AppState>,
    project_id: &str,
    body: &Value,
    kind: &str,
) -> Result<Value> {
    let b = binding(s, project_id).await?;
    if b.is_null() {
        bail!("PROJECT_BINDING_REQUIRED");
    }
    let key = body["request_id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or_else(|| anyhow!("REQUEST_ID_REQUIRED"))?;
    if kind == "publish" && body["commit"].as_str().is_none() {
        bail!("SNAPSHOT_PREVIEW_REQUIRED");
    }
    let spec = host::digest(&serde_json::to_vec(
        &json!({"binding_id":b["id"],"revision":b["revision"],"target_id":b["target_id"],"kind":kind,"commit":body["commit"],"path":body["path"]}),
    )?);
    let (pid, rkey) = (project_id.to_owned(), key.to_owned());
    let old = s
        .chat
        .store
        .call(move |db| {
            let raw: Option<String> = db
                .query_row(
                    "SELECT body FROM transfers WHERE project_id=? AND request_key=?",
                    params![pid, rkey],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(raw.map(|v| serde_json::from_str::<Value>(&v)).transpose()?)
        })
        .await?;
    if let Some(old) = old {
        if old["spec_digest"] != spec {
            bail!("IDEMPOTENCY_CONFLICT");
        }
        return Ok(old);
    }
    let mut value = json!({"id":chat::id(),"project_id":project_id,"request_key":key,"kind":kind,"binding":b,"status":"queued","confirmed_bytes":0,"total_bytes":0,"cancel_requested":false,"created_at":chat::now(),"updated_at":chat::now(),"error":null});
    if kind == "publish" {
        let snap = snapshot(
            s,
            project_id,
            body["commit"].as_str().map(str::to_owned),
            true,
        )
        .await?;
        if snap["can_publish"] != true {
            bail!("PROJECT_DIRTY");
        }
        value["snapshot"] = snap;
    } else {
        let path = body["path"]
            .as_str()
            .ok_or_else(|| anyhow!("INVALID_FILE_REQUEST"))?;
        host::relative(path)?;
        let prefix = value["binding"]["last_snapshot"]["receipt"]["repo_path"]
            .as_str()
            .ok_or_else(|| anyhow!("PROJECT_NOT_PUBLISHED"))?;
        value["path"] = json!(format!("{prefix}/{path}"));
    }
    value["spec_digest"] = json!(spec);
    let record = value.clone();
    let result = s
        .chat
        .store
        .call(move |db| {
            let tx = db.transaction()?;
            let old: Option<String> = tx
                .query_row(
                    "SELECT body FROM transfers WHERE project_id=? AND request_key=?",
                    params![
                        record["project_id"].as_str(),
                        record["request_key"].as_str()
                    ],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(old) = old {
                let old: Value = serde_json::from_str(&old)?;
                if old["spec_digest"] != record["spec_digest"] {
                    bail!("IDEMPOTENCY_CONFLICT");
                }
                return Ok(old);
            }
            tx.execute(
                "INSERT INTO transfers(id,project_id,request_key,body) VALUES(?,?,?,?)",
                params![
                    record["id"].as_str(),
                    record["project_id"].as_str(),
                    record["request_key"].as_str(),
                    record.to_string()
                ],
            )?;
            tx.commit()?;
            Ok(record)
        })
        .await?;
    if result["status"] == "queued" {
        launch(s.clone(), result["id"].as_str().unwrap().into()).await;
    }
    Ok(result)
}
pub async fn dispatch(
    s: &Arc<AppState>,
    method: &Method,
    path: &str,
    q: &HashMap<String, String>,
    body: &Value,
) -> Option<Result<Value>> {
    let parts: Vec<_> = path.split('/').collect();
    let action = parts.get(2).copied().unwrap_or("");
    if path == "compute/target/host" {
        return Some(async{let (_,package)=host_package()?;let target=s.compute.inspect().await;let ready=if let (Some(t),Some(c))=(target["target_id"].as_str(),target["connection_id"].as_str()){host_rpc(s,t,c,json!({"op":"hello"})).await.is_ok_and(|v|v["protocol_version"]==host::PROTOCOL&&v["binary_sha256"]==package["sha256"])}else{false};Ok(json!({"package":package,"ready":ready,"target_id":target["target_id"],"connection_id":target["connection_id"],"installation_directory":format!("{}/.trainerbuddy/hosts/{}/trainerbuddy-host",target["snapshot"]["workdir"]["path"].as_str().unwrap_or("<remote workdir>"),package["sha256"].as_str().unwrap_or(""))}))}.await);
    }
    if path == "compute/target/host/install" && method == Method::POST {
        return Some(install_host(s, body).await);
    }
    if parts.first() == Some(&"projects")
        && parts.len() == 3
        && matches!(action, "remote-files" | "remote-file")
        && method == Method::GET
    {
        return Some(
            async {
                let b = binding(s, parts[1]).await?;
                if b.is_null() {
                    bail!("PROJECT_BINDING_REQUIRED");
                }
                let target = s.compute.inspect().await;
                if target["target_id"] != b["target_id"] {
                    bail!("COMPUTE_TARGET_CHANGED");
                }
                let prefix = b["last_snapshot"]["receipt"]["repo_path"]
                    .as_str()
                    .ok_or_else(|| anyhow!("PROJECT_NOT_PUBLISHED"))?;
                let path = q.get("path").map(String::as_str).unwrap_or("");
                if !path.is_empty() {
                    host::relative(path)?;
                }
                let path = if path.is_empty() {
                    prefix.to_string()
                } else {
                    format!("{prefix}/{path}")
                };
                let cursor = q
                    .get("cursor")
                    .map(|v| v.parse::<u64>())
                    .transpose()?
                    .unwrap_or(0);
                s.compute
                    .files(
                        if action == "remote-files" {
                            "list"
                        } else {
                            "read"
                        },
                        &path,
                        cursor,
                        q.get("connection_id").map(String::as_str).unwrap_or(""),
                    )
                    .await
            }
            .await,
        );
    }
    if parts.first() == Some(&"projects")
        && parts.len() == 3
        && matches!(
            action,
            "compute-binding"
                | "snapshot-preview"
                | "snapshots"
                | "publish"
                | "transfers"
                | "remote-download"
        )
    {
        let id = parts[1];
        return Some(async{match(method.as_str(),action){
            ("GET","compute-binding")=>Ok(json!({"project":project(&s.chat.store,id).await?,"binding":binding(s,id).await?,"target":s.compute.inspect().await})),
            ("PUT","compute-binding")=>save_binding(s,id,body).await,
            ("POST","snapshot-preview")=>snapshot(s,id,None,false).await,
            ("POST","snapshots")=>snapshot(s,id,body["commit"].as_str().map(str::to_owned),true).await,
            ("POST","publish")=>create_transfer(s,id,body,"publish").await,
            ("POST","remote-download")=>create_transfer(s,id,body,"download").await,
            ("GET","transfers")=>{let id=id.to_owned();s.chat.store.call(move|db|{let mut stmt=db.prepare("SELECT json_remove(body,'$.snapshot.manifest','$.snapshot.archive_path') FROM transfers WHERE project_id=? ORDER BY json_extract(body,'$.created_at') DESC LIMIT 30")?;let rows=stmt.query_map([id],|r|r.get::<_,String>(0))?;Ok(Value::Array(rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect::<Result<Vec<_>>>()?))}).await},
            _=>bail!("NOT_IMPLEMENTED")
        }}.await);
    }
    if parts.first() == Some(&"transfers") && (parts.len() == 2 || parts.len() == 3) {
        let id = parts[1];
        return Some(
            async {
                let mut value = transfer(s, id).await?;
                match (method.as_str(), action) {
                    ("GET", "") => Ok(value),
                    ("POST", "resume") => {
                        if s.sync_active.lock().await.contains(id) {
                            return Ok(value);
                        }
                        if matches!(value["status"].as_str(), Some("completed" | "cancelled")) {
                            bail!("TRANSFER_TERMINAL");
                        }
                        value["cancel_requested"] = json!(false);
                        value["status"] = json!("queued");
                        persist_transfer(s, &value).await?;
                        launch(s.clone(), id.into()).await;
                        Ok(value)
                    }
                    ("POST", "cancel") => {
                        if value["status"] == "completed" {
                            bail!("TRANSFER_TERMINAL");
                        }
                        value["cancel_requested"] = json!(true);
                        value["status"] = json!(if s.sync_active.lock().await.contains(id) {
                            "cancelling"
                        } else {
                            "cancelled"
                        });
                        persist_transfer(s, &value).await?;
                        Ok(value)
                    }
                    _ => bail!("NOT_IMPLEMENTED"),
                }
            }
            .await,
        );
    }
    None
}
