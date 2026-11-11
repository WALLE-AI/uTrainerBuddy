mod api;
mod chat;
mod compute;
mod harness;
mod project_sync;
mod remote_session;
mod research;
mod research_tools;
mod ssh_askpass;
mod store;

use anyhow::{anyhow, Result};
use axum::{
    middleware,
    routing::{any, get},
    Router,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{io::Write, path::PathBuf};
use tokio::io::{AsyncBufReadExt, BufReader};
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::var_os("TRAINERBUDDY_ASKPASS_ENDPOINT").is_some() {
        return ssh_askpass::relay().await;
    }
    let args: Vec<String> = std::env::args().collect();
    let data_dir = args
        .windows(2)
        .find(|pair| pair[0] == "--data-dir")
        .map(|pair| PathBuf::from(&pair[1]))
        .ok_or_else(|| anyhow!("--data-dir is required"))?;
    tokio::fs::create_dir_all(&data_dir).await?;
    let data_dir = data_dir.canonicalize()?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join("backend.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow!("此工作区已有 Backend 在运行"))?;
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let config: Value = serde_json::from_str(
        &stdin
            .next_line()
            .await?
            .ok_or_else(|| anyhow!("Missing private startup configuration"))?,
    )?;
    let token = config["token"]
        .as_str()
        .filter(|token| token.len() >= 32)
        .ok_or_else(|| anyhow!("Invalid instance credential"))?
        .to_string();
    let origin = config["origin"]
        .as_str()
        .unwrap_or("http://localhost:5174")
        .to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let state = api::AppState::new(data_dir, token, port, origin.clone()).await?;
    let cors = CorsLayer::new()
        .allow_origin([origin.parse()?, "null".parse()?])
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PATCH,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
        ])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ]);
    let app = Router::new()
        .route("/api/v1/events", get(api::websocket))
        .route("/ws", get(api::websocket))
        .route("/api/{*path}", any(api::api))
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            api::authenticate,
        ))
        .layer(cors)
        .with_state(state.clone());
    println!(
        "{}",
        json!({"type":"ready","protocol_version":1,"instance_id":state.instance,"workspace_id":"local","port":port,"data_dir":state.chat.data_dir})
    );
    std::io::stdout().flush()?;
    let shutdown = state.clone();
    axum::serve(listener,app).with_graceful_shutdown(async move{
        tokio::select!{_=tokio::signal::ctrl_c()=>{},_=async {while let Ok(Some(line))=stdin.next_line().await {if line=="shutdown"{break}}}=>{}}
        shutdown.chat.shutdown().await;
    }).await?;
    Ok(())
}
