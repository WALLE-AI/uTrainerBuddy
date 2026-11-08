use super::process_group::ProcessGroup;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, Mutex},
};

type Replies = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;

pub struct CodexClient {
    writer: mpsc::Sender<Value>,
    replies: Replies,
    next_id: AtomicU64,
    child: Mutex<Child>,
    _group: ProcessGroup,
}

pub fn find_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TRAINERBUDDY_CODEX_BIN") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let base = PathBuf::from(appdata).join("npm/node_modules/@openai/codex");
            for suffix in [
                "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
                "vendor/x86_64-pc-windows-msvc/codex/codex.exe",
            ] {
                let candidate = base.join(suffix);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
        .find(|path| path.is_file())
}

impl CodexClient {
    pub async fn start(
        binary: &Path,
        cwd: &Path,
        diagnostics: &Path,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Value>)> {
        tokio::fs::create_dir_all(diagnostics).await?;
        let mut command = Command::new(binary);
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().context("无法启动 Codex，请检查安装路径")?;
        let group = ProcessGroup::attach(
            child
                .id()
                .ok_or_else(|| anyhow!("Codex exited before initialization"))?,
        )?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (writer, mut writes) = mpsc::channel::<Value>(64);
        let replies: Replies = Arc::new(Mutex::new(HashMap::new()));
        let (events, receive_events) = mpsc::channel(1024);
        tokio::spawn(async move {
            while let Some(value) = writes.recv().await {
                let mut line = value.to_string();
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let pending = replies.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value.get("method").is_none() {
                    if let Some(id) = value.get("id") {
                        if let Some(reply) = pending.lock().await.remove(&id.to_string()) {
                            let result = if let Some(error) = value.get("error") {
                                Err(anyhow!(
                                    "Codex: {}",
                                    error["message"].as_str().unwrap_or("请求失败")
                                ))
                            } else {
                                Ok(value["result"].clone())
                            };
                            let _ = reply.send(result);
                        }
                    }
                } else if events.try_send(value).is_err() {
                    break;
                }
            }
            for (_, reply) in pending.lock().await.drain() {
                let _ = reply.send(Err(anyhow!("Codex 进程已退出")));
            }
            let _ = events.send(json!({"method":"trainer/processExited"})).await;
        });
        // Keep credentials out of application logs; stderr is a bounded diagnostic tail.
        let diagnostic_file = diagnostics.join("codex-stderr.log");
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut tail = std::collections::VecDeque::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.to_ascii_lowercase().contains("token")
                    || line.to_ascii_lowercase().contains("api_key")
                {
                    continue;
                }
                tail.push_back(line.chars().take(2000).collect::<String>());
                if tail.len() > 60 {
                    tail.pop_front();
                }
                let _ = tokio::fs::write(
                    &diagnostic_file,
                    tail.iter().cloned().collect::<Vec<_>>().join("\n"),
                )
                .await;
            }
        });
        let client = Arc::new(Self {
            writer,
            replies,
            next_id: AtomicU64::new(1),
            child: Mutex::new(child),
            _group: group,
        });
        client.request("initialize", json!({"clientInfo":{"name":"utrainerbuddy","title":"uTrainerBuddy","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        client.notify("initialized", json!({})).await?;
        Ok((client, receive_events))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.replies.lock().await.insert(id.to_string(), tx);
        if self
            .writer
            .send(json!({"id":id,"method":method,"params":params}))
            .await
            .is_err()
        {
            self.replies.lock().await.remove(&id.to_string());
            return Err(anyhow!("Codex input closed"));
        }
        match tokio::time::timeout(Duration::from_secs(45), rx).await {
            Ok(reply) => reply?,
            Err(_) => {
                self.replies.lock().await.remove(&id.to_string());
                Err(anyhow!(
                    "Codex 请求超时；输入交付状态可能不明，请检查会话后再重试"
                ))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.writer
            .send(json!({"method":method,"params":params}))
            .await
            .map_err(|_| anyhow!("Codex input closed"))
    }
    pub async fn answer(&self, id: Value, result: Value) -> Result<()> {
        self.writer
            .send(json!({"id":id,"result":result}))
            .await
            .map_err(|_| anyhow!("Codex input closed"))
    }
    pub async fn reject(&self, id: Value) -> Result<()> {
        self.writer.send(json!({"id":id,"error":{"code":-32601,"message":"This client does not support this request"}})).await.map_err(|_| anyhow!("Codex input closed"))
    }
    pub async fn stop(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}
