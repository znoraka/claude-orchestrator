import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
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
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
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
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

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
      // Wait for the browser to paint the container at its correct size
      // before fitting the terminal (container transitions from display:none)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          termRef.current?.focus();
        });
      });
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

  // Cmd+F to toggle search bar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "f" && isActive) {
        e.preventDefault();
        setShowSearch((prev) => {
          if (prev) {
            searchAddonRef.current?.clearDecorations();
            setSearchQuery("");
            termRef.current?.focus();
            return false;
          }
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return true;
        });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query) {
      searchAddonRef.current?.clearDecorations();
      return;
    }
    searchAddonRef.current?.findNext(query);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        searchAddonRef.current?.findPrevious(searchQuery);
      } else {
        searchAddonRef.current?.findNext(searchQuery);
      }
    } else if (e.key === "Escape") {
      searchAddonRef.current?.clearDecorations();
      setSearchQuery("");
      setShowSearch(false);
      termRef.current?.focus();
    }
  };

  return (
    <div className="relative w-full h-full">
      {showSearch && (
        <div className="absolute top-2 right-4 z-10 flex items-center gap-1.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 shadow-lg">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find in terminal..."
            className="bg-transparent text-xs text-[var(--text-primary)] outline-none w-48 placeholder:text-[var(--text-tertiary)]"
          />
          <button
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5"
            title="Previous (Shift+Enter)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5"
            title="Next (Enter)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => {
              searchAddonRef.current?.clearDecorations();
              setSearchQuery("");
              setShowSearch(false);
              termRef.current?.focus();
            }}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5 ml-1"
            title="Close (Esc)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-container w-full h-full"
      />
    </div>
  );
}
