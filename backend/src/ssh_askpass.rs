//! Short-lived authenticated relay. Passwords never enter argv, environment or disk.
use anyhow::{anyhow, bail, Result};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::Command,
    task::JoinHandle,
};

pub struct Askpass {
    endpoint: String,
    token: String,
    task: JoinHandle<()>,
    delivered: Arc<AtomicBool>,
}
impl Askpass {
    pub async fn start(password: String) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = listener.local_addr()?.to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let expected = token.clone();
        let delivered = Arc::new(AtomicBool::new(false));
        let delivery = delivered.clone();
        let task = tokio::spawn(async move {
            let mut answered = false;
            while let Ok((stream, _)) = listener.accept().await {
                let mut stream = BufReader::new(stream);
                let exchange = async {
                    let mut line = String::new();
                    (&mut stream).take(16384).read_line(&mut line).await?;
                    let (token, question): (String, String) = serde_json::from_str(&line)?;
                    if token != expected {
                        bail!("Invalid askpass token");
                    }
                    let question = question.to_ascii_lowercase();
                    if answered || !question.contains("password") || question.contains("passphrase")
                    {
                        bail!("Unsupported authentication prompt");
                    }
                    answered = true;
                    let bytes = serde_json::to_vec(&password)?;
                    stream.get_mut().write_all(&bytes).await?;
                    stream.get_mut().write_all(b"\n").await?;
                    delivery.store(true, Ordering::SeqCst);
                    anyhow::Ok(())
                };
                let _ = tokio::time::timeout(Duration::from_secs(2), exchange).await;
            }
        });
        Ok(Self {
            endpoint,
            token,
            task,
            delivered,
        })
    }
    pub fn password_delivered(&self) -> bool {
        self.delivered.load(Ordering::SeqCst)
    }
    pub fn configure(&self, command: &mut Command) -> Result<()> {
        command
            .env("SSH_ASKPASS", std::env::current_exe()?)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "trainerbuddy")
            .env("TRAINERBUDDY_ASKPASS_ENDPOINT", &self.endpoint)
            .env("TRAINERBUDDY_ASKPASS_TOKEN", &self.token);
        Ok(())
    }
}
impl Drop for Askpass {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn relay() -> Result<()> {
    let exchange = async {
        let endpoint: std::net::SocketAddr =
            std::env::var("TRAINERBUDDY_ASKPASS_ENDPOINT")?.parse()?;
        if !endpoint.ip().is_loopback() {
            bail!("Invalid askpass endpoint");
        }
        let mut stream = BufReader::new(TcpStream::connect(endpoint).await?);
        let question = std::env::args().nth(1).unwrap_or_default();
        let token = std::env::var("TRAINERBUDDY_ASKPASS_TOKEN")?;
        stream
            .get_mut()
            .write_all(&serde_json::to_vec(&(token, question))?)
            .await?;
        stream.get_mut().write_all(b"\n").await?;
        let mut line = String::new();
        (&mut stream).take(16384).read_line(&mut line).await?;
        let password: String = serde_json::from_str(&line)?;
        if password.contains(['\r', '\n']) {
            bail!("Invalid multiline password");
        }
        println!("{password}");
        anyhow::Ok(())
    };
    tokio::time::timeout(Duration::from_secs(5), exchange)
        .await
        .map_err(|_| anyhow!("Askpass timeout"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn request(askpass: &Askpass, token: &str, question: &str) -> Result<String> {
        let mut stream = BufReader::new(TcpStream::connect(&askpass.endpoint).await?);
        stream
            .get_mut()
            .write_all(&serde_json::to_vec(&(token, question))?)
            .await?;
        stream.get_mut().write_all(b"\n").await?;
        let mut line = String::new();
        stream.read_line(&mut line).await?;
        Ok(line)
    }
    #[tokio::test]
    async fn password_requires_token_and_password_prompt_and_is_sent_once() -> Result<()> {
        let askpass = Askpass::start("fixture secret".into()).await?;
        assert!(request(&askpass, "wrong", "user@host's password:")
            .await?
            .is_empty());
        assert!(
            request(&askpass, &askpass.token, "Enter passphrase for key:")
                .await?
                .is_empty()
        );
        assert!(
            request(&askpass, &askpass.token, "continue connecting (yes/no)?")
                .await?
                .is_empty()
        );
        let response = request(&askpass, &askpass.token, "user@host's password:").await?;
        assert_eq!(serde_json::from_str::<String>(&response)?, "fixture secret");
        assert!(request(&askpass, &askpass.token, "user@host's password:")
            .await?
            .is_empty());
        Ok(())
    }
}
