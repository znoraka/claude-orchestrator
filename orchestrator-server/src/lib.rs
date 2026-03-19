pub mod ws_handler;

use axum::{
    extract::{ConnectInfo, State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use orchestrator_core::{commands, ServerConfig, ServerState};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub server: Arc<ServerState>,
    pub event_tx: broadcast::Sender<orchestrator_core::ServerEvent>,
    pub external_access: Arc<AtomicBool>,
}

async fn health_route() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn ws_route(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let is_local = addr.ip().is_loopback();
    if !is_local && !state.external_access.load(Ordering::Relaxed) {
        eprintln!("[server] Rejected external WS connection from {}", addr);
        return Err(axum::http::StatusCode::FORBIDDEN);
    }
    Ok(ws.on_upgrade(move |socket| ws_handler::handle_socket(socket, state)))
}

/// Start the orchestrator HTTP/WS server.
///
/// Always binds to `0.0.0.0` so the port is reachable from both localhost and
/// the network.  Non-localhost WebSocket connections are rejected at the handler
/// level unless `external_access` is enabled (toggled at runtime, no restart).
///
/// Returns the actual port the server is listening on.
pub async fn start_server(
    config: ServerConfig,
    preferred_port: u16,
    static_dir: Option<PathBuf>,
) -> u16 {
    // Read persisted external_access setting
    let ext = commands::read_external_access(&config.data_dir);
    let external_access = Arc::new(AtomicBool::new(ext));
    eprintln!("[server] External access: {}", ext);

    let (server, event_rx) = ServerState::new(config).expect("Failed to initialize ServerState");
    let event_tx = server.event_tx.0.clone();

    let state = AppState {
        server,
        event_tx: event_tx.clone(),
        external_access,
    };

    // Keep the initial event_rx alive so the broadcast channel stays open even
    // when no WS clients are connected.
    tokio::spawn(async move {
        let mut rx = event_rx;
        loop {
            match rx.recv().await {
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[server] Event bus lagged, dropped {} events", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Static file serving (SPA)
    let has_static = static_dir
        .as_ref()
        .map(|d| d.join("index.html").exists())
        .unwrap_or(false);

    if has_static {
        eprintln!(
            "[server] Serving static files from {:?}",
            static_dir.as_ref().unwrap()
        );
    }

    let app = if has_static {
        let dir = static_dir.as_ref().unwrap();
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).fallback(ServeFile::new(&index));
        Router::new()
            .route("/ws", get(ws_route))
            .route("/health", get(health_route))
            .fallback_service(serve)
            .layer(cors)
            .with_state(state.clone())
    } else {
        Router::new()
            .route("/ws", get(ws_route))
            .route("/health", get(health_route))
            .layer(cors)
            .with_state(state.clone())
    };

    // Try preferred port, fall back to OS-assigned
    let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", preferred_port)).await
    {
        Ok(l) => {
            eprintln!("[server] Bound to port {}", preferred_port);
            l
        }
        Err(e) => {
            eprintln!(
                "[server] Port {} unavailable ({}), binding to random port",
                preferred_port, e
            );
            tokio::net::TcpListener::bind("0.0.0.0:0")
                .await
                .expect("Failed to bind to any port")
        }
    };

    let actual_port = listener.local_addr().unwrap().port();

    if has_static {
        eprintln!(
            "[server] Listening on http://0.0.0.0:{} (UI + WebSocket)",
            actual_port
        );
    } else {
        eprintln!(
            "[server] Listening on ws://0.0.0.0:{}/ws (WebSocket only)",
            actual_port
        );
    }

    // Spawn the server so we can return the port immediately
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal(state))
        .await
        .expect("Server error");
    });

    actual_port
}

async fn shutdown_signal(state: AppState) {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to listen for ctrl+c");
    eprintln!("[server] Shutting down...");
    state.server.shutdown();
}
