pub mod ws_handler;

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use orchestrator_core::{ServerConfig, ServerState};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub server: Arc<ServerState>,
    pub event_tx: broadcast::Sender<orchestrator_core::ServerEvent>,
}

async fn ws_route(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_handler::handle_socket(socket, state))
}

/// Start the orchestrator HTTP/WS server.
///
/// Tries to bind to `preferred_port` first; if that fails, binds to port 0
/// (OS-assigned random port). Returns the actual port the server is listening on.
///
/// The returned future resolves only when the server shuts down; spawn it on
/// a background task and use the returned port to connect.
pub async fn start_server(
    config: ServerConfig,
    preferred_port: u16,
    static_dir: Option<PathBuf>,
) -> u16 {
    let (server, event_rx) = ServerState::new(config).expect("Failed to initialize ServerState");
    let event_tx = server.event_tx.0.clone();

    let state = AppState {
        server,
        event_tx: event_tx.clone(),
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
            .fallback_service(serve)
            .layer(cors)
            .with_state(state.clone())
    } else {
        Router::new()
            .route("/ws", get(ws_route))
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
        axum::serve(listener, app)
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
