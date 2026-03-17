/**
 * Bridge between the frontend and backend.
 *
 * In Tauri: delegates to `@tauri-apps/api` + plugins (unchanged behaviour).
 * In browser: uses JSON-RPC 2.0 over WebSocket (:2420/ws, proxied through Vite at /ws).
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

// ── WebSocket client (browser-only) ──────────────────────────────────────────

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type EventHandler = (event: TauriEvent) => void;

class BrowserBridge {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    this.connect();
  }

  private connect() {
    const url = `ws://${window.location.host}/ws`;
    console.log("[bridge] Connecting to", url);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      console.log("[bridge] Connected");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
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
      console.warn("[bridge] Connection closed, reconnecting in 1s...");
      for (const [, req] of this.pending) {
        req.reject(new Error("WebSocket closed"));
      }
      this.pending.clear();
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    });

    ws.addEventListener("error", (e) => {
      console.error("[bridge] WebSocket error:", e);
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

  invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const check = () => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.invoke<T>(method, params).then(resolve, reject);
          } else {
            setTimeout(check, 50);
          }
        };
        check();
        return;
      }

      const id = String(++this.seq);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
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

// ── invoke ────────────────────────────────────────────────────────────────────

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  return getBridge().invoke<T>(cmd, args ?? {});
}

// ── listen ────────────────────────────────────────────────────────────────────

export function listen<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void
): Promise<UnlistenFn> {
  if (isTauri) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return import("@tauri-apps/api/event").then(({ listen: tauriListen }) =>
      tauriListen<T>(event, handler as (e: any) => void)
    );
  }
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
  return "dev";
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
