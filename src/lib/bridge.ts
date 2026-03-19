/**
 * Bridge between the frontend and backend.
 *
 * All data commands (invoke/listen) go through JSON-RPC 2.0 over WebSocket
 * to the orchestrator-server (:2420/ws).  This ensures a single backend
 * regardless of whether the UI is rendered inside Tauri or a browser.
 *
 * Tauri-native APIs (window management, notifications, updater, etc.) still
 * use @tauri-apps/api when available.
 */

// ── Detection ────────────────────────────────────────────────────────────────

export const isTauri: boolean = Boolean(
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
);

// ── Types shared with Tauri's API surface ────────────────────────────────────

export type UnlistenFn = () => void;

export interface TauriEvent<T = unknown> {
  payload: T;
  event: string;
  id: number;
}

// ── Server port ──────────────────────────────────────────────────────────────

/** Returns the port injected by Tauri, falling back to localStorage. */
function getInjectedPort(): number | undefined {
  const win = window as unknown as Record<string, unknown>;
  if (win.__ORCHESTRATOR_PORT__) return win.__ORCHESTRATOR_PORT__ as number;
  const stored = localStorage.getItem("__ORCHESTRATOR_PORT__");
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n)) return n;
  }
  return undefined;
}

// ── WebSocket client (used by ALL environments) ─────────────────────────────

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method?: string;
  params?: Record<string, unknown>;
};

type RetryEntry = {
  method: string;
  params: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type EventHandler = (event: TauriEvent) => void;

type ConnectionState = "connecting" | "connected" | "disconnected";
type ConnectionStateHandler = (state: ConnectionState) => void;

/** Default timeout for RPC requests (ms). */
const RPC_TIMEOUT_MS = 30_000;

/** Max backoff delay between reconnect attempts (ms). */
const MAX_BACKOFF_MS = 10_000;

/** How often to ping the server to detect dead connections (ms). */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** Timeout for health-check pings (ms). */
const HEARTBEAT_TIMEOUT_MS = 5_000;

class BrowserBridge {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private _connectionState: ConnectionState = "connecting";
  private _connectionListeners = new Set<ConnectionStateHandler>();
  private _failCount = 0;
  private retryQueue: RetryEntry[] = [];
  private _wasConnected = false;

  constructor() {
    this.connect();
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  onConnectionStateChange(handler: ConnectionStateHandler): () => void {
    this._connectionListeners.add(handler);
    return () => this._connectionListeners.delete(handler);
  }

  private setConnectionState(state: ConnectionState) {
    if (this._connectionState === state) return;
    this._connectionState = state;
    for (const h of this._connectionListeners) {
      try { h(state); } catch {}
    }
  }

  private connect() {
    this.setConnectionState("connecting");

    // Inside Tauri the port is injected by the Rust setup as
    // window.__ORCHESTRATOR_PORT__.  Falls back to localStorage so the port
    // survives page reloads.  In a browser, use the current host (works for
    // both Vite proxy in dev and orchestrator-server in prod).
    const port = getInjectedPort();
    const url = port
      ? `ws://localhost:${port}/ws`
      : `ws://${window.location.host}/ws`;
    console.log("[bridge] Connecting to", url);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      console.log("[bridge] Connected");
      const wasReconnect = this._wasConnected;
      this._wasConnected = true;
      this._failCount = 0;
      this.setConnectionState("connected");
      // Start a periodic health-check so we detect a crashed server even when
      // the UI is idle (TCP keepalive can take minutes to surface a dead conn).
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // Flush any requests that were in-flight when the previous connection
      // closed.  Re-send them on the new connection.
      const queue = this.retryQueue.splice(0);
      for (const entry of queue) {
        this.invoke(entry.method, entry.params).then(entry.resolve, entry.reject);
      }
      // On reconnect, emit a synthetic event so components can re-sync state
      // they may have missed while disconnected.
      if (wasReconnect) {
        const handlers = this.listeners.get("bridge-reconnected");
        if (handlers) {
          const evt: TauriEvent = { payload: null, event: "bridge-reconnected", id: 0 };
          for (const h of handlers) {
            try { h(evt); } catch {}
          }
        }
      }
    });

    ws.addEventListener("message", (ev) => {
      try {
        this.handleMessage(JSON.parse(ev.data as string));
      } catch (e) {
        console.error("[bridge] Failed to parse message:", e);
      }
    });

    ws.addEventListener("close", () => {
      console.warn("[bridge] Connection closed, reconnecting...");
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      this._failCount++;
      this.setConnectionState("disconnected");

      // Re-queue in-flight requests so they are retried on reconnect
      // instead of being lost.  Move them to the retry queue and clear
      // pending so IDs don't collide.
      for (const [id, req] of this.pending) {
        this.retryQueue.push({ method: req.method!, params: req.params!, resolve: req.resolve, reject: req.reject });
        this.pending.delete(id);
      }

      // iOS standalone (home screen) PWA: WebSocket often fails on cold launch
      // but works after a page reload. Auto-reload once to work around this.
      const isStandalone = (window.navigator as unknown as Record<string, unknown>).standalone === true
        || window.matchMedia("(display-mode: standalone)").matches;
      if (isStandalone && this._failCount >= 3 && !sessionStorage.getItem("__ws_reloaded__")) {
        console.log("[bridge] Standalone mode WS failed, reloading page...");
        sessionStorage.setItem("__ws_reloaded__", "1");
        window.location.reload();
        return;
      }

      // Exponential backoff with jitter: 500ms, 1s, 2s, 4s … capped at MAX_BACKOFF_MS
      const base = Math.min(500 * Math.pow(2, this._failCount - 1), MAX_BACKOFF_MS);
      const jitter = base * 0.3 * Math.random(); // up to 30% jitter
      const delay = Math.round(base + jitter);
      console.log(`[bridge] Reconnecting in ${delay}ms (attempt ${this._failCount})`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    ws.addEventListener("error", (e) => {
      console.error("[bridge] WebSocket error:", e);
    });
  }

  private heartbeat() {
    if (this._connectionState !== "connected") return;
    const port = getInjectedPort();
    const url = port
      ? `http://localhost:${port}/health`
      : `${window.location.protocol}//${window.location.host}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    fetch(url, { signal: controller.signal })
      .then((r) => { clearTimeout(timer); if (!r.ok) throw new Error("health"); })
      .catch(() => {
        clearTimeout(timer);
        console.warn("[bridge] Heartbeat failed, closing connection");
        this.ws?.close();
      });
  }

  private handleMessage(msg: Record<string, unknown>) {
    // JSON-RPC response (has id)
    if (msg.id !== undefined && msg.id !== null) {
      const id = String(msg.id);
      const req = this.pending.get(id);
      if (req) {
        this.pending.delete(id);
        if (msg.error) {
          req.reject(
            new Error(
              ((msg.error as Record<string, unknown>).message as string) ??
                "RPC error"
            )
          );
        } else {
          req.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC notification (push event, no id)
    if (msg.method === "event") {
      const params = msg.params as Record<string, unknown>;
      const eventName = params.event as string;
      const payload = params.payload;

      const handlers = this.listeners.get(eventName);
      if (handlers) {
        const tauriEvent: TauriEvent = {
          payload,
          event: eventName,
          id: 0,
        };
        for (const handler of handlers) {
          try {
            handler(tauriEvent);
          } catch (e) {
            console.error("[bridge] Event handler error:", e);
          }
        }
      }
    }
  }

  invoke<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // Queue for retry when the connection opens.  The "open" handler
        // will flush this queue, so no polling needed.
        this.retryQueue.push({
          method,
          params,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        return;
      }

      const id = String(++this.seq);

      // Timeout: if the server doesn't respond in time, assume the connection is
      // dead (e.g. server crashed).  Close the socket so the reconnect loop
      // kicks in, and move the request to the retry queue so it is replayed
      // once the connection is re-established.
      const timeout = timeoutMs ?? RPC_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          const req = this.pending.get(id)!;
          this.pending.delete(id);
          // Re-queue for retry on reconnect rather than rejecting immediately.
          this.retryQueue.push({ method: req.method!, params: req.params!, resolve: req.resolve, reject: req.reject });
          // Force-close the socket so the reconnect loop fires.
          this.ws?.close();
        }
      }, timeout);

      this.pending.set(id, {
        resolve: (value: unknown) => { clearTimeout(timer); resolve(value as T); },
        reject: (reason: unknown) => { clearTimeout(timer); reject(reason); },
        method,
        params,
      });

      this.ws.send(
        JSON.stringify({ jsonrpc: "2.0", id, method, params })
      );
    });
  }

  listen(event: string, handler: EventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }
}

let _bridge: BrowserBridge | null = null;
function getBridge(): BrowserBridge {
  if (!_bridge) _bridge = new BrowserBridge();
  return _bridge;
}

// ── Connection state ─────────────────────────────────────────────────────────

export type { ConnectionState };

export function getConnectionState(): ConnectionState {
  return getBridge().connectionState;
}

export function onConnectionStateChange(handler: ConnectionStateHandler): () => void {
  return getBridge().onConnectionStateChange(handler);
}

// ── Server port (continued) ───────────────────────────────────────────────────

/** The port the orchestrator-server is listening on (if known). */
export function getServerPort(): number | null {
  const port = getInjectedPort();
  if (port) return port;
  // In browser mode, infer from the page URL
  const loc = window.location;
  if (loc.port) return parseInt(loc.port, 10);
  return loc.protocol === "https:" ? 443 : 80;
}

// ── invoke ────────────────────────────────────────────────────────────────────
// Always routes through the WebSocket bridge so that both Tauri and browser
// UIs share a single orchestrator-server backend.

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  return getBridge().invoke<T>(cmd, args ?? {});
}

// ── listen ────────────────────────────────────────────────────────────────────

export function listen<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void
): Promise<UnlistenFn> {
  const unlisten = getBridge().listen(event, handler as EventHandler);
  return Promise.resolve(unlisten);
}

// ── getCurrentWindow ──────────────────────────────────────────────────────────

export interface AppWindow {
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<UnlistenFn>;
  onCloseRequested(handler: () => void): Promise<UnlistenFn>;
  startDragging(): Promise<void>;
}

function makeBrowserWindow(): AppWindow {
  return {
    isFullscreen: () => Promise.resolve(Boolean(document.fullscreenElement)),
    onResized: (handler) => {
      window.addEventListener("resize", handler);
      return Promise.resolve(() => window.removeEventListener("resize", handler));
    },
    onCloseRequested: (handler) => {
      const fn = () => handler();
      window.addEventListener("beforeunload", fn);
      return Promise.resolve(() =>
        window.removeEventListener("beforeunload", fn)
      );
    },
    startDragging: () => Promise.resolve(),
  };
}

export function getCurrentWindow(): AppWindow {
  if (isTauri) {
    // Proxy that delegates lazily to Tauri's getCurrentWindow
    return {
      isFullscreen: () =>
        import("@tauri-apps/api/window").then(({ getCurrentWindow: gw }) =>
          gw().isFullscreen()
        ),
      onResized: (handler) =>
        import("@tauri-apps/api/window").then(({ getCurrentWindow: gw }) =>
          gw().onResized(handler)
        ),
      onCloseRequested: (handler) =>
        import("@tauri-apps/api/window").then(({ getCurrentWindow: gw }) =>
          gw().onCloseRequested(handler)
        ),
      startDragging: () =>
        import("@tauri-apps/api/window").then(({ getCurrentWindow: gw }) =>
          gw().startDragging()
        ),
    };
  }
  return makeBrowserWindow();
}

// ── getVersion ────────────────────────────────────────────────────────────────

export async function getVersion(): Promise<string> {
  if (isTauri) {
    const { getVersion: tauriGetVersion } = await import("@tauri-apps/api/app");
    return tauriGetVersion();
  }
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
}

// ── openUrl ───────────────────────────────────────────────────────────────────

export async function openUrl(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener");
    return tauriOpenUrl(url);
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

// ── Notifications ─────────────────────────────────────────────────────────────

export async function isPermissionGranted(): Promise<boolean> {
  if (isTauri) {
    const { isPermissionGranted: tauriIPG } = await import(
      "@tauri-apps/plugin-notification"
    );
    return tauriIPG();
  }
  return Notification.permission === "granted";
}

export async function requestPermission(): Promise<
  "granted" | "denied" | "default"
> {
  if (isTauri) {
    const { requestPermission: tauriRP } = await import(
      "@tauri-apps/plugin-notification"
    );
    return tauriRP();
  }
  const result = await Notification.requestPermission();
  return result as "granted" | "denied" | "default";
}

export function sendNotification(opts: {
  title: string;
  body?: string;
}): void {
  if (isTauri) {
    import("@tauri-apps/plugin-notification").then(({ sendNotification: tauriSN }) => {
      tauriSN(opts);
    });
    return;
  }
  if (Notification.permission === "granted") {
    new Notification(opts.title, { body: opts.body });
  }
}

// ── Updater ───────────────────────────────────────────────────────────────────

// In browser mode we always return null (no updates available).
// In Tauri mode we defer to the real plugin. Typed as `unknown` to avoid
// importing the Update class in non-Tauri bundles.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function checkUpdate(): Promise<any> {
  if (isTauri) {
    const { check } = await import("@tauri-apps/plugin-updater");
    return check();
  }
  return null;
}

// ── Process / relaunch ────────────────────────────────────────────────────────

export async function relaunch(): Promise<void> {
  if (isTauri) {
    const { relaunch: tauriRelaunch } = await import(
      "@tauri-apps/plugin-process"
    );
    return tauriRelaunch();
  }
  window.location.reload();
}

// ── Browser context menu (used by ContextMenu.tsx in browser mode) ───────────

// Track last mouse position for context menu placement
let lastMouseX = 0;
let lastMouseY = 0;
if (typeof document !== "undefined") {
  document.addEventListener("mousemove", (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
  document.addEventListener("contextmenu", (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
}

export interface BrowserContextMenuItem {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export function showBrowserContextMenu(
  items: (BrowserContextMenuItem | null)[]
): Promise<void> {
  return new Promise((resolve) => {
    document.getElementById("__bridge_ctx_menu__")?.remove();

    const menu = document.createElement("div");
    menu.id = "__bridge_ctx_menu__";
    Object.assign(menu.style, {
      position: "fixed",
      zIndex: "999999",
      background: "#2d2d2d",
      border: "1px solid #444",
      borderRadius: "6px",
      padding: "4px 0",
      minWidth: "160px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      color: "#e8e8e8",
      left: `${lastMouseX}px`,
      top: `${lastMouseY}px`,
    });

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      menu.remove();
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onEsc);
    };

    for (const item of items) {
      const el = document.createElement("div");
      if (item === null) {
        Object.assign(el.style, {
          height: "1px",
          background: "#444",
          margin: "4px 0",
        });
      } else {
        el.textContent = item.label;
        Object.assign(el.style, {
          padding: "6px 14px",
          cursor: item.disabled ? "default" : "pointer",
          color: item.disabled ? "#666" : "#e8e8e8",
          borderRadius: "3px",
          margin: "0 4px",
        });
        if (!item.disabled) {
          el.addEventListener("mouseenter", () => {
            el.style.background = "#3a3a3a";
          });
          el.addEventListener("mouseleave", () => {
            el.style.background = "transparent";
          });
          el.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            cleanup();
            item.onClick();
            resolve();
          });
        }
      }
      menu.appendChild(el);
    }

    document.body.appendChild(menu);

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
      }
    });

    const onOutsideClick = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        cleanup();
        resolve();
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cleanup();
        resolve();
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onOutsideClick);
      document.addEventListener("keydown", onEsc);
    }, 0);
  });
}
