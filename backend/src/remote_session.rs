use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    task::JoinHandle,
};

pub const REMOTE_COMMAND: &str = "python3 -u -c 'import sys; exec(sys.stdin.readline())'";
pub struct RemoteSession {
    pub child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    diagnostics: Arc<Mutex<Vec<u8>>>,
    stderr_task: JoinHandle<()>,
}
impl RemoteSession {
    pub fn new(mut child: Child) -> Self {
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut stderr = child.stderr.take().unwrap();
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let buffer = diagnostics.clone();
        let stderr_task = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            while let Ok(count) = stderr.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                let mut bytes = buffer.lock().unwrap();
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > 65536 {
                    let excess = bytes.len() - 65536;
                    bytes.drain(..excess);
                }
            }
        });
        Self {
            child,
            input,
            output,
            diagnostics,
            stderr_task,
        }
    }
    pub fn diagnostic(&self) -> String {
        String::from_utf8_lossy(&self.diagnostics.lock().unwrap()).into_owned()
    }
    pub async fn drain_diagnostics(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut self.stderr_task).await;
    }
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    pub async fn start(&mut self, script: &str) -> Result<Value> {
        self.input
            .write_all(format!("exec({})\n", serde_json::to_string(script)?).as_bytes())
            .await?;
        self.input.flush().await?;
        self.read(262144).await
    }
    async fn read(&mut self, limit: u64) -> Result<Value> {
        let mut bytes = Vec::new();
        (&mut self.output)
            .take(limit + 1)
            .read_until(b'\n', &mut bytes)
            .await?;
        if bytes.is_empty() {
            bail!("SSH_SESSION_CLOSED");
        }
        if bytes.len() as u64 > limit || !bytes.ends_with(b"\n") {
            bail!("INVALID_PROBE_RESPONSE");
        }
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("INVALID_PROBE_RESPONSE"))
    }
    pub async fn request(&mut self, op: &str, path: &str, cursor: u64) -> Result<Value> {
        self.request_value(json!({"op":op,"path":path,"cursor":cursor}))
            .await
    }
    pub async fn request_value(&mut self, mut request: Value) -> Result<Value> {
        let id = crate::chat::id();
        request["id"] = json!(id);
        if serde_json::to_vec(&request)?.len() > 8 * 1024 * 1024 {
            bail!("INVALID_FILE_REQUEST");
        }
        let response = tokio::time::timeout(Duration::from_secs(120), async {
            self.input
                .write_all(format!("{request}\n").as_bytes())
                .await?;
            self.input.flush().await?;
            self.read(30 * 1024 * 1024).await
        })
        .await
        .map_err(|_| anyhow!("SSH_TIMEOUT"))??;
        if response["id"] != id {
            bail!("INVALID_PROBE_RESPONSE");
        }
        if let Some(code) = response["error"].as_str() {
            let code = match code {
                "PATH_OUTSIDE_WORKSPACE"
                | "INVALID_FILE_REQUEST"
                | "FILE_TOO_LARGE"
                | "UNSUPPORTED_FILE_TYPE"
                | "NOT_A_DIRECTORY"
                | "REMOTE_FILE_NOT_FOUND"
                | "REMOTE_FILE_PERMISSION_DENIED" => code,
                other
                    if other.len() < 80
                        && other.chars().all(|c| c.is_ascii_uppercase() || c == '_') =>
                {
                    other
                }
                _ => "REMOTE_FILE_IO_FAILED",
            };
            bail!("{code}");
        }
        response
            .get("data")
            .cloned()
            .ok_or_else(|| anyhow!("INVALID_PROBE_RESPONSE"))
    }
}
impl Drop for RemoteSession {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        self.stderr_task.abort();
    }
}
