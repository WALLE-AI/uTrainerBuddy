//! SSH is a transport check, not ownership of a remote training process.
use crate::{chat, store::Store};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{process::Command, sync::Mutex};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub workdir: String,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
}

fn default_auth_method() -> String {
    "key".into()
}

impl Profile {
    fn validate(mut self) -> Result<Self> {
        self.host = self
            .host
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .into();
        self.username = self.username.trim().into();
        self.workdir = self.workdir.trim().into();
        self.identity_file = self.identity_file.trim().into();
        if self.port == 0
            || !matches!(self.auth_method.as_str(), "key" | "password")
            || self.host.is_empty()
            || self.host.len() > 253
            || self.host.starts_with('-')
            || !self
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c))
            || self.username.is_empty()
            || self.username.starts_with('-')
            || !self
                .username
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            || self.workdir.len() > 4096
            || self.identity_file.len() > 4096
            || self.workdir.chars().any(char::is_control)
            || self.identity_file.chars().any(char::is_control)
        {
            bail!("INVALID_COMPUTE_PROFILE");
        }
        Ok(self)
    }
}

pub struct Compute {
    state: Mutex<Value>,
    operation: Mutex<()>,
    store: Store,
    session: Mutex<Option<crate::remote_session::RemoteSession>>,
}

impl Compute {
    pub async fn new(store: Store) -> Result<Self> {
        let saved: Option<String> = store.call(|db| {
            db.execute_batch("CREATE TABLE IF NOT EXISTS compute_target(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)")?;
            use rusqlite::OptionalExtension;
            Ok(db.query_row("SELECT body FROM compute_target WHERE id=1", [], |row| row.get(0)).optional()?)
        }).await?;
        let mut state = saved.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or(json!({
            "profile": null, "status": "disconnected", "last_checked_at": null, "last_confirmed_at": null,
            "snapshot": null, "error": null
        }));
        if state["profile"].is_object() {
            if state["profile"]["auth_method"].is_null() {
                state["profile"]["auth_method"] = json!("key");
            }
            state["status"] = json!("unchecked");
        }
        state["error"] = Value::Null;
        state["files_available"] = json!(false);
        state["connection_id"] = Value::Null;
        if state["target_id"].is_null() {
            state["target_id"] = json!(chat::id());
        }
        if state["snapshot_at"].is_null() {
            state["snapshot_at"] = Value::Null;
        }
        let persisted = state.to_string();
        store.call(move|db|{db.execute("INSERT INTO compute_target(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",[persisted])?;Ok(())}).await?;
        Ok(Self {
            state: Mutex::new(state),
            operation: Mutex::new(()),
            store,
            session: Mutex::new(None),
        })
    }

    pub async fn inspect(&self) -> Value {
        let mut state = self.state.lock().await.clone();
        if let Ok(mut session) = self.session.try_lock() {
            if session.as_mut().is_some_and(|session| !session.alive()) {
                session.take();
                state["files_available"] = json!(false);
                state["status"] = json!("unreachable");
                state["error"] = json!({"code":"SSH_SESSION_CLOSED"});
            }
            if session.is_none() {
                if state["files_available"] == true {
                    state["status"] = json!("unreachable");
                    state["error"] = json!({"code":"SSH_SESSION_CLOSED"});
                }
                state["files_available"] = json!(false);
            }
        }
        if state["status"] == "reachable"
            && state["last_confirmed_at"]
                .as_u64()
                .is_some_and(|at| chat::now().saturating_sub(at) > 60_000)
        {
            state["status"] = json!("unchecked");
        }
        state
    }

    async fn persist(&self, next: Value) -> Result<Value> {
        let text = next.to_string();
        self.store.call(move |db| {
            db.execute("INSERT INTO compute_target(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [text])?;
            Ok(())
        }).await?;
        *self.state.lock().await = next.clone();
        Ok(next)
    }

    pub async fn save(&self, value: Value) -> Result<Value> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| anyhow!("COMPUTE_BUSY"))?;
        self.save_profile(serde_json::from_value::<Profile>(value)?.validate()?)
            .await
    }

    async fn save_profile(&self, profile: Profile) -> Result<Value> {
        let mut next = self.inspect().await;
        let profile = serde_json::to_value(profile)?;
        if next["profile"] != profile {
            let identity_changed = ["host", "port", "username", "workdir"]
                .iter()
                .any(|key| next["profile"][key] != profile[key]);
            let target_id = if identity_changed {
                json!(chat::id())
            } else {
                next["target_id"].clone()
            };
            self.session.lock().await.take();
            next = json!({"profile":profile,"status":"unchecked","last_checked_at":null,"last_confirmed_at":null,"snapshot":null,"error":null});
            next["target_id"] = target_id;
            next["snapshot_at"] = Value::Null;
            next["files_available"] = json!(false);
            next["connection_id"] = Value::Null;
        }
        self.persist(next).await
    }

    pub async fn disconnect(&self) -> Result<Value> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| anyhow!("COMPUTE_BUSY"))?;
        let mut next = self.inspect().await;
        self.session.lock().await.take();
        next["status"] = json!("disconnected");
        next["files_available"] = json!(false);
        next["connection_id"] = Value::Null;
        next["error"] = Value::Null;
        self.persist(next).await
    }

    pub async fn connect(&self, mut value: Value) -> Result<Value> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| anyhow!("COMPUTE_BUSY"))?;
        let password = value.as_object_mut().and_then(|v| v.remove("password"));
        let password = password.as_ref().and_then(Value::as_str).map(str::to_owned);
        let profile = serde_json::from_value::<Profile>(value)?.validate()?;
        if profile.auth_method == "password"
            && password
                .as_ref()
                .is_none_or(|p| p.is_empty() || p.len() > 4096 || p.contains(['\r', '\n', '\0']))
        {
            bail!("SSH_PASSWORD_REQUIRED");
        }
        let mut next = self.save_profile(profile.clone()).await?;
        self.session.lock().await.take();
        next["status"] = json!("checking");
        next["files_available"] = json!(false);
        next["connection_id"] = Value::Null;
        next["error"] = Value::Null;
        *self.state.lock().await = next.clone();
        let outcome = probe(&profile, password).await;
        next["last_checked_at"] = json!(chat::now());
        match outcome {
            Ok((snapshot, session)) => {
                let identity = trainerbuddy_host::digest(&serde_json::to_vec(
                    &json!({"host":profile.host,"port":profile.port,"username":profile.username,"workdir":snapshot["workdir"]["path"],"host_key":snapshot["ssh_host_key"],"hostname":snapshot["hostname"]}),
                )?);
                let candidate = next["target_id"].as_str().unwrap_or("").to_owned();
                let config = json!({"profile":profile,"hostname":snapshot["hostname"],"host_key":snapshot["ssh_host_key"]});
                let target_id=self.store.call(move|db|{let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM compute_targets WHERE id=?)",[&candidate],|r|r.get(0))?;let candidate=if exists{chat::id()}else{candidate};Ok(db.query_row("INSERT INTO compute_targets(id,identity_key,body) VALUES(?,?,?) ON CONFLICT(identity_key) DO UPDATE SET body=excluded.body RETURNING id",rusqlite::params![candidate,identity,config.to_string()],|row|row.get::<_,String>(0))?)}).await?;
                next["target_id"] = json!(target_id);
                next["status"] = json!("reachable");
                next["last_confirmed_at"] = next["last_checked_at"].clone();
                next["snapshot"] = snapshot;
                next["snapshot_at"] = next["last_checked_at"].clone();
                next["files_available"] = json!(true);
                next["connection_id"] = json!(chat::id());
                *self.session.lock().await = Some(session);
            }
            Err(code) => {
                next["status"] = json!("unreachable");
                next["error"] = json!({"code":code});
            }
        }
        // Even a storage failure must not leave the in-memory operation checking forever.
        *self.state.lock().await = next.clone();
        self.persist(next).await
    }

    pub async fn files(
        &self,
        op: &str,
        path: &str,
        cursor: u64,
        connection_id: &str,
    ) -> Result<Value> {
        if path.len() > 4096
            || path.starts_with('/')
            || path.contains('\0')
            || path.split('/').any(|part| part == "..")
            || cursor > 10000
        {
            bail!("PATH_OUTSIDE_WORKSPACE");
        }
        let _operation = self.operation.lock().await;
        let mut next = self.inspect().await;
        if next["connection_id"].as_str() != Some(connection_id) || connection_id.is_empty() {
            bail!("COMPUTE_SESSION_CHANGED");
        }
        let mut session = self.session.lock().await;
        let remote = session
            .as_mut()
            .ok_or_else(|| anyhow!("SSH_SESSION_CLOSED"))?;
        let result = remote.request(op, path, cursor).await;
        let file_error = result.as_ref().err().is_some_and(|error| {
            matches!(
                error.to_string().as_str(),
                "PATH_OUTSIDE_WORKSPACE"
                    | "INVALID_FILE_REQUEST"
                    | "FILE_TOO_LARGE"
                    | "UNSUPPORTED_FILE_TYPE"
                    | "NOT_A_DIRECTORY"
                    | "REMOTE_FILE_NOT_FOUND"
                    | "REMOTE_FILE_PERMISSION_DENIED"
                    | "REMOTE_FILE_IO_FAILED"
            )
        });
        next["last_checked_at"] = json!(chat::now());
        if result.is_ok() || file_error {
            next["last_confirmed_at"] = next["last_checked_at"].clone();
            next["status"] = json!("reachable");
            next["error"] = Value::Null;
        } else {
            session.take();
            next["files_available"] = json!(false);
            next["status"] = json!("unreachable");
            next["error"] = json!({"code":"SSH_SESSION_CLOSED"});
        }
        drop(session);
        self.persist(next).await?;
        result.map_err(|error| {
            if file_error {
                error
            } else {
                anyhow!("SSH_SESSION_CLOSED")
            }
        })
    }

    pub async fn rpc(&self, target_id: &str, connection_id: &str, request: Value) -> Result<Value> {
        let _operation = self.operation.lock().await;
        let state = self.inspect().await;
        if state["target_id"] != target_id {
            bail!("COMPUTE_TARGET_CHANGED");
        }
        if state["connection_id"] != connection_id || connection_id.is_empty() {
            bail!("SSH_SESSION_CLOSED");
        }
        let mut sessions = self.session.lock().await;
        let session = sessions
            .as_mut()
            .ok_or_else(|| anyhow!("SSH_SESSION_CLOSED"))?;
        session.request_value(request).await
    }
}

fn ssh_command(profile: &Profile) -> Command {
    let mut command =
        Command::new(std::env::var_os("TRAINERBUDDY_SSH_BIN").unwrap_or_else(|| "ssh".into()));
    command.args([
        "-v",
        "-T",
        "-o",
        if profile.auth_method == "password" {
            "BatchMode=no"
        } else {
            "BatchMode=yes"
        },
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-p",
        &profile.port.to_string(),
        "-l",
        &profile.username,
    ]);
    if profile.auth_method == "password" {
        command.args([
            "-o",
            "PreferredAuthentications=password,keyboard-interactive",
            "-o",
            "PubkeyAuthentication=no",
            "-o",
            "NumberOfPasswordPrompts=1",
        ]);
    }
    if profile.auth_method == "key" && !profile.identity_file.is_empty() {
        command.arg("-i").arg(&profile.identity_file);
    }
    // All user values are local argv or structured stdin. Never interpolate into the remote shell.
    command
        .arg("--")
        .arg(&profile.host)
        .arg(crate::remote_session::REMOTE_COMMAND);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn probe(
    profile: &Profile,
    password: Option<String>,
) -> std::result::Result<(Value, crate::remote_session::RemoteSession), String> {
    let askpass = if profile.auth_method == "password" {
        Some(
            crate::ssh_askpass::Askpass::start(password.unwrap_or_default())
                .await
                .map_err(|_| "SSH_START_FAILED".to_string())?,
        )
    } else {
        None
    };
    let mut command = ssh_command(profile);
    if let Some(relay) = &askpass {
        relay
            .configure(&mut command)
            .map_err(|_| "SSH_START_FAILED".to_string())?;
    }
    let child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "SSH_NOT_INSTALLED"
        } else {
            "SSH_START_FAILED"
        }
        .to_string()
    })?;
    let mut session = crate::remote_session::RemoteSession::new(child);
    let script = format!(
        "CONFIG = {}\n{}\n{}\n{}",
        serde_json::to_string(&serde_json::to_string(profile).unwrap()).unwrap(),
        include_str!("compute_probe.py"),
        include_str!("host_bridge.py"),
        include_str!("remote_files.py")
    );
    let outcome = tokio::time::timeout(Duration::from_secs(30), session.start(&script)).await;
    let mut snapshot = match outcome {
        Ok(Ok(snapshot)) => snapshot,
        Err(_) => return Err("SSH_TIMEOUT".into()),
        Ok(Err(error)) => {
            if error.to_string() == "INVALID_PROBE_RESPONSE" {
                return Err("INVALID_PROBE_RESPONSE".into());
            }
            let status = tokio::time::timeout(Duration::from_secs(2), session.child.wait()).await;
            // The stderr drain finishes after process exit; wait for its diagnostics.
            session.drain_diagnostics().await;
            let diagnostic = session.diagnostic();
            let exit = status.ok().and_then(Result::ok).and_then(|s| s.code());
            let code = classify_failure(&diagnostic, exit);
            return Err(authentication_failure_code(
                code,
                &diagnostic,
                profile.auth_method == "password",
                askpass.as_ref().is_some_and(|a| a.password_delivered()),
                diagnostic.contains("Authenticated to "),
            )
            .into());
        }
    };
    tokio::task::yield_now().await;
    snapshot["ssh_host_key"] = session
        .diagnostic()
        .lines()
        .rev()
        .find_map(|line| {
            line.split_once("Server host key:")
                .map(|(_, key)| json!(key.trim()))
        })
        .unwrap_or(Value::Null);
    if snapshot["protocol_version"] != 1
        || !snapshot["hostname"].is_string()
        || !snapshot["gpus"].is_array()
        || !snapshot["workdir"]["exists"].is_boolean()
    {
        return Err("INVALID_PROBE_RESPONSE".into());
    }
    let valid_gpus = snapshot["gpus"].as_array().unwrap().iter().all(|gpu| {
        ["uuid", "name", "driver"]
            .iter()
            .all(|key| gpu[key].is_string())
            && ["memory_total_mib", "memory_free_mib"]
                .iter()
                .all(|key| gpu[key].as_f64().is_some_and(|n| n >= 0.0))
    });
    if !valid_gpus
        || !["os", "arch", "python"]
            .iter()
            .all(|key| snapshot[key].is_string())
        || !snapshot["workdir"]["path"].is_string()
        || !snapshot["workdir"]["writable"].is_boolean()
        || !snapshot["host"]["installed"].is_boolean()
        || !(snapshot["gpu_error"].is_null() || snapshot["gpu_error"].is_string())
    {
        return Err("INVALID_PROBE_RESPONSE".into());
    }
    Ok((snapshot, session))
}

fn authentication_failure_code<'a>(
    code: &'a str,
    diagnostic: &str,
    password_mode: bool,
    delivered: bool,
    authenticated: bool,
) -> &'a str {
    if authenticated && matches!(code, "SSH_AUTH_FAILED" | "SSH_CONNECTION_FAILED") {
        return "REMOTE_PROBE_FAILED";
    }
    if code != "SSH_AUTH_FAILED" || !password_mode {
        return code;
    }
    let methods = diagnostic.lines().rev().find_map(|line| {
        line.split_once("Authentications that can continue:")
            .map(|(_, methods)| methods.trim())
    });
    if methods.is_some_and(|m| {
        !m.split(',')
            .any(|method| matches!(method.trim(), "password" | "keyboard-interactive"))
    }) {
        return "SSH_PASSWORD_AUTH_UNAVAILABLE";
    }
    if delivered {
        "SSH_PASSWORD_REJECTED"
    } else {
        "SSH_PASSWORD_NOT_DELIVERED"
    }
}

fn classify_failure(stderr: &str, exit: Option<i32>) -> &'static str {
    let error = stderr.to_ascii_lowercase();
    if error.contains("remote host identification has changed") {
        "HOST_KEY_CHANGED"
    } else if error.contains("host key verification failed") {
        "HOST_KEY_UNTRUSTED"
    } else if error.contains("connect to host") && error.contains("permission denied") {
        "SSH_NETWORK_DENIED"
    } else if error.contains("permission denied") || error.contains("authentication failed") {
        "SSH_AUTH_FAILED"
    } else if error.contains("could not resolve hostname") {
        "SSH_DNS_FAILED"
    } else if error.contains("connection refused") {
        "SSH_REFUSED"
    } else if error.contains("timed out") {
        "SSH_TIMEOUT"
    } else if exit == Some(127) || error.contains("python3: not found") {
        "PYTHON_MISSING"
    } else {
        "SSH_CONNECTION_FAILED"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            host: "gpu-lab".into(),
            port: 22,
            username: "researcher".into(),
            auth_method: "key".into(),
            ..Default::default()
        }
    }
    #[test]
    fn rejects_options_and_shell_input() {
        for host in [
            "-oProxyCommand=evil",
            "user@host",
            "host;id",
            "host\n",
            "$(id)",
        ] {
            let mut p = profile();
            p.host = host.into();
            // Surrounding whitespace is normalized; embedded control input is rejected.
            if host != "host\n" {
                assert!(p.validate().is_err(), "{host}");
            }
        }
        let mut p = profile();
        p.host = "[2001:db8::1]".into();
        assert_eq!(p.validate().unwrap().host, "2001:db8::1");
        let mut p = profile();
        p.workdir = "/workspace/it's a test; $(id)".into();
        let args: Vec<_> = ssh_command(&p)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args.last().unwrap(), crate::remote_session::REMOTE_COMMAND);
        assert!(!args.iter().any(|a| a.contains("$(id)")));
    }
    #[test]
    fn distinguishes_trust_auth_and_network() {
        assert_eq!(
            classify_failure("Host key verification failed.", Some(255)),
            "HOST_KEY_UNTRUSTED"
        );
        assert_eq!(
            classify_failure("REMOTE HOST IDENTIFICATION HAS CHANGED!", Some(255)),
            "HOST_KEY_CHANGED"
        );
        assert_eq!(
            classify_failure("Permission denied (publickey).", Some(255)),
            "SSH_AUTH_FAILED"
        );
        assert_eq!(
            classify_failure("Connection refused", Some(255)),
            "SSH_REFUSED"
        );
        assert_eq!(
            classify_failure(
                "ssh: connect to host example port 22: Permission denied",
                Some(255)
            ),
            "SSH_NETWORK_DENIED"
        );
        assert_eq!(
            authentication_failure_code(
                "SSH_AUTH_FAILED",
                "debug1: Authentications that can continue: publickey,password",
                true,
                false,
                false
            ),
            "SSH_PASSWORD_NOT_DELIVERED"
        );
        assert_eq!(
            authentication_failure_code(
                "SSH_AUTH_FAILED",
                "debug1: Authentications that can continue: publickey,password",
                true,
                true,
                false
            ),
            "SSH_PASSWORD_REJECTED"
        );
        assert_eq!(
            authentication_failure_code(
                "SSH_AUTH_FAILED",
                "debug1: Authentications that can continue: publickey",
                true,
                false,
                false
            ),
            "SSH_PASSWORD_AUTH_UNAVAILABLE"
        );
        assert_eq!(
            authentication_failure_code("SSH_AUTH_FAILED", "", true, true, true),
            "REMOTE_PROBE_FAILED"
        );
    }
    #[tokio::test]
    async fn snapshots_survive_restart_but_contact_is_unchecked() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::open(&dir.path().join("db"))?;
        let compute = Compute::new(store.clone()).await?;
        compute.save(serde_json::to_value(profile())?).await?;
        let mut snapshot = compute.inspect().await;
        snapshot["status"] = json!("reachable");
        snapshot["last_confirmed_at"] = json!(123);
        compute.persist(snapshot).await?;
        let restored = Compute::new(store).await?.inspect().await;
        assert_eq!(restored["status"], "unchecked");
        assert_eq!(restored["last_confirmed_at"], 123);
        let mut changed = profile();
        changed.host = "other".into();
        let saved = compute.save(serde_json::to_value(changed)?).await?;
        assert!(saved["last_confirmed_at"].is_null());
        Ok(())
    }
}
