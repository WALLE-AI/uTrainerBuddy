use crate::{chat, store::Store};
use anyhow::{anyhow, bail, Result};
use axum::http::Method;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const MAX_ATTEMPTS: i64 = 5;

pub fn require_active(db: &Connection, project: &str, conversation: &str) -> Result<()> {
    let paused: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM research_controls WHERE project_id=? AND conversation_id=? AND paused=1)",params![project,conversation],|r|r.get(0))?;
    if paused {
        bail!("RESEARCH_PAUSED");
    }
    Ok(())
}

fn read(db: &Connection, project: &str, conversation: &str) -> Result<Value> {
    let value = db.query_row("SELECT paused,revision,updated_at FROM research_controls WHERE project_id=? AND conversation_id=?",params![project,conversation],|r|Ok(json!({"paused":r.get::<_,bool>(0)?,"revision":r.get::<_,i64>(1)?,"updated_at":r.get::<_,i64>(2)?}))).optional()?;
    Ok(value.unwrap_or(json!({"paused":false,"revision":0,"updated_at":null})))
}

async fn scope(store: &Store, project: &str, conversation: &str) -> Result<()> {
    if store
        .conversation(conversation)
        .await?
        .is_none_or(|c| c["project_id"] != project)
    {
        bail!("NOT_FOUND");
    }
    Ok(())
}

pub async fn get(store: &Store, project: &str, conversation: &str) -> Result<Value> {
    scope(store, project, conversation).await?;
    let (p, c) = (project.to_string(), conversation.to_string());
    store.call(move |db| read(db, &p, &c)).await
}

async fn set(store: &Store, project: &str, conversation: &str, body: &Value) -> Result<Value> {
    scope(store, project, conversation).await?;
    if body.as_object().is_none_or(|o| {
        o.len() != 2
            || o.keys()
                .any(|k| !matches!(k.as_str(), "paused" | "expected_revision"))
    }) {
        bail!("INVALID_RESEARCH_CONTROL");
    }
    let paused = body["paused"]
        .as_bool()
        .ok_or_else(|| anyhow!("INVALID_RESEARCH_CONTROL"))?;
    let revision = body["expected_revision"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| anyhow!("INVALID_RESEARCH_CONTROL"))?;
    let (p, c) = (project.to_string(), conversation.to_string());
    store.call(move|db|{
        let tx=db.transaction()?;
        let old=read(&tx,&p,&c)?;
        if old["revision"] != revision { bail!("RESEARCH_CONTROL_CONFLICT"); }
        if old["paused"] != paused {
            tx.execute("INSERT INTO research_controls(project_id,conversation_id,paused,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET paused=excluded.paused,revision=excluded.revision,updated_at=excluded.updated_at",params![p,c,paused,revision+1,chat::now()])?;
        }
        let result=read(&tx,&p,&c)?; tx.commit()?; Ok(result)
    }).await
}

pub async fn notices(store: &Store, project: &str, conversation: &str) -> Result<Value> {
    scope(store, project, conversation).await?;
    let (p, c) = (project.to_string(), conversation.to_string());
    store.call(move|db|{
        let mut stmt=db.prepare("SELECT n.run_id,n.status,n.body,COALESCE(d.attempts,0),COALESCE(d.next_attempt_at,0),d.last_error,d.accepted_at FROM run_notices n JOIN runs r ON r.id=n.run_id LEFT JOIN run_notice_delivery d ON d.run_id=n.run_id WHERE r.project_id=? AND n.conversation_id=? ORDER BY n.rowid DESC LIMIT 200")?;
        let rows=stmt.query_map(params![p,c],|r|Ok(json!({"run_id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"result":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"attempts":r.get::<_,i64>(3)?,"next_attempt_at":r.get::<_,i64>(4)?,"last_error":r.get::<_,Option<String>>(5)?,"accepted_at":r.get::<_,Option<i64>>(6)?})))?;
        Ok(json!(rows.collect::<std::result::Result<Vec<_>,_>>()?))
    }).await
}

async fn retry(store: &Store, project: &str, conversation: &str, run: &str) -> Result<Value> {
    scope(store, project, conversation).await?;
    let (p, c, id) = (
        project.to_string(),
        conversation.to_string(),
        run.to_string(),
    );
    store.call(move|db|{
        let tx=db.transaction()?;
        let status:Option<String>=tx.query_row("SELECT n.status FROM run_notices n JOIN runs r ON r.id=n.run_id WHERE n.run_id=? AND r.project_id=? AND n.conversation_id=?",params![id,p,c],|r|r.get(0)).optional()?;
        let status=status.ok_or_else(||anyhow!("NOT_FOUND"))?;
        // Accepted and in-flight deliveries are never replayed by this operation.
        if status=="failed" {
            tx.execute("UPDATE run_notices SET status='pending' WHERE run_id=?",[&id])?;
            tx.execute("INSERT INTO run_notice_delivery(run_id,attempts,next_attempt_at) VALUES(?,0,0) ON CONFLICT(run_id) DO UPDATE SET attempts=0,next_attempt_at=0,last_error=NULL",[&id])?;
        }
        tx.commit()?;
        Ok(json!({"run_id":id,"status":if status=="failed"{"pending"}else{&status},"requeued":status=="failed"}))
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
    if p.first() != Some(&"projects")
        || !matches!(p.get(2), Some(&"research-control" | &"run-notices"))
    {
        return None;
    }
    Some(
        async {
            let c = q
                .get("conversation_id")
                .ok_or_else(|| anyhow!("CONVERSATION_REQUIRED"))?;
            match (method.as_str(), p[2], p.len(), p.get(4).copied()) {
                ("GET", "research-control", 3, _) => get(store, p[1], c).await,
                ("PUT", "research-control", 3, _) => set(store, p[1], c, body).await,
                ("GET", "run-notices", 3, _) => notices(store, p[1], c).await,
                ("POST", "run-notices", 5, Some("retry")) => retry(store, p[1], c, p[3]).await,
                _ => Err(anyhow!("NOT_FOUND")),
            }
        }
        .await,
    )
}

pub async fn delivery_error(store: &Store, run: String, error: String) -> Result<()> {
    store.call(move|db|{
        let tx=db.transaction()?;
        let attempts:i64=tx.query_row("SELECT attempts FROM run_notice_delivery WHERE run_id=?",[&run],|r|r.get(0))?;
        if matches!(error.as_str(),"CONVERSATION_BUSY"|"RESEARCH_PAUSED") {
            tx.execute("UPDATE run_notice_delivery SET attempts=MAX(0,attempts-1),next_attempt_at=? WHERE run_id=?",params![chat::now()+1000,run])?;
        } else {
            let delay=1000u64.saturating_mul(1u64 << (attempts-1).clamp(0,5)).min(60000);
            tx.execute("UPDATE run_notice_delivery SET next_attempt_at=?,last_error=? WHERE run_id=?",params![chat::now()+delay,error,run])?;
            if attempts>=MAX_ATTEMPTS {tx.execute("UPDATE run_notices SET status='failed' WHERE run_id=? AND status='pending'",[run])?;}
        }
        tx.commit()?;Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pause_checks_notification_acceptance_in_the_same_transaction() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::open(&dir.path().join("metadata.sqlite"))?;
        store
            .call(|db| {
                db.execute("INSERT INTO projects VALUES('p','{}')", [])?;
                Ok(())
            })
            .await?;
        let c = json!({"id":"c","project_id":"p"});
        store.save_conversation(c.clone()).await?;
        assert_eq!(
            set(
                &store,
                "p",
                "c",
                &json!({"paused":true,"expected_revision":0})
            )
            .await?["revision"],
            1
        );
        assert!(set(
            &store,
            "p",
            "c",
            &json!({"paused":false,"expected_revision":0})
        )
        .await
        .is_err());
        let message = json!({"id":"m","conversation_id":"c"});
        let error = store
            .accept_input(
                c.clone(),
                message.clone(),
                "result".into(),
                json!({}),
                json!({}),
                true,
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "RESEARCH_PAUSED");
        assert!(store.messages("c").await?.is_empty());
        assert!(store
            .input_result("c", "result", &json!({}))
            .await?
            .is_none());
        store
            .accept_input(
                c,
                message,
                "explicit-user".into(),
                json!({}),
                json!({}),
                false,
            )
            .await?;
        assert!(get(&store, "another-project", "c").await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn version_four_upgrade_backs_up_and_preserves_old_notification() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("metadata.sqlite");
        let db = Connection::open(&path)?;
        db.execute_batch("CREATE TABLE run_notices(run_id TEXT PRIMARY KEY,conversation_id TEXT,status TEXT,body TEXT); INSERT INTO run_notices VALUES('r','c','pending','{\"run_id\":\"r\"}'); PRAGMA user_version=4;")?;
        drop(db);
        let store = Store::open(&path)?;
        let backup = Connection::open(path.with_extension("pre-control-v4.sqlite"))?;
        assert_eq!(
            backup.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?,
            4
        );
        assert_eq!(
            store
                .call(|db| Ok(db.query_row(
                    "SELECT status FROM run_notices WHERE run_id='r'",
                    [],
                    |r| r.get::<_, String>(0)
                )?))
                .await?,
            "pending"
        );
        store
            .call(|db| {
                db.execute(
                    "INSERT INTO run_notice_delivery(run_id,attempts) VALUES('r',5)",
                    [],
                )?;
                Ok(())
            })
            .await?;
        delivery_error(&store, "r".into(), "unavailable".into()).await?;
        assert_eq!(
            store
                .call(|db| Ok(db.query_row(
                    "SELECT status FROM run_notices WHERE run_id='r'",
                    [],
                    |r| r.get::<_, String>(0)
                )?))
                .await?,
            "failed"
        );
        assert_eq!(
            store
                .call(|db| Ok(db.query_row(
                    "SELECT body FROM run_notices WHERE run_id='r'",
                    [],
                    |r| r.get::<_, String>(0)
                )?))
                .await?,
            "{\"run_id\":\"r\"}"
        );
        Ok(())
    }
}
