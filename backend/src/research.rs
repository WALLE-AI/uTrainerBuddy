//! Native research goals. Execution remains unavailable until the Run executor is integrated.
use crate::{chat, store::Store};
use anyhow::{anyhow, bail, Result};
use axum::http::Method;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;

fn validate(body: &Value, create: bool) -> Result<()> {
    let fields = ["title", "objective", "evaluation", "constraints", "plan"];
    let object = body
        .as_object()
        .ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?;
    if object.keys().any(|key| {
        !fields.contains(&key.as_str())
            && !(create && matches!(key.as_str(), "request_id" | "origin_conversation_id"))
            && !(!create && key == "expected_revision")
    }) {
        bail!("INVALID_RESEARCH_REQUEST");
    }
    for (field, min, max) in [
        ("title", 1, 200),
        ("objective", 1, 16000),
        ("evaluation", 0, 16000),
        ("constraints", 0, 16000),
    ] {
        let value = body[field]
            .as_str()
            .ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?;
        if value.trim().chars().count() < min || value.chars().count() > max || value.contains('\0')
        {
            bail!("INVALID_RESEARCH_REQUEST");
        }
    }
    if let Some(plan) = body.get("plan") {
        let steps = plan
            .as_array()
            .ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?;
        if steps.len() > 30
            || steps.iter().any(|step| {
                !step.as_str().is_some_and(|s| {
                    !s.trim().is_empty() && s.chars().count() <= 2000 && !s.contains('\0')
                })
            })
        {
            bail!("INVALID_RESEARCH_REQUEST");
        }
    }
    if create {
        for field in ["request_id", "origin_conversation_id"] {
            let value = body[field]
                .as_str()
                .ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?;
            if value.trim().is_empty() || value.chars().count() > 128 || value.contains('\0') {
                bail!("INVALID_RESEARCH_REQUEST");
            }
        }
    } else if !body["expected_revision"]
        .as_u64()
        .is_some_and(|n| n > 0 && n < i64::MAX as u64)
    {
        bail!("INVALID_RESEARCH_REQUEST");
    }
    Ok(())
}

fn goal(db: &Connection, project: &str, id: &str) -> Result<Value> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM research_sessions WHERE project_id=? AND id=?",
            params![project, id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(serde_json::from_str(
        &raw.ok_or_else(|| anyhow!("NOT_FOUND"))?,
    )?)
}

pub async fn dispatch(
    store: &Store,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &Value,
) -> Option<Result<Value>> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.first() != Some(&"projects") || parts.get(2) != Some(&"research") {
        return None;
    }
    // Claim the namespace, including unsupported execution routes; never fall through to generic CRUD.
    let project = parts[1].to_string();
    let id = parts.get(3).map(|s| s.to_string());
    let length = parts.len();
    let method = method.clone();
    let source = query.get("conversation_id").cloned();
    let body = body.clone();
    Some(store.call(move |db| {
        let tx = db.transaction()?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", [&project], |row| row.get(0))?;
        if !exists { bail!("NOT_FOUND"); }
        let result = match (method.as_str(), length) {
            ("GET", 3) => {
                let mut stmt = tx.prepare("SELECT body FROM research_sessions WHERE project_id=? AND (? IS NULL OR origin_conversation_id=?) ORDER BY json_extract(body,'$.created_at') DESC,id DESC LIMIT 200")?;
                let rows = stmt.query_map(params![project,source,source], |row| row.get::<_,String>(0))?;
                let values: Result<Vec<Value>> = rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect();
                json!(values?)
            }
            ("GET", 4) => goal(&tx, &project, id.as_deref().unwrap())?,
            ("POST", 3) => {
                validate(&body, true)?;
                let key = body["request_id"].as_str().unwrap();
                let prior: Option<(String,String)> = tx.query_row("SELECT request,result FROM research_requests WHERE project_id=? AND request_id=?", params![project,key], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
                if let Some((request,result)) = prior {
                    if serde_json::from_str::<Value>(&request)? != body { bail!("IDEMPOTENCY_CONFLICT"); }
                    serde_json::from_str(&result)?
                } else {
                    let source = body["origin_conversation_id"].as_str().unwrap();
                    let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE id=? AND json_extract(body,'$.project_id')=?)", params![source,project], |row| row.get(0))?;
                    if !valid { bail!("NOT_FOUND"); }
                    let id = chat::id();
                    let now = chat::now();
                    let mut value = body.clone();
                    value.as_object_mut().unwrap().remove("request_id");
                    value["id"] = json!(id);
                    value["project_id"] = json!(project);
                    value["revision"] = json!(1);
                    value["created_at"] = json!(now);
                    value["updated_at"] = json!(now);
                    if value.get("plan").is_none() { value["plan"] = json!([]); }
                    tx.execute("INSERT INTO research_sessions(id,project_id,origin_conversation_id,body) VALUES(?,?,?,?)", params![id,project,source,value.to_string()])?;
                    tx.execute("INSERT INTO research_requests(project_id,request_id,request,result) VALUES(?,?,?,?)", params![project,key,body.to_string(),value.to_string()])?;
                    value
                }
            }
            ("PATCH", 4) => {
                let mut value = goal(&tx, &project, id.as_deref().unwrap())?;
                validate(&body, false)?;
                if value["revision"] != body["expected_revision"] { bail!("RESEARCH_REVISION_CONFLICT"); }
                for field in ["title", "objective", "evaluation", "constraints"] { value[field] = body[field].clone(); }
                if let Some(plan) = body.get("plan") { value["plan"] = plan.clone(); }
                value["revision"] = json!(body["expected_revision"].as_u64().unwrap() + 1);
                value["updated_at"] = json!(chat::now());
                tx.execute("UPDATE research_sessions SET body=? WHERE project_id=? AND id=?", params![value.to_string(),project,id])?;
                value
            }
            _ => bail!("NOT_IMPLEMENTED"),
        };
        tx.commit()?;
        Ok(result)
    }).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn request(store: &Store, method: Method, path: &str, body: Value) -> Result<Value> {
        dispatch(store, &method, path, &HashMap::new(), &body)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn goals_are_scoped_idempotent_and_survive_reopen() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("research.sqlite");
        let store = Store::open(&path)?;
        for (id, project) in [("c1", "p1"), ("c2", "p2")] {
            store
                .save_conversation(
                    json!({"id":id,"project_id":project,"extra":{"workspace":"fixture"}}),
                )
                .await?;
        }
        let body = json!({"request_id":"create-1","origin_conversation_id":"c1","title":"研究目标","objective":"baseline","evaluation":"accuracy","constraints":"CPU only"});
        let (a, b) = tokio::join!(
            request(&store, Method::POST, "projects/p1/research", body.clone()),
            request(&store, Method::POST, "projects/p1/research", body.clone())
        );
        let created = a?;
        assert_eq!(created, b?);
        let item = format!("projects/p1/research/{}", created["id"].as_str().unwrap());
        let edit = json!({"expected_revision":1,"title":"edited","objective":"baseline","evaluation":"accuracy","constraints":"CPU only"});
        let (a, b) = tokio::join!(
            request(&store, Method::PATCH, &item, edit.clone()),
            request(&store, Method::PATCH, &item, edit.clone())
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let error = if a.is_err() {
            a.unwrap_err()
        } else {
            b.unwrap_err()
        };
        assert_eq!(error.to_string(), "RESEARCH_REVISION_CONFLICT");
        assert_eq!(
            request(&store, Method::POST, "projects/p1/research", body.clone()).await?,
            created
        );
        let mut changed = body.clone();
        changed["objective"] = json!("different");
        assert_eq!(
            request(&store, Method::POST, "projects/p1/research", changed)
                .await
                .unwrap_err()
                .to_string(),
            "IDEMPOTENCY_CONFLICT"
        );
        assert_eq!(
            request(
                &store,
                Method::GET,
                &item.replace("p1/", "p2/"),
                Value::Null
            )
            .await
            .unwrap_err()
            .to_string(),
            "NOT_FOUND"
        );
        assert_eq!(
            request(&store, Method::POST, "projects/p2/research", body.clone())
                .await
                .unwrap_err()
                .to_string(),
            "NOT_FOUND"
        );
        let mut invalid = body.clone();
        invalid["run"] = json!(true);
        assert!(
            request(&store, Method::POST, "projects/p1/research", invalid)
                .await
                .is_err()
        );
        store
            .call(|db| {
                db.execute("DELETE FROM conversations WHERE id='c1'", [])?;
                Ok(())
            })
            .await?;
        // Historical source remains readable and a retry still returns its original response.
        drop(store);
        let reopened = Store::open(&path)?;
        assert_eq!(
            request(&reopened, Method::GET, &item, Value::Null).await?["revision"],
            2
        );
        assert_eq!(
            request(&reopened, Method::POST, "projects/p1/research", body).await?,
            created
        );
        assert_eq!(
            request(&reopened, Method::GET, "projects/p1/research", Value::Null)
                .await?
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(reopened
            .call(|db| {
                db.execute("DELETE FROM projects WHERE id='p1'", [])?;
                Ok(())
            })
            .await
            .is_err());
        Ok(())
    }

    #[tokio::test]
    async fn v2_upgrade_preserves_backup_and_rejects_newer_schema() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("metadata.sqlite");
        let db = Connection::open(&path)?;
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('keep','42'); PRAGMA user_version=2;")?;
        drop(db);
        let store = Store::open(&path)?;
        assert_eq!(
            store
                .call(|db| Ok(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?))
                .await?,
            3
        );
        assert_eq!(
            store
                .call(|db| Ok(db.query_row(
                    "SELECT value FROM settings WHERE key='keep'",
                    [],
                    |r| r.get::<_, String>(0)
                )?))
                .await?,
            "42"
        );
        let backup = Connection::open(path.with_extension("pre-research-v2.sqlite"))?;
        assert_eq!(
            backup.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?,
            2
        );
        store
            .call(|db| {
                db.execute_batch("PRAGMA user_version=4")?;
                Ok(())
            })
            .await?;
        assert!(Store::open(&path).is_err());
        Ok(())
    }
}
