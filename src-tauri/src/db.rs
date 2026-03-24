//! Persistent SQLite store for session metadata and usage cache.
//!
//! Schema:
//!   sessions     — replaces sessions.json; indexed by directory and timestamp
//!   usage_cache  — persists incremental JSONL byte offsets across restarts

use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::Path;

use crate::{SessionMeta, SessionUsage};

/// Open (or create) the orchestrator database at `data_dir/orchestrator.db`.
/// Applies the schema and returns a ready-to-use connection.
pub(crate) fn open_db(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join("orchestrator.db");
    let conn = Connection::open(&path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;

         CREATE TABLE IF NOT EXISTS sessions (
             id                          TEXT    PRIMARY KEY,
             name                        TEXT    NOT NULL DEFAULT '',
             created_at                  REAL    NOT NULL DEFAULT 0,
             last_active_at              REAL    NOT NULL DEFAULT 0,
             last_message_at             REAL    NOT NULL DEFAULT 0,
             directory                   TEXT    NOT NULL DEFAULT '',
             home_directory              TEXT,
             claude_session_id           TEXT,
             dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0,
             permission_mode             TEXT,
             active_time                 REAL    NOT NULL DEFAULT 0,
             has_title_been_generated    INTEGER NOT NULL DEFAULT 0,
             provider                    TEXT,
             model                       TEXT,
             plan_content                TEXT,
             parent_session_id           TEXT,
             archived                    INTEGER,
             archived_at                 REAL,
             session_type                TEXT    DEFAULT 'chat'
         );

         CREATE TABLE IF NOT EXISTS terminal_cwd (
             session_id  TEXT    PRIMARY KEY,
             cwd         TEXT    NOT NULL DEFAULT ''
         );

         CREATE INDEX IF NOT EXISTS sessions_directory
             ON sessions(directory);
         CREATE INDEX IF NOT EXISTS sessions_last_active
             ON sessions(last_active_at DESC);

         CREATE TABLE IF NOT EXISTS usage_cache (
             jsonl_path                  TEXT    PRIMARY KEY,
             byte_offset                 INTEGER NOT NULL DEFAULT 0,
             jsonl_mtime                 INTEGER NOT NULL DEFAULT 0,
             input_tokens                INTEGER NOT NULL DEFAULT 0,
             output_tokens               INTEGER NOT NULL DEFAULT 0,
             cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
             cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
             cost_usd                    REAL    NOT NULL DEFAULT 0,
             context_tokens              INTEGER NOT NULL DEFAULT 0
         );",
    )?;

    // Migration: add session_type column to existing databases
    let _ = conn.execute(
        "ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT 'chat'",
        [],
    );

    Ok(conn)
}

/// Load all sessions ordered by most-recently-active first.
pub(crate) fn db_load_sessions(conn: &Connection) -> Result<Vec<SessionMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, last_active_at, last_message_at, directory,
                home_directory, claude_session_id, dangerously_skip_permissions,
                permission_mode, active_time, has_title_been_generated,
                provider, model, plan_content, parent_session_id, archived, archived_at,
                session_type
         FROM sessions
         ORDER BY last_active_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(SessionMeta {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            last_active_at: row.get(3)?,
            last_message_at: row.get(4)?,
            directory: row.get(5)?,
            home_directory: row.get(6)?,
            claude_session_id: row.get(7)?,
            dangerously_skip_permissions: row.get::<_, bool>(8)?,
            permission_mode: row.get(9)?,
            active_time: row.get(10)?,
            has_title_been_generated: row.get::<_, bool>(11)?,
            provider: row.get(12)?,
            model: row.get(13)?,
            plan_content: row.get(14)?,
            parent_session_id: row.get(15)?,
            archived: row.get::<_, Option<bool>>(16)?,
            archived_at: row.get(17)?,
            session_type: row.get(18)?,
        })
    })?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Replace all sessions atomically (mirrors the old save_sessions behaviour).
pub(crate) fn db_save_sessions(conn: &Connection, sessions: &[SessionMeta]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sessions", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO sessions (
                 id, name, created_at, last_active_at, last_message_at, directory,
                 home_directory, claude_session_id, dangerously_skip_permissions,
                 permission_mode, active_time, has_title_been_generated,
                 provider, model, plan_content, parent_session_id, archived, archived_at,
                 session_type
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,COALESCE(?19,'chat'))",
        )?;
        for s in sessions {
            stmt.execute(params![
                s.id,
                s.name,
                s.created_at,
                s.last_active_at,
                s.last_message_at,
                s.directory,
                s.home_directory,
                s.claude_session_id,
                s.dangerously_skip_permissions,
                s.permission_mode,
                s.active_time,
                s.has_title_been_generated,
                s.provider,
                s.model,
                s.plan_content,
                s.parent_session_id,
                s.archived,
                s.archived_at,
                s.session_type,
            ])?;
        }
    }
    tx.commit()
}

/// Migrate sessions from a legacy `sessions.json` file into the DB.
/// Only inserts; existing rows are left untouched (INSERT OR IGNORE).
pub(crate) fn db_migrate_from_json(conn: &Connection, sessions: Vec<SessionMeta>) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO sessions (
                 id, name, created_at, last_active_at, last_message_at, directory,
                 home_directory, claude_session_id, dangerously_skip_permissions,
                 permission_mode, active_time, has_title_been_generated,
                 provider, model, plan_content, parent_session_id, archived, archived_at,
                 session_type
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,COALESCE(?19,'chat'))",
        )?;
        for s in sessions {
            stmt.execute(params![
                s.id,
                s.name,
                s.created_at,
                s.last_active_at,
                s.last_message_at,
                s.directory,
                s.home_directory,
                s.claude_session_id,
                s.dangerously_skip_permissions,
                s.permission_mode,
                s.active_time,
                s.has_title_been_generated,
                s.provider,
                s.model,
                s.plan_content,
                s.parent_session_id,
                s.archived,
                s.archived_at,
                s.session_type,
            ])?;
        }
    }
    tx.commit()
}

/// Persist terminal CWD for a session.
pub(crate) fn db_save_terminal_cwd(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO terminal_cwd (session_id, cwd) VALUES (?1, ?2)",
        params![session_id, cwd],
    )?;
    Ok(())
}

/// Load terminal CWD for a session. Returns None if not found.
pub(crate) fn db_load_terminal_cwd(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT cwd FROM terminal_cwd WHERE session_id = ?1",
    )?;
    stmt.query_row(params![session_id], |row| row.get::<_, String>(0))
        .optional()
}

/// Look up a cached usage entry. Returns `(byte_offset, usage, stored_mtime)`.
pub(crate) fn db_get_usage_cache(
    conn: &Connection,
    jsonl_path: &str,
) -> Result<Option<(u64, SessionUsage, u64)>> {
    let mut stmt = conn.prepare(
        "SELECT byte_offset, jsonl_mtime,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                cost_usd, context_tokens
         FROM usage_cache WHERE jsonl_path = ?1",
    )?;

    let row = stmt
        .query_row(params![jsonl_path], |row| {
            Ok((
                row.get::<_, i64>(0)? as u64,
                row.get::<_, i64>(1)? as u64,
                SessionUsage {
                    input_tokens: row.get::<_, i64>(2)? as u64,
                    output_tokens: row.get::<_, i64>(3)? as u64,
                    cache_creation_input_tokens: row.get::<_, i64>(4)? as u64,
                    cache_read_input_tokens: row.get::<_, i64>(5)? as u64,
                    cost_usd: row.get(6)?,
                    context_tokens: row.get::<_, i64>(7)? as u64,
                    is_busy: false,
                },
            ))
        })
        .optional()?;

    Ok(row.map(|(offset, mtime, usage)| (offset, usage, mtime)))
}

/// Persist an incremental usage cache entry.
pub(crate) fn db_set_usage_cache(
    conn: &Connection,
    jsonl_path: &str,
    byte_offset: u64,
    mtime: u64,
    usage: &SessionUsage,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO usage_cache (
             jsonl_path, byte_offset, jsonl_mtime,
             input_tokens, output_tokens,
             cache_creation_input_tokens, cache_read_input_tokens,
             cost_usd, context_tokens
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            jsonl_path,
            byte_offset as i64,
            mtime as i64,
            usage.input_tokens as i64,
            usage.output_tokens as i64,
            usage.cache_creation_input_tokens as i64,
            usage.cache_read_input_tokens as i64,
            usage.cost_usd,
            usage.context_tokens as i64,
        ],
    )?;
    Ok(())
}
