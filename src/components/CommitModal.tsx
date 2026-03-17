import { useState, useEffect, useRef } from "react";
import { invoke } from "../lib/bridge";

interface GitFileEntry {
  path: string;
  status: string;
  staged: boolean;
}

interface Props {
  directory: string;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: "var(--accent)",
  A: "#4ade80",
  D: "#f87171",
  R: "#fb923c",
  C: "#a78bfa",
  U: "#facc15",
};

export default function CommitModal({ directory, onClose }: Props) {
  const [allFiles, setAllFiles] = useState<GitFileEntry[]>([]);
  // selected = paths that will be included in the commit
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [isLoadingMessage, setIsLoadingMessage] = useState(true);
  const [isPushing, setIsPushing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;

    invoke<{ files: GitFileEntry[]; branch: string; isGitRepo: boolean }>("get_git_status", { directory })
      .then((result) => {
        if (cancelled) return;
        // Deduplicate: a file can appear twice (once staged, once unstaged).
        // Keep only one entry per path; prefer the staged version.
        const byPath = new Map<string, GitFileEntry>();
        for (const f of result.files) {
          const existing = byPath.get(f.path);
          if (!existing || f.staged) byPath.set(f.path, f);
        }
        const files = Array.from(byPath.values());
        setAllFiles(files);
        // Pre-check files that are already staged
        setSelected(new Set(files.filter((f) => f.staged).map((f) => f.path)));
        setIsLoadingFiles(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`Failed to get git status: ${err}`);
        setIsLoadingFiles(false);
      });

    invoke<string>("generate_commit_message", { directory })
      .then((msg) => {
        if (cancelled) return;
        setCommitMessage(msg || "");
        setIsLoadingMessage(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCommitMessage("");
        setIsLoadingMessage(false);
      });

    return () => { cancelled = true; };
  }, [directory]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [commitMessage]);

  const allChecked = allFiles.length > 0 && selected.size === allFiles.length;
  const someChecked = selected.size > 0 && selected.size < allFiles.length;

  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(allFiles.map((f) => f.path)));
  };

  const toggleFile = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handlePush = async () => {
    if (!commitMessage.trim()) { setError("Please enter a commit message."); return; }
    if (selected.size === 0) { setError("No files selected."); return; }
    setIsPushing(true);
    setError(null);
    try {
      // Stage selected files that aren't already staged
      const toStage = allFiles.filter((f) => selected.has(f.path) && !f.staged).map((f) => f.path);
      if (toStage.length > 0) await invoke("git_stage_files", { directory, files: toStage });

      // Unstage deselected files that were staged
      const toUnstage = allFiles.filter((f) => !selected.has(f.path) && f.staged).map((f) => f.path);
      if (toUnstage.length > 0) await invoke("git_unstage_files", { directory, files: toUnstage });

      await invoke("git_commit_and_push", { directory, message: commitMessage.trim() });
      onClose();
    } catch (err) {
      setError(`Push failed: ${err}`);
      setIsPushing(false);
    }
  };

  const handleGenerateMessage = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const msg = await invoke<string>("generate_commit_message", { directory });
      setCommitMessage(msg || "");
    } catch (err) {
      setError(`Failed to generate message: ${err}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const busy = isPushing || isGenerating;
  const hasNoFiles = !isLoadingFiles && allFiles.length === 0;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ background: "var(--bg-primary)", border: "1px solid var(--border-subtle)", borderRadius: 10, width: 520, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Commit &amp; Push</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Files */}
          <div>
            {isLoadingFiles ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: "6px 0" }}>Loading...</div>
            ) : hasNoFiles ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: "6px 0" }}>No changes</div>
            ) : (
              <div style={{ background: "var(--bg-secondary)", borderRadius: 6, border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
                {/* Select-all row */}
                <div
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border-subtle)", cursor: "pointer" }}
                  onClick={toggleAll}
                >
                  <Checkbox checked={allChecked} indeterminate={someChecked} onChange={toggleAll} />
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)", userSelect: "none" }}>
                    {selected.size === allFiles.length
                      ? `All ${allFiles.length} files selected`
                      : `${selected.size} / ${allFiles.length} files selected`}
                  </span>
                </div>
                {/* File rows */}
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  {allFiles.map((f, i) => (
                    <div
                      key={`${f.path}-${i}`}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: i < allFiles.length - 1 ? "1px solid var(--border-subtle)" : undefined, cursor: "pointer", opacity: selected.has(f.path) ? 1 : 0.45 }}
                      onClick={() => toggleFile(f.path)}
                    >
                      <Checkbox checked={selected.has(f.path)} onChange={() => toggleFile(f.path)} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: STATUS_COLORS[f.status] ?? "var(--text-secondary)", width: 12, textAlign: "center", flexShrink: 0 }}>
                        {f.status}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {f.path}
                      </span>
                      {f.staged && (
                        <span style={{ fontSize: 9, color: "var(--text-tertiary)", flexShrink: 0 }}>staged</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Commit message */}
          {!hasNoFiles && (
            <div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Commit message</div>
              <div style={{ position: "relative" }}>
                <textarea
                  ref={textareaRef}
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder={isLoadingMessage ? "Generating commit message..." : "Enter commit message..."}
                  disabled={busy}
                  style={{ width: "100%", minHeight: 72, resize: "none", background: "var(--bg-secondary)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "8px 10px", fontSize: 12, fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box", overflow: "hidden" }}
                  onFocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--accent)"; }}
                  onBlur={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--border-subtle)"; }}
                />
                {isLoadingMessage && !commitMessage && (
                  <div style={{ position: "absolute", right: 10, top: 10, fontSize: 11, color: "var(--text-tertiary)" }}>⏳</div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#f87171" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border-subtle)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn onClick={handleGenerateMessage} disabled={busy || isLoadingFiles || hasNoFiles}>
            {isGenerating ? "Generating..." : "Generate Message"}
          </Btn>
          <Btn onClick={onClose} disabled={busy}>Close</Btn>
          <Btn
            onClick={handlePush}
            disabled={busy || isLoadingFiles || hasNoFiles || selected.size === 0 || !commitMessage.trim()}
            primary
          >
            {isPushing ? "Pushing..." : "Push"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Checkbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate?: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      style={{ width: 13, height: 13, flexShrink: 0, accentColor: "var(--accent)", cursor: "pointer" }}
    />
  );
}

function Btn({ onClick, disabled, primary, children }: { onClick: () => void; disabled?: boolean; primary?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: primary ? "var(--accent)" : "none",
        border: primary ? "none" : "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: primary ? 600 : 400,
        color: primary ? "#fff" : "var(--text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
