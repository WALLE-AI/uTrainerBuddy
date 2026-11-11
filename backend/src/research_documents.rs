//! Project Markdown is the plan's authority; SQLite only resolves project/conversation scope.
use crate::{chat, store::Store};
use anyhow::{anyhow, bail, Result};
use axum::http::Method;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn key(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("INVALID_PLAN_REQUEST");
    }
    Ok(value)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn directory(root: &Path, path: &Path, create: bool) -> Result<()> {
    if create && !path.exists() {
        fs::create_dir(path)?;
    }
    if path.exists()
        && (fs::symlink_metadata(path)?.file_type().is_symlink()
            || !path.is_dir()
            || !path.canonicalize()?.starts_with(root))
    {
        bail!("PATH_OUTSIDE_WORKSPACE");
    }
    Ok(())
}
fn scope(db: &Connection, project: &str, conversation: &str, create: bool) -> Result<PathBuf> {
    key(project)?;
    key(conversation)?;
    let body: Option<String> = db.query_row("SELECT p.body FROM projects p JOIN conversations c ON json_extract(c.body,'$.project_id')=p.id WHERE p.id=? AND c.id=?",params![project,conversation],|r|r.get(0)).optional()?;
    let body: Value = serde_json::from_str(&body.ok_or_else(|| anyhow!("NOT_FOUND"))?)?;
    let root = PathBuf::from(
        body["local_root"]
            .as_str()
            .ok_or_else(|| anyhow!("PROJECT_DIRECTORY_REQUIRED"))?,
    )
    .canonicalize()?;
    if !root.is_dir() {
        bail!("PROJECT_DIRECTORY_REQUIRED");
    }
    let mut path = root.clone();
    for part in ["research", "plans", conversation] {
        path.push(part);
        directory(&root, &path, create)?;
    }
    Ok(path)
}
fn read(path: &Path, project: &str, conversation: &str, id: &str) -> Result<Value> {
    let meta = fs::symlink_metadata(path).map_err(|_| anyhow!("NOT_FOUND"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        bail!("PATH_OUTSIDE_WORKSPACE");
    }
    if meta.len() > 300000 {
        bail!("PLAN_TOO_LARGE");
    }
    let raw = fs::read_to_string(path)?;
    let (header, markdown) = raw
        .split_once('\n')
        .ok_or_else(|| anyhow!("PLAN_METADATA_INVALID"))?;
    let header = header
        .strip_prefix("<!-- utrainerbuddy-plan ")
        .and_then(|h| h.strip_suffix(" -->"))
        .ok_or_else(|| anyhow!("PLAN_METADATA_INVALID"))?;
    let mut value: Value =
        serde_json::from_str(header).map_err(|_| anyhow!("PLAN_METADATA_INVALID"))?;
    if value["project_id"] != project
        || value["conversation_id"] != conversation
        || value["id"] != id
    {
        bail!("PLAN_METADATA_INVALID");
    }
    value["markdown"] = json!(markdown);
    value["sha256"] = json!(hash(raw.as_bytes()));
    value["path"] = json!(format!("research/plans/{conversation}/{id}.md"));
    Ok(value)
}
pub async fn execute(
    store: &Store,
    project: &str,
    conversation: &str,
    action: &str,
    body: Value,
) -> Result<Value> {
    let (project, conversation, action) = (
        project.to_string(),
        conversation.to_string(),
        action.to_string(),
    );
    store.call(move |db| {
        // Store serializes all application writes. The file hash also detects external edits.
        let dir=scope(db,&project,&conversation,action=="write")?;
        if action=="list" {
            let mut items=vec![];
            if dir.exists() {for entry in fs::read_dir(&dir)? {
                let path=entry?.path();if path.extension().and_then(|s|s.to_str())!=Some("md") {continue;}
                let id=path.file_stem().and_then(|s|s.to_str()).ok_or_else(||anyhow!("INVALID_PLAN_REQUEST"))?;
                key(id)?;let mut item=read(&path,&project,&conversation,id)?;item.as_object_mut().unwrap().remove("markdown");items.push(item);
                if items.len()>=200 {break;}
            }}
            items.sort_by_key(|v|std::cmp::Reverse(v["updated_at"].as_u64().unwrap_or(0)));return Ok(json!(items));
        }
        let id=key(body["id"].as_str().or(body["request_id"].as_str()).ok_or_else(||anyhow!("INVALID_PLAN_REQUEST"))?)?;
        let path=dir.join(format!("{id}.md"));
        if action=="read" {return read(&path,&project,&conversation,id);}
        if action!="write" {bail!("NOT_IMPLEMENTED");}
        let allowed=["id","request_id","title","markdown","expected_hash"];
        if body.as_object().is_none_or(|v|v.keys().any(|k|!allowed.contains(&k.as_str()))) {bail!("INVALID_PLAN_REQUEST");}
        let request=key(body["request_id"].as_str().ok_or_else(||anyhow!("INVALID_PLAN_REQUEST"))?)?;
        let title=body["title"].as_str().filter(|s|!s.trim().is_empty()&&s.chars().count()<=200).ok_or_else(||anyhow!("INVALID_PLAN_REQUEST"))?;
        let markdown=body["markdown"].as_str().filter(|s|!s.trim().is_empty()&&s.len()<=240000&&!s.contains('\0')).ok_or_else(||anyhow!("INVALID_PLAN_REQUEST"))?;
        let old=if path.exists() {Some(read(&path,&project,&conversation,id)?)} else {None};
        if let Some(old)=&old {
            if old["last_request_id"]==request {if old["markdown"]==markdown && old["title"]==title {return Ok(old.clone());}bail!("PLAN_CONFLICT");}
            if body["expected_hash"].as_str()!=old["sha256"].as_str() {bail!("PLAN_CONFLICT");}
        } else if body["expected_hash"].as_str().is_some() || body["id"].as_str().is_some_and(|v|v!=request) {bail!("NOT_FOUND");}
        let revision=old.as_ref().map(|v|v["revision"].as_u64().unwrap_or(0)).unwrap_or(0)+1;
        let metadata=json!({"id":id,"project_id":project,"conversation_id":conversation,"title":title,"revision":revision,"last_request_id":request,"updated_at":chat::now()});
        let text=format!("<!-- utrainerbuddy-plan {metadata} -->\n{markdown}");
        if let Some(old)=&old {
            let history=dir.join(".history");directory(&dir,&history,true)?;
            let backup=history.join(format!("{id}-{}.md",old["sha256"].as_str().unwrap()));
            let previous_bytes = fs::read(&path)?;
            if Some(hash(&previous_bytes).as_str()) != old["sha256"].as_str() {bail!("PLAN_CONFLICT");}
            if !backup.exists() {let mut file=fs::OpenOptions::new().write(true).create_new(true).open(backup)?;file.write_all(&previous_bytes)?;file.sync_all()?;}
            if read(&path,&project,&conversation,id)?["sha256"]!=old["sha256"] {bail!("PLAN_CONFLICT");}
        }
        let temp=dir.join(format!(".{}.tmp",chat::id()));
        let result = (|| -> Result<()> {
            let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            file.write_all(text.as_bytes())?;file.sync_all()?;drop(file);
            fs::rename(&temp,&path)?;
            Ok(())
        })();
        if let Err(error)=result {let _=fs::remove_file(&temp);return Err(error);}
        read(&path,&project,&conversation,id)
    }).await
}
pub async fn dispatch(
    store: &Store,
    method: &Method,
    path: &str,
    q: &HashMap<String, String>,
    body: &Value,
) -> Option<Result<Value>> {
    let p: Vec<_> = path.split('/').collect();
    if p.first() != Some(&"projects") || p.get(2) != Some(&"research-documents") {
        return None;
    }
    let conversation = q
        .get("conversation_id")
        .map(String::as_str)
        .or(body["conversation_id"].as_str())
        .unwrap_or("");
    let action = match (method.as_str(), p.len()) {
        ("GET", 3) => "list",
        ("GET", 4) => "read",
        _ => return Some(Err(anyhow!("NOT_IMPLEMENTED"))),
    };
    Some(execute(store, p[1], conversation, action, json!({"id":p.get(3)})).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn files_are_authoritative_scoped_versioned_and_restart_safe() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("project");
        fs::create_dir(&root)?;
        let db = temp.path().join("metadata.sqlite");
        let store = Store::open(&db)?;
        for c in ["c1", "c2"] {
            store
                .save_conversation(json!({"id":c,"project_id":"p1","extra":{"workspace":root}}))
                .await?;
        }
        let body = json!({"id":null,"expected_hash":null,"request_id":"plan1","title":"研究计划","markdown":"# Research\n\nInitial evidence and plan\n"});
        let first = execute(&store, "p1", "c1", "write", body.clone()).await?;
        assert_eq!(
            execute(&store, "p1", "c1", "write", body.clone()).await?,
            first
        );
        assert_eq!(
            execute(&store, "p1", "c2", "list", json!({})).await?,
            json!([])
        );
        assert!(execute(&store, "other", "c1", "list", json!({}))
            .await
            .is_err());
        assert!(
            execute(&store, "p1", "c1", "read", json!({"id":"../escape"}))
                .await
                .is_err()
        );
        let path = root.join(first["path"].as_str().unwrap());
        let manual = format!("{}\nUser edit", fs::read_to_string(&path)?);
        fs::write(&path, &manual)?;
        let mut update = body;
        update["id"] = json!("plan1");
        update["request_id"] = json!("edit1");
        update["expected_hash"] = first["sha256"].clone();
        update["markdown"] = json!("# Revised\nUser edit retained\n");
        assert_eq!(
            execute(&store, "p1", "c1", "write", update.clone())
                .await
                .unwrap_err()
                .to_string(),
            "PLAN_CONFLICT"
        );
        assert_eq!(fs::read_to_string(&path)?, manual);
        let current = execute(&store, "p1", "c1", "read", json!({"id":"plan1"})).await?;
        update["expected_hash"] = current["sha256"].clone();
        let second = execute(&store, "p1", "c1", "write", update.clone()).await?;
        assert_eq!(second["revision"], 2);
        assert_eq!(execute(&store, "p1", "c1", "write", update).await?, second);
        let backup = root
            .join("research/plans/c1/.history")
            .join(format!("plan1-{}.md", current["sha256"].as_str().unwrap()));
        assert_eq!(fs::read_to_string(backup)?, manual);
        drop(store);
        let reopened = Store::open(&db)?;
        assert_eq!(
            execute(&reopened, "p1", "c1", "read", json!({"id":"plan1"})).await?,
            second
        );
        // A user-created file blocks a reserved directory; no fallback writes outside the project.
        fs::write(root.join("research/plans/c2"), "do not overwrite")?;
        assert!(execute(
            &reopened,
            "p1",
            "c2",
            "write",
            json!({"request_id":"x","title":"x","markdown":"x"})
        )
        .await
        .is_err());
        Ok(())
    }
}
