use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::mpsc};

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

/// One dedicated database thread owns SQLite. No blocking database IO on Tokio workers.
#[derive(Clone)]
pub struct Store(mpsc::Sender<Job>);

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 5 {
            return Err(anyhow!("Database was created by a newer backend"));
        }
        if version == 1 {
            let backup = path.with_extension("pre-sync-v1.sqlite");
            if !backup.exists() {
                conn.execute("VACUUM INTO ?", [backup.to_string_lossy().as_ref()])?;
            }
        }
        if version == 2 {
            let backup = path.with_extension("pre-research-v2.sqlite");
            if !backup.exists() {
                conn.execute("VACUUM INTO ?", [backup.to_string_lossy().as_ref()])?;
            }
        }
        if version == 3 {
            let backup = path.with_extension("pre-runs-v3.sqlite");
            if !backup.exists() { conn.execute("VACUUM INTO ?", [backup.to_string_lossy().as_ref()])?; }
        }
        if version == 4 {
            let backup = path.with_extension("pre-control-v4.sqlite");
            if !backup.exists() { conn.execute("VACUUM INTO ?", [backup.to_string_lossy().as_ref()])?; }
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, body TEXT NOT NULL, thread_id TEXT);
            CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,seq);
            CREATE TABLE IF NOT EXISTS inputs(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, request_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(conversation_id,request_id));
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS compute_targets(id TEXT PRIMARY KEY, identity_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS project_compute_bindings(project_id TEXT PRIMARY KEY REFERENCES projects(id), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS source_snapshots(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project_id,request_key));
            CREATE TABLE IF NOT EXISTS research_sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), origin_conversation_id TEXT NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS research_scope ON research_sessions(project_id,origin_conversation_id);
            CREATE TABLE IF NOT EXISTS research_requests(project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id,request_id));
            CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project_id,conversation_id,request_id));
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conversation_id TEXT NOT NULL, experiment_id TEXT NOT NULL REFERENCES experiments(id), request_id TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project_id,conversation_id,request_id));
            CREATE TABLE IF NOT EXISTS run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS run_notices(run_id TEXT PRIMARY KEY REFERENCES runs(id), conversation_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS research_controls(project_id TEXT NOT NULL REFERENCES projects(id), conversation_id TEXT NOT NULL, paused INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,conversation_id));
            CREATE TABLE IF NOT EXISTS run_notice_delivery(run_id TEXT PRIMARY KEY REFERENCES run_notices(run_id), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, accepted_at INTEGER);
            PRAGMA user_version=5;
            COMMIT;")?;
        let mut grouped = std::collections::BTreeMap::<
            String,
            (String, std::collections::BTreeSet<String>),
        >::new();
        {
            let mut stmt = conn.prepare("SELECT body FROM conversations")?;
            for row in stmt.query_map([], |row| row.get::<_, String>(0))? {
                let value: Value = serde_json::from_str(&row?)?;
                if let (Some(id), Some(root)) = (
                    value["project_id"].as_str(),
                    value["extra"]["workspace"].as_str(),
                ) {
                    let entry = grouped.entry(id.to_string()).or_insert_with(|| {
                        (
                            value["name"].as_str().unwrap_or("Project").to_string(),
                            Default::default(),
                        )
                    });
                    entry.1.insert(
                        std::fs::canonicalize(root)
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or(root.into()),
                    );
                }
            }
        }
        for (id, (name, roots)) in grouped {
            let root = if roots.len() == 1 {
                roots.first().cloned()
            } else {
                None
            };
            let body = json!({"id":id,"project_id":id,"name":name,"local_root":root,"state":if root.is_some(){"ready"}else{"directory_conflict"},"candidates":roots});
            conn.execute(
                "INSERT OR IGNORE INTO projects(id,body) VALUES(?,?)",
                params![id, body.to_string()],
            )?;
        }
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("trainerbuddy-sqlite".into())
            .spawn(move || {
                for job in rx {
                    job(&mut conn);
                }
            })?;
        Ok(Self(tx))
    }

    pub async fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0
            .send(Box::new(move |conn| {
                let _ = tx.send(work(conn));
            }))
            .map_err(|_| anyhow!("数据库已关闭"))?;
        rx.await?
    }

    pub async fn conversation(&self, id: &str) -> Result<Option<Value>> {
        let id = id.to_string();
        self.call(move |db| {
            let raw: Option<String> = db
                .query_row("SELECT body FROM conversations WHERE id=?", [id], |row| {
                    row.get(0)
                })
                .optional()?;
            raw.map(|text| serde_json::from_str(&text).map_err(Into::into))
                .transpose()
        })
        .await
    }

    pub async fn conversations(&self) -> Result<Vec<Value>> {
        self.call(|db| {
            let mut stmt = db.prepare("SELECT body FROM conversations ORDER BY json_extract(body,'$.modified_at') DESC, id")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        }).await
    }

    pub async fn save_conversation(&self, body: Value) -> Result<()> {
        self.call(move |db| {
            if let (Some(id),Some(root))=(body["project_id"].as_str(),body["extra"]["workspace"].as_str()) {
                let project=json!({"id":id,"project_id":id,"name":body["name"],"local_root":root,"state":"ready","candidates":[root]});
                db.execute("INSERT OR IGNORE INTO projects(id,body) VALUES(?,?)",params![id,project.to_string()])?;
            }
            db.execute("INSERT INTO conversations(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![body["id"].as_str(), body.to_string()])?;
            Ok(())
        }).await
    }

    pub async fn thread(&self, id: &str) -> Result<Option<String>> {
        let id = id.to_string();
        self.call(move |db| {
            Ok(db.query_row(
                "SELECT thread_id FROM conversations WHERE id=?",
                [id],
                |row| row.get(0),
            )?)
        })
        .await
    }

    pub async fn set_thread(&self, id: &str, thread: &str) -> Result<()> {
        let (id, thread) = (id.to_string(), thread.to_string());
        self.call(move |db| {
            db.execute(
                "UPDATE conversations SET thread_id=? WHERE id=?",
                params![thread, id],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn set_research_thread(
        &self,
        id: &str,
        thread: &str,
        previous: Option<String>,
    ) -> Result<()> {
        let (id, thread) = (id.to_string(), thread.to_string());
        self.call(move |db| {
            db.execute("UPDATE conversations SET thread_id=?1, body=json_set(body,'$.extra.research_tool_thread',?1,'$.extra.research_tool_version',?4,'$.extra.prompt_version',?4,'$.extra.skill_bundle_version',?4,'$.extra.previous_native_thread',?2) WHERE id=?3",params![thread,previous,id,crate::agent_resources::VERSION])?;
            Ok(())
        }).await
    }

    pub async fn messages(&self, id: &str) -> Result<Vec<Value>> {
        let id = id.to_string();
        self.call(move |db| {
            let mut stmt =
                db.prepare("SELECT body FROM messages WHERE conversation_id=? ORDER BY seq")?;
            let rows = stmt.query_map([id], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        })
        .await
    }

    pub async fn save_message(&self, body: Value) -> Result<()> {
        self.call(move |db| {
            put_message(db, &body)?;
            Ok(())
        })
        .await
    }

    /// Idempotency applies at the input boundary, before a Codex turn can be started.
    pub async fn input_result(
        &self,
        id: &str,
        key: &str,
        request: &Value,
    ) -> Result<Option<Value>> {
        let (id, key, request) = (id.to_string(), key.to_string(), request.to_string());
        self.call(move |db| {
            let found: Option<(String, String)> = db
                .query_row(
                    "SELECT request,result FROM inputs WHERE conversation_id=? AND request_id=?",
                    params![id, key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            match found {
                Some((saved, result)) if saved == request => {
                    Ok(Some(serde_json::from_str(&result)?))
                }
                Some(_) => Err(anyhow!("IDEMPOTENCY_CONFLICT")),
                None => Ok(None),
            }
        })
        .await
    }

    pub async fn accept_input(
        &self,
        conversation: Value,
        message: Value,
        key: String,
        request: Value,
        result: Value,
        research_notice: bool,
    ) -> Result<()> {
        self.call(move |db| {
            let tx = db.transaction()?;
            let id = conversation["id"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing conversation id"))?;
            if research_notice {
                crate::research_control::require_active(&tx, conversation["project_id"].as_str().unwrap_or_default(), id)?;
            }
            tx.execute(
                "UPDATE conversations SET body=? WHERE id=?",
                params![conversation.to_string(), id],
            )?;
            put_message(&tx, &message)?;
            tx.execute(
                "INSERT INTO inputs(conversation_id,request_id,request,result) VALUES(?,?,?,?)",
                params![id, key, request.to_string(), result.to_string()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn settings(&self) -> Result<Value> {
        self.call(|db| {
            let mut result = json!({"language":"zh-CN","guid.lastAssistantId":"codex"});
            let mut stmt = db.prepare("SELECT key,value FROM settings")?;
            for row in stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (key, value) = row?;
                result[key] = serde_json::from_str(&value)?;
            }
            Ok(result)
        })
        .await
    }

    pub async fn update_settings(&self, values: Value) -> Result<()> {
        self.call(move |db| {
            let tx = db.transaction()?;
            for (key,value) in values.as_object().ok_or_else(|| anyhow!("Settings must be an object"))? {
                tx.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value.to_string()])?;
            }
            tx.commit()?; Ok(())
        }).await
    }
}

fn put_message(db: &Connection, body: &Value) -> Result<()> {
    db.execute("INSERT INTO messages(id,conversation_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        params![body["id"].as_str(),body["conversation_id"].as_str(),body.to_string()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn version_one_migration_backs_up_and_marks_conflicting_project_roots() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("metadata.sqlite");
        let db = Connection::open(&path)?;
        db.execute_batch("CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL,thread_id TEXT); PRAGMA user_version=1;")?;
        for (id, root) in [("a", "root-a"), ("b", "root-b")] {
            let root = dir.path().join(root);
            std::fs::create_dir(&root)?;
            let body = json!({"id":id,"name":"existing","project_id":"project-one","extra":{"workspace":root}});
            db.execute(
                "INSERT INTO conversations(id,body) VALUES(?,?)",
                params![id, body.to_string()],
            )?;
        }
        drop(db);
        let store = Store::open(&path)?;
        assert!(path.with_extension("pre-sync-v1.sqlite").exists());
        let project = store
            .call(|db| {
                let raw: String = db.query_row(
                    "SELECT body FROM projects WHERE id='project-one'",
                    [],
                    |r| r.get(0),
                )?;
                Ok(serde_json::from_str::<Value>(&raw)?)
            })
            .await?;
        assert_eq!(project["state"], "directory_conflict");
        assert!(project["local_root"].is_null());
        assert_eq!(project["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(store.conversations().await?.len(), 2);
        Ok(())
    }
    #[tokio::test]
    async fn input_deduplicates_and_history_survives_reopen() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("test.sqlite");
        let db = Store::open(&path)?;
        let conversation = json!({"id":"c","modified_at":1});
        db.save_conversation(conversation.clone()).await?;
        let request = json!({"content":"你好"});
        db.accept_input(
            conversation,
            json!({"id":"m","conversation_id":"c","content":{"content":"你好"}}),
            "input-1".into(),
            request.clone(),
            json!({"turn_id":"t"}),
            false,
        )
        .await?;
        assert_eq!(
            db.input_result("c", "input-1", &request).await?.unwrap()["turn_id"],
            "t"
        );
        assert!(db
            .input_result("c", "input-1", &json!({"content":"changed"}))
            .await
            .is_err());
        let reopened = Store::open(&path)?;
        assert_eq!(reopened.messages("c").await?.len(), 1);
        assert_eq!(reopened.conversations().await?.len(), 1);
        Ok(())
    }
}
