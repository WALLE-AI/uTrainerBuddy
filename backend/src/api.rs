use crate::{
    chat::{self, ChatHost},
    harness,
    store::Store,
};
use anyhow::{anyhow, Result};
use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{broadcast, Mutex};

pub struct AppState {
    pub sync_active: Mutex<std::collections::HashSet<String>>,
    pub compute: crate::compute::Compute,
    pub chat: Arc<ChatHost>,
    pub instance: String,
    pub token: String,
    pub port: u16,
    pub origin: String,
    pub codex_installed: bool,
    models: Mutex<Option<(std::time::Instant, Vec<Value>)>>,
}

impl AppState {
    pub async fn new(
        data_dir: PathBuf,
        token: String,
        port: u16,
        origin: String,
    ) -> Result<Arc<Self>> {
        let store = Store::open(&data_dir.join("metadata.sqlite"))?;
        store.call(|db|{db.execute("UPDATE transfers SET body=json_set(body,'$.status',CASE WHEN json_extract(body,'$.status')='publishing' THEN 'unreconciled' ELSE 'waiting_connection' END) WHERE json_extract(body,'$.status') IN ('queued','uploading','downloading','verifying','publishing','cancelling')",[])?;Ok(())}).await?;
        // A crashed turn has an unknown delivery outcome. Never replay it automatically.
        for mut c in store.conversations().await? {
            if c["runtime"]["is_processing"] == true {
                for mut message in store.messages(c["id"].as_str().unwrap_or_default()).await? {
                    if message["status"] == "pending"
                        && (message["type"] == "ask" || message["type"] == "acp_permission")
                    {
                        message["type"] = json!("tips");
                        message["status"] = json!("finish");
                        message["content"] =
                            json!({"type":"warning","content":"后端重启，原交互请求已失效"});
                        store.save_message(message).await?;
                    }
                }
                let message_id = chat::id();
                store.save_message(json!({"id":message_id,"msg_id":message_id,"conversation_id":c["id"],"type":"tips","content":{"type":"warning","content":"上次回合因后台退出而中断，交付结果可能不明。请检查已有结果后继续；系统不会自动重发。"},"position":"center","status":"finish","created_at":chat::now()})).await?;
                c["runtime"] = chat::runtime("idle", None, 0);
                store.save_conversation(c).await?;
            }
        }
        let (events, _) = broadcast::channel(1024);
        let compute = crate::compute::Compute::new(store.clone()).await?;
        let state = Arc::new(Self {
            sync_active: Mutex::new(Default::default()),
            compute,
            chat: Arc::new(ChatHost {
                store,
                events,
                data_dir,
                active: Mutex::new(HashMap::new()),
                gates: Mutex::new(HashMap::new()),
            }),
            instance: chat::id(),
            token,
            port,
            origin,
            codex_installed: harness::codex::find_binary().is_some(),
            models: Mutex::new(None),
        });
        crate::runs::start_engine(&state);
        Ok(state)
    }
    pub fn health(&self) -> Value {
        json!({"service":"utrainerbuddy-backend","protocol_version":1,"instance_id":self.instance,"workspace_id":"local","data_dir":self.chat.data_dir,"port":self.port})
    }
    async fn model_options(&self, selected: Option<&str>) -> Result<Value> {
        let mut cache = self.models.lock().await;
        if cache
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(60))
        {
            let binary =
                harness::codex::find_binary().ok_or_else(|| anyhow!("CODEX_NOT_INSTALLED"))?;
            let (client, mut events) = harness::codex::CodexClient::start(
                &binary,
                &self.chat.data_dir,
                &self.chat.data_dir.join("logs/catalog"),
            )
            .await?;
            let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });
            let result: Result<Vec<Value>> = async {
                let mut models = Vec::new();
                let mut cursor = Value::Null;
                loop {
                    let page = client
                        .request(
                            "model/list",
                            json!({"limit":100,"includeHidden":false,"cursor":cursor}),
                        )
                        .await?;
                    let data = page["data"]
                        .as_array()
                        .ok_or_else(|| anyhow!("Invalid Codex model catalog"))?;
                    models.extend(data.iter().filter(|m| m["hidden"] != true).cloned());
                    cursor = page["nextCursor"].clone();
                    if cursor.is_null() {
                        break;
                    }
                }
                Ok(models)
            }
            .await;
            client.stop().await;
            drain.abort();
            *cache = Some((std::time::Instant::now(), result?));
        }
        let models = &cache.as_ref().unwrap().1;
        let choices: Vec<_> = models.iter().filter_map(|m| {
            let value = m["model"].as_str().or_else(|| m["id"].as_str())?;
            Some(json!({"value":value,"name":m["displayName"].as_str().unwrap_or(value),"description":m["description"]}))
        }).collect();
        let default = models
            .iter()
            .find(|m| m["isDefault"] == true)
            .and_then(|m| m["model"].as_str().or_else(|| m["id"].as_str()));
        Ok(
            json!([{"id":"model","name":"Model","category":"model","type":"select","option_type":"select","current_value":selected.or(default),"options":choices}]),
        )
    }
    pub fn allowed_origin(&self, headers: &HeaderMap) -> bool {
        headers
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .is_none_or(|origin| origin == self.origin || origin == "null")
    }
}

pub async fn authenticate(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let headers = request.headers();
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if host != format!("127.0.0.1:{}", state.port) && host != format!("localhost:{}", state.port) {
        return failure(
            StatusCode::FORBIDDEN,
            "INVALID_HOST",
            "Invalid backend host",
        );
    }
    if !state.allowed_origin(headers) {
        return failure(
            StatusCode::FORBIDDEN,
            "INVALID_ORIGIN",
            "Invalid backend origin",
        );
    }
    let websocket = request.uri().path() == "/ws" || request.uri().path() == "/api/v1/events";
    if !websocket
        && headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some(&format!("Bearer {}", state.token))
    {
        return failure(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Backend instance authentication required",
        );
    }
    next.run(request).await
}

pub fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (status,Json(json!({"success":false,"code":code,"message":message,"error":message,"retryable":false,"request_id":chat::id()}))).into_response()
}

pub async fn api(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    method: Method,
    body: Bytes,
) -> Response {
    let body: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => return failure(StatusCode::BAD_REQUEST, "INVALID_JSON", "Invalid JSON body"),
        }
    };
    match dispatch(
        &state,
        path.trim_start_matches("v1/"),
        &query,
        &method,
        body,
    )
    .await
    {
        Ok(value) => Json(json!({"success":true,"data":value})).into_response(),
        Err(error) => {
            let message = error.to_string();
            let (status, code) = match message.as_str() {
                "NOT_FOUND" => (StatusCode::NOT_FOUND, "NOT_FOUND"),
                "CONVERSATION_BUSY" => (StatusCode::CONFLICT, "CONVERSATION_BUSY"),
                "COMPUTE_BUSY" => (StatusCode::CONFLICT, "COMPUTE_BUSY"),
                "INVALID_COMPUTE_PROFILE" => (StatusCode::BAD_REQUEST, "INVALID_COMPUTE_PROFILE"),
                "SSH_PASSWORD_REQUIRED" => (StatusCode::BAD_REQUEST, "SSH_PASSWORD_REQUIRED"),
                "COMPUTE_SESSION_CHANGED" => (StatusCode::CONFLICT, "COMPUTE_SESSION_CHANGED"),
                "SSH_SESSION_CLOSED" => (StatusCode::CONFLICT, "SSH_SESSION_CLOSED"),
                "PATH_OUTSIDE_WORKSPACE" | "REMOTE_FILE_PERMISSION_DENIED" => {
                    (StatusCode::FORBIDDEN, message.as_str())
                }
                "REMOTE_FILE_NOT_FOUND" => (StatusCode::NOT_FOUND, "REMOTE_FILE_NOT_FOUND"),
                "FILE_TOO_LARGE" => (StatusCode::PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE"),
                "INVALID_FILE_REQUEST"
                | "UNSUPPORTED_FILE_TYPE"
                | "NOT_A_DIRECTORY"
                | "REMOTE_FILE_IO_FAILED" => (StatusCode::BAD_REQUEST, message.as_str()),
                "IDEMPOTENCY_CONFLICT" => (StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT"),
                "PLAN_CONFLICT"
                | "RESEARCH_CONTROL_CONFLICT"
                | "RESEARCH_PAUSED"
                | "RESEARCH_REVISION_CONFLICT"
                | "BINDING_CONFLICT"
                | "COMPUTE_TARGET_CHANGED"
                | "TRANSFER_TERMINAL"
                | "SNAPSHOT_STALE" => (StatusCode::CONFLICT, message.as_str()),
                "NOT_IMPLEMENTED" => (StatusCode::NOT_IMPLEMENTED, "NOT_IMPLEMENTED"),
                "REQUEST_EXPIRED" | "TURN_MISMATCH" | "NO_ACTIVE_TURN" => {
                    (StatusCode::CONFLICT, "STALE_REQUEST")
                }
                code if code.len() < 100
                    && code
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') =>
                {
                    (StatusCode::BAD_REQUEST, code)
                }
                _ => (StatusCode::BAD_REQUEST, "REQUEST_FAILED"),
            };
            failure(status, code, &message)
        }
    }
}

fn assistant(installed: bool) -> Value {
    json!({"id":"codex","source":"generated","name":"Codex","name_i18n":{},"description":"模型研发伙伴 · Codex App Server","description_i18n":{},"enabled":true,"sort_order":0,"agent_id":"codex","agent":{"type":"acp","source":"builtin","acp_backend":"codex"},"enabled_skills":[],"custom_skill_names":[],"disabled_builtin_skills":[],"context_i18n":{},"prompts":[],"prompts_i18n":{},"models":[],"agent_status":if installed {"unchecked"} else {"missing"},"team_selectable":false,"deletable":false})
}

fn detail(installed: bool) -> Value {
    let a = assistant(installed);
    json!({"id":"codex","source":"generated","agent_status":a["agent_status"],"team_selectable":false,"deletable":false,
        "profile":{"name":"Codex","name_i18n":{},"description":"Codex 模型研发伙伴","description_i18n":{}},"state":{"enabled":true,"sort_order":0},
        "engine":{"agent_id":"codex","agent":a["agent"]},"rules":{"content":"","storage_mode":"inline"},"prompts":{"recommended":[],"recommended_i18n":{}},
        "defaults":{"model":{"mode":"auto"},"permission":{"mode":"auto"},"thought_level":{"mode":"auto"},"skills":{"mode":"auto","value":[]},"mcps":{"mode":"auto","value":[]}},
        "capabilities":{"default_skill_ids":[],"custom_skill_names":[],"default_disabled_builtin_skill_ids":[]},
        "preferences":{"last_skill_ids":[],"last_disabled_builtin_skill_ids":[],"last_mcp_ids":[]}})
}

async fn dispatch(
    s: &Arc<AppState>,
    path: &str,
    q: &HashMap<String, String>,
    method: &Method,
    body: Value,
) -> Result<Value> {
    if let Some(result) = crate::research_control::dispatch(&s.chat.store, method, path, q, &body).await { return result; }
    if let Some(result) = crate::runs::dispatch(&s.chat.store, &s.chat.data_dir, method, path, q, &body).await { return result; }
    if let Some(result) = crate::research_documents::dispatch(&s.chat.store, method, path, q, &body).await { return result; }
    if let Some(result) = crate::research::dispatch(&s.chat.store, method, path, q, &body).await {
        return result;
    }
    if let Some(result) = crate::project_sync::dispatch(s, method, path, q, &body).await {
        return result;
    }
    let get = method == Method::GET;
    match (method.as_str(), path) {
        ("GET", "compute/target") => return Ok(s.compute.inspect().await),
        ("PUT", "compute/target") => return s.compute.save(body).await,
        ("POST", "compute/target/connect") => return s.compute.connect(body).await,
        ("POST", "compute/target/disconnect") => return s.compute.disconnect().await,
        ("GET", "compute/target/files") | ("GET", "compute/target/file") => {
            let op = if path.ends_with("/files") {
                "list"
            } else {
                "read"
            };
            let cursor = q
                .get("cursor")
                .map(|n| n.parse::<u64>())
                .transpose()
                .map_err(|_| anyhow!("INVALID_FILE_REQUEST"))?
                .unwrap_or(0);
            return s
                .compute
                .files(
                    op,
                    q.get("path").map(String::as_str).unwrap_or(""),
                    cursor,
                    q.get("connection_id").map(String::as_str).unwrap_or(""),
                )
                .await;
        }
        ("GET", "health") => return Ok(s.health()),
        ("GET", "capabilities") => return Ok(harness::capabilities(s.codex_installed)),
        ("GET", "settings/client") => return s.chat.store.settings().await,
        ("GET", "settings") => return s.chat.store.settings().await,
        ("PUT", "settings/client") => {
            s.chat.store.update_settings(body).await?;
            return Ok(Value::Null);
        }
        ("GET", "assistants") => return Ok(json!([assistant(s.codex_installed)])),
        ("GET", "assistants/codex") => return Ok(detail(s.codex_installed)),
        ("GET", "agents/management") => {
            let options = if s.codex_installed {
                s.model_options(None).await?
            } else {
                json!([])
            };
            return Ok(
                json!([{"id":"codex","name":"Codex","backend":"codex","agent_type":"acp","agent_source":"builtin","enabled":true,"available":s.codex_installed,"installed":s.codex_installed,"status":if s.codex_installed {"unchecked"} else {"missing"},"command":"codex","args":["app-server"],"env":[],"team_capable":false,"config_options":options,"handshake":{}}]),
            );
        }
        ("GET", "system/current-user") => {
            return Ok(json!({"id":"local","username":"uTrainerBuddy"}))
        }
        ("GET", "system/info") => {
            return Ok(
                json!({"cache_dir":s.chat.data_dir.join("cache"),"work_dir":s.chat.data_dir.join("worktrees"),"log_dir":s.chat.data_dir.join("logs"),"platform":std::env::consts::OS,"arch":std::env::consts::ARCH}),
            )
        }
        ("GET", "conversations/active-count") => {
            return Ok(json!({"count":s.chat.active.lock().await.len()}))
        }
        ("GET", "sidebar") => {
            let conversations = s.chat.store.conversations().await?;
            let items: Vec<_> = conversations
                .into_iter()
                .filter(|c| c["extra"]["archived"] != true)
                .map(|c| json!({"type":"conversation","conversation":c}))
                .collect();
            return Ok(
                json!({"groups":[{"scope":{"type":"chats"},"items":items,"has_more":false}],"has_more_groups":false}),
            );
        }
        ("GET", "sidebar/items") => return Ok(json!({"items":[],"has_more":false})),
        ("GET", "conversations") => {
            let list = s.chat.store.conversations().await?;
            let start = q
                .get("cursor")
                .and_then(|cursor| {
                    list.iter()
                        .position(|item| item["id"].as_str() == Some(cursor))
                })
                .map_or(0, |index| index + 1);
            let limit = q
                .get("limit")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(100)
                .clamp(1, 500);
            let items: Vec<_> = list.iter().skip(start).take(limit).cloned().collect();
            return Ok(
                json!({"items":items,"total":list.len(),"has_more":start+items.len()<list.len()}),
            );
        }
        ("POST", "conversations") => {
            if body["assistant"]["id"]
                .as_str()
                .is_some_and(|name| name != "codex")
            {
                return Err(anyhow!("本次 MVP 仅接入 Codex"));
            }
            let id = chat::id();
            let custom = body["extra"]["workspace"]
                .as_str()
                .filter(|value| !value.is_empty());
            let cwd = if let Some(path) = custom {
                let p = PathBuf::from(path);
                if !p.is_absolute() || !p.is_dir() {
                    return Err(anyhow!("WORKSPACE_PATH_UNAVAILABLE"));
                }
                p.canonicalize()?
            } else {
                let p = s.chat.data_dir.join("worktrees").join(&id);
                tokio::fs::create_dir_all(&p).await?;
                p
            };
            let project = chat::id();
            let c = json!({"id":id,"name":body["name"].as_str().filter(|name|!name.trim().is_empty()).map(|name|name.chars().take(70).collect::<String>()).unwrap_or("新会话".into()),"type":"acp","source":"utrainerbuddy","created_at":chat::now(),"modified_at":chat::now(),"project_id":project,
                "assistant":{"id":"codex","source":"generated","name":"Codex","agent_id":"codex","agent":{"type":"acp","source":"builtin","acp_backend":"codex"}},
                "runtime":chat::runtime("idle",None,0),"extra":{"workspace":cwd,"custom_workspace":custom.is_some(),"backend":"codex","agent_name":"Codex","skills":[],"mcp_server_ids":[],"session_mode":"default","current_model_id":body["assistant"]["conversation_overrides"]["model"]}});
            s.chat.store.save_conversation(c.clone()).await?;
            s.chat.event(
                "conversation.listChanged",
                &id,
                json!({"conversation_id":id,"action":"created"}),
            );
            return Ok(c);
        }
        ("GET", "skills") | ("GET", "skills/available") => return Ok(crate::agent_resources::list()),
        ("GET", "mcp/servers") => return Ok(crate::agent_resources::mcp_servers()),
        ("GET", "models/providers")
        | ("GET", "providers")
        | ("GET", "cron/jobs")
        | ("GET", "teams")
        | ("GET", "remote-agents")
        | ("GET", "extensions")
        | ("GET", "extensions/acp-adapters") => return Ok(json!([])),
        _ => {}
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.first() == Some(&"conversations") && parts.len() >= 2 {
        let id = parts[1];
        let mut c = s
            .chat
            .store
            .conversation(id)
            .await?
            .ok_or_else(|| anyhow!("NOT_FOUND"))?;
        let suffix = parts[2..].join("/");
        match (method.as_str(), suffix.as_str()) {
            ("GET", "") => return Ok(c),
            ("PATCH", "") => {
                let gate = s.chat.gate(id).await;
                let _guard = gate.lock().await;
                c = s
                    .chat
                    .store
                    .conversation(id)
                    .await?
                    .ok_or_else(|| anyhow!("NOT_FOUND"))?;
                if let Some(name) = body["name"].as_str() {
                    c["name"] = json!(name);
                }
                if let Some(extra) = body["extra"].as_object() {
                    for key in ["pinned", "pinned_at", "archived"] {
                        if let Some(value) = extra.get(key) {
                            c["extra"][key] = value.clone();
                        }
                    }
                }
                c["modified_at"] = json!(chat::now());
                s.chat.store.save_conversation(c).await?;
                s.chat.event(
                    "conversation.listChanged",
                    id,
                    json!({"conversation_id":id,"action":"updated"}),
                );
                return Ok(json!(true));
            }
            ("DELETE", "") => {
                let gate = s.chat.gate(id).await;
                let _guard = gate.lock().await;
                if s.chat.active.lock().await.contains_key(id) {
                    return Err(anyhow!("CONVERSATION_BUSY"));
                }
                let owned = id.to_string();
                s.chat
                    .store
                    .call(move |db| {
                        db.execute("DELETE FROM conversations WHERE id=?", [owned])?;
                        Ok(())
                    })
                    .await?;
                s.chat.event(
                    "conversation.listChanged",
                    id,
                    json!({"conversation_id":id,"action":"deleted"}),
                );
                return Ok(json!(true));
            }
            ("POST", "messages") | ("POST", "inputs") => return s.chat.send(id, body).await,
            ("POST", "cancel") => {
                return s
                    .chat
                    .cancel(id, body["turn_id"].as_str().unwrap_or_default())
                    .await
            }
            ("POST", "runtime/ensure") => {
                return Ok(
                    json!({"recovered":s.chat.store.thread(id).await?.is_some(),"config_options":s.model_options(c["extra"]["current_model_id"].as_str()).await?,"runtime":c["runtime"]}),
                )
            }
            ("POST", "active-lease") => return Ok(Value::Null),
            ("GET", "config-options") => {
                return Ok(
                    json!({"config_options":s.model_options(c["extra"]["current_model_id"].as_str()).await?}),
                )
            }
            ("PUT", "config-options/model") => {
                let gate = s.chat.gate(id).await;
                let _guard = gate.lock().await;
                if s.chat.active.lock().await.contains_key(id) {
                    return Err(anyhow!("CONVERSATION_BUSY"));
                }
                let value = body["value"]
                    .as_str()
                    .ok_or_else(|| anyhow!("INVALID_MODEL"))?;
                let options = s.model_options(Some(value)).await?;
                if !options[0]["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["value"] == value)
                {
                    return Err(anyhow!("INVALID_MODEL"));
                }
                c = s
                    .chat
                    .store
                    .conversation(id)
                    .await?
                    .ok_or_else(|| anyhow!("NOT_FOUND"))?;
                c["extra"]["current_model_id"] = json!(value);
                c["modified_at"] = json!(chat::now());
                s.chat.store.save_conversation(c).await?;
                s.chat.event(
                    "conversation.listChanged",
                    id,
                    json!({"conversation_id":id,"action":"updated"}),
                );
                return Ok(json!({"confirmation":"observed","config_options":options}));
            }
            ("GET", "messages/latest") => {
                return Ok(s
                    .chat
                    .store
                    .messages(id)
                    .await?
                    .into_iter()
                    .rev()
                    .find(|item| item["type"].as_str() == q.get("type").map(String::as_str))
                    .unwrap_or(Value::Null))
            }
            ("GET", "messages") => {
                let messages = s.chat.store.messages(id).await?;
                let limit = q
                    .get("limit")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(100)
                    .clamp(1, 500);
                let before = q
                    .get("before")
                    .and_then(|key| {
                        messages
                            .iter()
                            .position(|item| item["id"].as_str() == Some(key))
                    })
                    .unwrap_or(messages.len());
                let after = q
                    .get("after")
                    .and_then(|key| {
                        messages
                            .iter()
                            .position(|item| item["id"].as_str() == Some(key))
                    })
                    .map(|index| index + 1);
                let start = after.unwrap_or_else(|| before.saturating_sub(limit));
                let end = if after.is_some() {
                    (start + limit).min(messages.len())
                } else {
                    before
                };
                let items = &messages[start.min(end)..end];
                return Ok(
                    json!({"items":items,"oldest_cursor":items.first().map(|v|&v["id"]),"newest_cursor":items.last().map(|v|&v["id"]),"has_more_before":start>0,"has_more_after":end<messages.len()}),
                );
            }
            ("GET", "associated") | ("GET", "artifacts") | ("GET", "slash-commands") => {
                return Ok(json!([]))
            }
            ("GET", "usage") => return Ok(Value::Null),
            ("GET", "confirmations") => {
                if let Some(turn) = s.chat.active.lock().await.get(id).cloned() {
                    return Ok(json!(turn.pending.lock().await.iter().map(|(key,value)|json!({"id":key,"call_id":key,"conversation_id":id,"msg_id":value["message_id"],"type":value["kind"],"description":value["content"]["tool_call"]["title"].as_str().unwrap_or("Codex 请求确认"),"options":[{"label":"允许一次","value":"accept"},{"label":"拒绝","value":"decline"}],"questions":value["content"]["questions"],"data":value["content"]})).collect::<Vec<_>>()));
                }
                return Ok(json!([]));
            }
            _ => {}
        }
        if parts.len() == 5
            && method == Method::POST
            && (parts[2] == "confirmations" || parts[2] == "asks")
        {
            s.chat
                .answer(id, parts[3], body, parts[2] == "asks")
                .await?;
            return Ok(Value::Null);
        }
        if parts.len() == 4 && get && parts[2] == "messages" {
            return s
                .chat
                .store
                .messages(id)
                .await?
                .into_iter()
                .find(|item| item["id"] == parts[3])
                .ok_or_else(|| anyhow!("NOT_FOUND"));
        }
        if suffix == "workspace" && get {
            let base = PathBuf::from(c["extra"]["workspace"].as_str().unwrap_or_default());
            let folder = base.join(q.get("path").map(String::as_str).unwrap_or(""));
            let root = base.canonicalize()?;
            let folder = folder.canonicalize()?;
            if !folder.starts_with(root) {
                return Err(anyhow!("PATH_OUTSIDE_WORKSPACE"));
            }
            let mut entries = tokio::fs::read_dir(folder).await?;
            let mut result = vec![];
            while let Some(entry) = entries.next_entry().await? {
                result.push(json!({"name":entry.file_name().to_string_lossy(),"type":if entry.file_type().await?.is_dir(){"dir"}else{"file"}}));
                if result.len() >= 2000 {
                    break;
                }
            }
            return Ok(json!(result));
        }
    }
    if parts.first() == Some(&"projects") && (parts.len() == 2 || parts.len() == 3) && get {
        let c = crate::project_sync::project(&s.chat.store, parts[1]).await?;
        if parts.len() == 3 && (parts[2] == "files" || parts[2] == "file") {
            let root = PathBuf::from(
                c["local_root"]
                    .as_str()
                    .ok_or_else(|| anyhow!("WORKSPACE_PATH_UNAVAILABLE"))?,
            )
            .canonicalize()?;
            let relative = q.get("path").map(String::as_str).unwrap_or("");
            let target = root.join(relative).canonicalize()?;
            if !target.starts_with(&root) {
                return Err(anyhow!("PATH_OUTSIDE_WORKSPACE"));
            }
            if parts[2] == "files" {
                let mut entries = tokio::fs::read_dir(target).await?;
                let mut result = Vec::new();
                while let Some(entry) = entries.next_entry().await? {
                    result.push(json!({"name":entry.file_name().to_string_lossy(),"type":if entry.file_type().await?.is_dir(){"dir"}else{"file"}}));
                    if result.len() >= 2000 {
                        break;
                    }
                }
                result.sort_by(|a, b| {
                    (a["type"] != "dir")
                        .cmp(&(b["type"] != "dir"))
                        .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
                });
                return Ok(json!(result));
            }
            let size = tokio::fs::metadata(&target).await?.len();
            let ext = target
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let binary = matches!(
                ext.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif" | "pdf"
            );
            let limit = if binary {
                20 * 1024 * 1024
            } else {
                1024 * 1024
            };
            if size > limit {
                return Err(anyhow!("FILE_TOO_LARGE"));
            }
            use tokio::io::AsyncReadExt;
            let mut bytes = Vec::new();
            tokio::fs::File::open(target)
                .await?
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() as u64 > limit {
                return Err(anyhow!("FILE_TOO_LARGE"));
            }
            return Ok(json!({"size":size,"bytes":bytes}));
        }
        return Ok(
            json!({"project_id":parts[1],"name":c["name"],"explorer":{"workspace_pe_id":parts[1],"entries":[]}}),
        );
    }
    Err(anyhow!("NOT_IMPLEMENTED"))
}

pub async fn websocket(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| stream_socket(socket, state))
}

async fn stream_socket(mut socket: WebSocket, state: Arc<AppState>) {
    // Authenticate in the first frame, keeping the instance credential out of URLs and logs.
    let authenticated =
        match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
            Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text)
                .ok()
                .is_some_and(|value| {
                    value["type"] == "authenticate" && value["token"].as_str() == Some(&state.token)
                }),
            _ => false,
        };
    if !authenticated {
        let _ = socket.close().await;
        return;
    }
    let mut events = state.chat.events.subscribe();
    let _ = socket
        .send(Message::Text(
            json!({"name":"realtime.reconnected","data":{"timestamp":chat::now()}})
                .to_string()
                .into(),
        ))
        .await;
    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            event=events.recv()=>match event{
                Ok(event)=>if sender.send(Message::Text(event.to_string().into())).await.is_err(){break},
                Err(broadcast::error::RecvError::Lagged(_))=>{let _=sender.send(Message::Close(None)).await;break},
                Err(_)=>break,
            },
            incoming=receiver.next()=>match incoming{Some(Ok(Message::Ping(bytes)))=>{let _=sender.send(Message::Pong(bytes)).await;},Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>{}}
        }
    }
}

#[cfg(test)]
mod model_tests {
    use super::*;

    #[tokio::test]
    async fn project_files_list_read_and_enforce_workspace_boundary() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path().into(), "test".into(), 1234, "null".into()).await?;
        let workspace = temp.path().join("project");
        tokio::fs::create_dir_all(workspace.join("nested")).await?;
        tokio::fs::write(workspace.join("nested/readme.md"), "# Project preview").await?;
        tokio::fs::write(temp.path().join("outside.txt"), "outside").await?;
        let query = HashMap::new();
        let created = dispatch(
            &state,
            "conversations",
            &query,
            &Method::POST,
            json!({"extra":{"workspace":workspace}}),
        )
        .await?;
        let project = created["project_id"].as_str().unwrap();
        let entries = dispatch(
            &state,
            &format!("projects/{project}/files"),
            &query,
            &Method::GET,
            Value::Null,
        )
        .await?;
        assert_eq!(entries[0]["name"], "nested");
        let query = HashMap::from([("path".into(), "nested/readme.md".into())]);
        let file = dispatch(
            &state,
            &format!("projects/{project}/file"),
            &query,
            &Method::GET,
            Value::Null,
        )
        .await?;
        let bytes: Vec<u8> = serde_json::from_value(file["bytes"].clone())?;
        assert_eq!(String::from_utf8(bytes)?, "# Project preview");
        let traversal = HashMap::from([("path".into(), "../outside.txt".into())]);
        assert!(dispatch(
            &state,
            &format!("projects/{project}/file"),
            &traversal,
            &Method::GET,
            Value::Null
        )
        .await
        .is_err());
        Ok(())
    }

    #[tokio::test]
    async fn model_catalog_and_switch_are_validated_and_persisted() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path().into(), "test".into(), 1234, "null".into()).await?;
        *state.models.lock().await = Some((
            std::time::Instant::now(),
            vec![
                json!({"model":"model-a","displayName":"Model A","isDefault":true}),
                json!({"model":"model-b","displayName":"Model B"}),
            ],
        ));
        let query = HashMap::new();
        let created = dispatch(&state, "conversations", &query, &Method::POST, json!({})).await?;
        let id = created["id"].as_str().unwrap();
        let path = format!("conversations/{id}/config-options/model");
        assert!(dispatch(
            &state,
            &path,
            &query,
            &Method::PUT,
            json!({"value":"missing"})
        )
        .await
        .is_err());
        let switched = dispatch(
            &state,
            &path,
            &query,
            &Method::PUT,
            json!({"value":"model-b"}),
        )
        .await?;
        assert_eq!(switched["confirmation"], "observed");
        assert_eq!(switched["config_options"][0]["current_value"], "model-b");
        let loaded = dispatch(
            &state,
            &format!("conversations/{id}/runtime/ensure"),
            &query,
            &Method::POST,
            Value::Null,
        )
        .await?;
        assert_eq!(
            loaded["config_options"][0]["options"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(loaded["config_options"][0]["current_value"], "model-b");
        let reopened = Store::open(&temp.path().join("metadata.sqlite"))?;
        assert_eq!(
            reopened.conversation(id).await?.unwrap()["extra"]["current_model_id"],
            "model-b"
        );
        Ok(())
    }
}
