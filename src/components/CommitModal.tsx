import { useState, useEffect, useRef } from "react";
import { invoke } from "../lib/bridge";
import FileDiffModal from "./FileDiffModal";

interface GitFileEntry {
  path: string;
  status: string;
  staged: boolean;
}

interface Props {
  directory: string;
  onClose: () => void;
  visible?: boolean;
  onOpenInChat: (selectedFiles: string[], opts: { newBranch: boolean; branchName: string }) => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: "var(--accent)",
  A: "#4ade80",
  D: "#f87171",
  R: "#fb923c",
  C: "#a78bfa",
  U: "#facc15",
};

export default function CommitModal({ directory, onClose, visible = true, onOpenInChat }: Props) {
  const [allFiles, setAllFiles] = useState<GitFileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [refreshKey] = useState(0);
  const [fileDiffModal, setFileDiffModal] = useState<{ path: string; diff: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setIsLoadingFiles(true);

    invoke<{ files: GitFileEntry[]; branch: string; isGitRepo: boolean }>("get_git_status", { directory })
      .then((result) => {
        if (cancelled) return;
        const byPath = new Map<string, GitFileEntry>();
        for (const f of result.files) {
          const existing = byPath.get(f.path);
          if (!existing || f.staged) byPath.set(f.path, f);
        }
        const files = Array.from(byPath.values());
        setAllFiles(files);
        setBranch(result.branch);
        setSelected((prev) => {
          if (prev.size > 0) {
            const validPaths = new Set(files.map((f) => f.path));
            const merged = new Set<string>();
            for (const p of prev) { if (validPaths.has(p)) merged.add(p); }
            for (const f of files) { if (f.staged) merged.add(f.path); }
            return merged;
          }
          return new Set(files.filter((f) => f.staged).map((f) => f.path));
        });
        setIsLoadingFiles(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`Failed to get git status: ${err}`);
        setIsLoadingFiles(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, visible, refreshKey]);

  const allChecked = allFiles.length > 0 && selected.size === allFiles.length;
  const someChecked = selected.size > 0 && selected.size < allFiles.length;
  const hasNoFiles = !isLoadingFiles && allFiles.length === 0;

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

  const handleOpenInChat = () => {
    onOpenInChat(Array.from(selected), { newBranch, branchName: newBranchName.trim() });
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <>
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, display: visible ? "flex" : "none", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.85)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        style={{ background: "var(--bg-primary)", border: "2px solid var(--accent-color)", borderRadius: 0, width: 520, maxWidth: "90vw", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "6px 6px 0px rgba(255, 122, 0,0.15)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "2px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Commit</span>
            {branch && (
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", color: "var(--text-tertiary)" }}>{branch}</span>
            )}
          </div>
          <button onClick={handleClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          {isLoadingFiles ? (
            <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: "6px 0" }}>Loading...</div>
          ) : hasNoFiles ? (
            <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: "6px 0" }}>No changes</div>
          ) : (
            <div style={{ background: "var(--bg-secondary)", borderRadius: 0, border: "2px solid var(--border-color)", overflow: "hidden" }}>
              {/* Select-all row */}
              <div
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "2px solid var(--border-color)", cursor: "pointer" }}
                onClick={toggleAll}
              >
                <Checkbox checked={allChecked} indeterminate={someChecked} onChange={toggleAll} />
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", userSelect: "none", textTransform: "uppercase" as const }}>
                  {selected.size === allFiles.length
                    ? `All ${allFiles.length} files selected`
                    : `${selected.size} / ${allFiles.length} files selected`}
                </span>
              </div>
              {/* File rows */}
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {allFiles.map((f, i) => (
                  <div
                    key={`${f.path}-${i}`}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: i < allFiles.length - 1 ? "1px solid var(--border-subtle)" : undefined, cursor: "pointer", opacity: selected.has(f.path) ? 1 : 0.45 }}
                    onClick={() => {
                      invoke<string>("get_git_diff", { directory, filePath: f.path, staged: f.staged })
                        .then((diff) => setFileDiffModal({ path: f.path, diff }))
                        .catch((err) => setError(`Failed to get diff: ${err}`));
                    }}
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

          {/* Branch */}
          {!hasNoFiles && branch && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={newBranch}
                    onChange={(e) => setNewBranch(e.target.checked)}
                    style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "inherit" }}
                  />
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", userSelect: "none" }}>New branch</span>
                </label>
              </div>
              {newBranch && (
                <div style={{ marginTop: 6 }}>
                  <input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value.replace(/\s+/g, "-"))}
                    placeholder="branch-name (optional — agent will suggest one)"
                    style={{
                      width: "100%",
                      background: "var(--bg-secondary)",
                      border: "2px solid var(--border-color)",
                      borderRadius: 0,
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)",
                      color: "var(--text-primary)",
                      outline: "none",
                      boxSizing: "border-box" as const,
                    }}
                    onFocus={(e) => { e.target.style.borderColor = "var(--accent)"; }}
                    onBlur={(e) => { e.target.style.borderColor = "var(--border-color)"; }}
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "2px solid rgba(239,68,68,0.3)", borderRadius: 0, padding: "8px 10px", fontSize: 12, color: "#f87171" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "2px solid var(--border-color)", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <Btn onClick={handleClose}>Cancel</Btn>
          <Btn
            onClick={handleOpenInChat}
            disabled={isLoadingFiles || hasNoFiles || selected.size === 0}
            primary
          >
            Open in Chat
          </Btn>
        </div>
      </div>
    </div>
    {fileDiffModal && (
      <FileDiffModal
        path={fileDiffModal.path}
        diff={fileDiffModal.diff}
        onClose={() => setFileDiffModal(null)}
      />
    )}
    </>
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
        background: primary ? "var(--accent-color)" : "none",
        border: primary ? "2px solid var(--accent-color)" : "2px solid var(--border-color)",
        borderRadius: 0,
        padding: "6px 12px",
        fontSize: 11,
        fontWeight: 700,
        color: primary ? "#000" : "var(--text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
      }}
    >
      {children}
    </button>
  );
}
