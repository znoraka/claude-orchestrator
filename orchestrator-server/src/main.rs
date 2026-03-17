mod ws_handler;

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use orchestrator_core::{ServerConfig, ServerState};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
pub struct AppState {
    pub server: Arc<ServerState>,
    pub event_tx: tokio::sync::broadcast::Sender<orchestrator_core::ServerEvent>,
}

async fn ws_route(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_handler::handle_socket(socket, state))
}

#[tokio::main]
async fn main() {
    // ── Resolve data dir ────────────────────────────────────────────────────
    let data_dir = std::env::var("ORCHESTRATOR_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".orchestrator")
        });

    eprintln!("[server] Data dir: {:?}", data_dir);

    // ── Resolve script paths ─────────────────────────────────────────────────
    // Look in the same resources/ dir as src-tauri uses in dev mode.
    let resources_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("src-tauri")
        .join("resources");

    let mcp_script_path = {
        let p = resources_dir.join("mcp-server.bundle.mjs");
        if p.exists() {
            eprintln!("[server] MCP script: {:?}", p);
            Some(p.to_string_lossy().to_string())
        } else {
            eprintln!("[server] MCP script not found at {:?}. Run `pnpm build:mcp`.", p);
            None
        }
    };

    let agent_script_paths: HashMap<String, String> = {
        let bridges = [
            ("claude-code", "agent-bridge.bundle.mjs"),
            ("opencode", "agent-bridge-opencode.bundle.mjs"),
            ("codex", "agent-bridge-codex.bundle.mjs"),
        ];
        let mut map = HashMap::new();
        for (provider, filename) in bridges {
            let p = resources_dir.join(filename);
            if p.exists() {
                eprintln!("[server] Agent bridge '{}': {:?}", provider, p);
                map.insert(provider.to_string(), p.to_string_lossy().to_string());
            } else {
                eprintln!("[server] Agent bridge '{}' not found at {:?}. Run `pnpm build`.", provider, p);
            }
        }
        map
    };

    let title_script_path = {
        let p = resources_dir.join("title-server.bundle.mjs");
        if p.exists() {
            eprintln!("[server] Title server script: {:?}", p);
            Some(p)
        } else {
            eprintln!("[server] Title server script not found at {:?}. Run `pnpm build:title-server`.", p);
            None
        }
    };

    // ── Build ServerState ────────────────────────────────────────────────────
    let config = ServerConfig {
        data_dir,
        mcp_script_path,
        agent_script_paths,
        title_script_path,
    };

    let (server, event_rx) = ServerState::new(config).expect("Failed to initialize ServerState");
    let event_tx = server.event_tx.0.clone();

    let state = AppState {
        server,
        event_tx: event_tx.clone(),
    };

    // Keep the initial event_rx alive so the broadcast channel stays open even
    // when no WS clients are connected (avoids "channel closed" drops).
    tokio::spawn(async move {
        let mut rx = event_rx;
        loop {
            match rx.recv().await {
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[server] Event bus lagged, dropped {} events", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // ── CORS ─────────────────────────────────────────────────────────────────
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // ── Router ───────────────────────────────────────────────────────────────
    let app = Router::new()
        .route("/ws", get(ws_route))
        .layer(cors)
        .with_state(state.clone());

    let port: u16 = std::env::var("ORCHESTRATOR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2420);

    let addr = format!("0.0.0.0:{}", port);
    eprintln!("[server] Listening on ws://{}/ws", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state))
        .await
        .expect("Server error");
}

async fn shutdown_signal(state: AppState) {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to listen for ctrl+c");
    eprintln!("[server] Shutting down...");
    state.server.shutdown();
}
