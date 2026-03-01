import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface TerminalProps {
  sessionId: string;
  isActive: boolean;
  onExit: () => void;
  onTitleChange?: (title: string) => void;
  onActivity?: () => void;
}

export default function Terminal({ sessionId, isActive, onExit, onTitleChange, onActivity }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const onActivityRef = useRef(onActivity);

  // Keep refs current without causing remounts
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; }, [onTitleChange]);
  useEffect(() => { onActivityRef.current = onActivity; }, [onActivity]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#7c5cbf",
        selectionBackground: "#264f78",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39d353",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d364",
        brightWhite: "#f0f6fc",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Send user input to PTY; track prompt submissions (Enter key) for tab ordering
    term.onData((data) => {
      invoke("write_to_pty", { sessionId, data }).catch(console.error);
      if (data === "\r") {
        onActivityRef.current?.();
      }
    });

    // OSC title change detection
    term.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    // Listen for PTY output
    const unlistenOutput = listen<string>(`pty-output-${sessionId}`, (event) => {
      term.write(event.payload);
    });

    // Listen for PTY exit
    const unlistenExit = listen(`pty-exit-${sessionId}`, () => {
      term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      onExitRef.current();
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const { cols, rows } = term;
      invoke("resize_pty", { sessionId, cols, rows }).catch(() => {});
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      term.dispose();
    };
  }, [sessionId]);

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
      fitAddonRef.current?.fit();
    }
  }, [isActive]);

  // Expose a way to write text into the terminal (for image path injection)
  const writeText = useCallback((text: string) => {
    invoke("write_to_pty", { sessionId, data: text }).catch(console.error);
  }, [sessionId]);

  // Attach writeText to the container element for parent access
  useEffect(() => {
    if (containerRef.current) {
      (containerRef.current as any).__writeText = writeText;
    }
  }, [writeText]);

  return (
    <div
      ref={containerRef}
      className="terminal-container w-full h-full"
      style={{ display: isActive ? "block" : "none" }}
    />
  );
}
