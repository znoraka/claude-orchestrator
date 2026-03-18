use orchestrator_core::ServerConfig;
use std::{collections::HashMap, path::PathBuf};

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

    let config = ServerConfig {
        data_dir,
        mcp_script_path,
        agent_script_paths,
        title_script_path,
    };

    let port: u16 = std::env::var("ORCHESTRATOR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2420);

    // Static dir: look for dist/ at project root
    let static_dir = std::env::var("ORCHESTRATOR_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("dist")
        });

    let actual_port = orchestrator_server::start_server(config, port, Some(static_dir)).await;
    eprintln!("[main] Server running on port {}", actual_port);

    // Block until ctrl+c (the server's own shutdown_signal handler will
    // clean up ServerState).
    std::future::pending::<()>().await;
}
