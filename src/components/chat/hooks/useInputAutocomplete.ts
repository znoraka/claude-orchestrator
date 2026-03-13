import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useInputAutocomplete(
  inputText: string,
  setInputText: (text: string) => void,
  sessionDir: string | undefined,
  inputRef: React.RefObject<HTMLTextAreaElement | null>
) {
  // File autocomplete (@mentions)
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const fileSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const atMention = useMemo(() => {
    const idx = inputText.lastIndexOf("@");
    if (idx < 0) return null;
    if (idx > 0 && inputText[idx - 1] !== " " && inputText[idx - 1] !== "\n") return null;
    const query = inputText.slice(idx + 1);
    if (query.includes(" ")) return null;
    return { index: idx, query };
  }, [inputText]);

  const showFileMenu = atMention !== null && fileSuggestions.length > 0;

  useEffect(() => {
    if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
    if (!atMention || !sessionDir) { setFileSuggestions([]); return; }
    fileSearchTimerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<string[]>("search_project_files", {
          directory: sessionDir,
          query: atMention.query,
        });
        setFileSuggestions(results);
        setFileMenuIndex(0);
      } catch { setFileSuggestions([]); }
    }, atMention.query.length === 0 ? 0 : 100);
    return () => { if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current); };
  }, [atMention?.query, sessionDir]);

  useEffect(() => {
    if (!fileMenuRef.current) return;
    const active = fileMenuRef.current.children[fileMenuIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [fileMenuIndex]);

  const selectFile = useCallback((filePath: string) => {
    if (!atMention) return;
    const before = inputText.slice(0, atMention.index);
    const after = inputText.slice(atMention.index + 1 + atMention.query.length);
    setInputText(before + "@" + filePath + " " + after);
    setFileSuggestions([]);
    inputRef.current?.focus();
  }, [atMention, inputText, setInputText, inputRef]);

  // Slash commands
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string; source: string }>>([]);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionDir) return;
    let cancelled = false;

    async function discover() {
      type Cmd = { name: string; description: string; source: string };
      const commands: Cmd[] = [];

      const builtins: Cmd[] = [
        { name: "clear", description: "Clear conversation display", source: "built-in" },
        { name: "compact", description: "Compact conversation to save context", source: "built-in" },
        { name: "session-id", description: "Copy session ID to clipboard", source: "built-in" },
        { name: "editor", description: "Set external editor command (e.g. code, cursor, zed)", source: "built-in" },
      ];

      try {
        const result = await invoke<Cmd[]>("list_slash_commands", { directory: sessionDir });
        if (!cancelled && result.length > 0) {
          const names = new Set(result.map((c) => c.name));
          setSlashCommands([...result, ...builtins.filter((b) => !names.has(b.name))]);
          return;
        }
      } catch { }

      const scanDir = async (cmdDir: string, source: string) => {
        try {
          const files = await invoke<Array<[string, boolean]>>("list_files", { partial: cmdDir });
          for (const [filePath, isDir] of files) {
            if (isDir || !filePath.endsWith(".md")) continue;
            const name = filePath.split("/").pop()!.replace(/\.md$/, "");
            let description = "";
            try {
              const content = await invoke<string>("read_file", { filePath });
              const firstLine = content.split("\n")[0] || "";
              description = firstLine.trim().replace(/^#+\s*/, "");
            } catch { }
            commands.push({ name, description, source });
          }
        } catch { }
      };

      await scanDir(sessionDir + "/.claude/commands/", "project");
      await scanDir("~/.claude/commands/", "user");

      const names = new Set(commands.map((c) => c.name));
      commands.push(...builtins.filter((b) => !names.has(b.name)));

      if (!cancelled) setSlashCommands(commands);
    }

    discover();
    return () => { cancelled = true; };
  }, [sessionDir]);

  const showSlashMenu = inputText.startsWith("/") && !inputText.includes(" ") && inputText.length > 0;
  const filteredSlashCommands = useMemo(() => {
    if (!showSlashMenu) return [];
    const query = inputText.slice(1).toLowerCase();
    return slashCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [showSlashMenu, inputText, slashCommands]);

  useEffect(() => { setSlashMenuIndex(0); }, [filteredSlashCommands.length, inputText]);

  useEffect(() => {
    if (!slashMenuRef.current) return;
    const active = slashMenuRef.current.children[slashMenuIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [slashMenuIndex]);

  const selectSlashCommand = useCallback((cmd: { name: string }) => {
    setInputText("/" + cmd.name + " ");
    inputRef.current?.focus();
  }, [setInputText, inputRef]);

  return {
    // File menu
    fileSuggestions, setFileSuggestions,
    fileMenuIndex, setFileMenuIndex,
    fileMenuRef,
    showFileMenu,
    selectFile,
    // Slash menu
    slashCommands,
    slashMenuIndex, setSlashMenuIndex,
    slashMenuRef,
    showSlashMenu,
    filteredSlashCommands,
    selectSlashCommand,
  };
}
