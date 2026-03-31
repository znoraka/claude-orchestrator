import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "../lib/bridge";
import { AGENT_PROVIDERS, type AgentProvider, type ModelOption, modelsForProvider, defaultModelForProvider } from "../types";
import type { OpenCodeModel } from "../App";
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
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/-$/, "");
}

const STATUS_COLORS: Record<string, string> = {
  M: "var(--accent)",
  A: "#4ade80",
  D: "#f87171",
  R: "#fb923c",
  C: "#a78bfa",
  U: "#facc15",
};

export default function CommitModal({ directory, onClose, visible = true }: Props) {
  const [allFiles, setAllFiles] = useState<GitFileEntry[]>([]);
  // selected = paths that will be included in the commit
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [isPushing, setIsPushing] = useState(false);
  const [isCommitOnly, setIsCommitOnly] = useState(false);
  const [commitedOnly, setCommitedOnly] = useState(false);
  const [pushDone, setPushDone] = useState(false);
  const [showCreatePR, setShowCreatePR] = useState(false);
  const [existingPrUrl, setExistingPrUrl] = useState<string | null>(null);
  const [prStep, setPrStep] = useState<"idle" | "generating" | "preview" | "creating" | "done">("idle");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [provider, setProvider] = useState<AgentProvider>(() => {
    const saved = localStorage.getItem("commit-provider");
    return (saved as AgentProvider) || "claude-code";
  });
  const [model, setModel] = useState(() => {
    return localStorage.getItem("commit-model") || defaultModelForProvider("claude-code") || "claude-sonnet-4-6";
  });
  const [dynamicOpencode, setDynamicOpencode] = useState<ModelOption[]>([]);
  const [dynamicCodex, setDynamicCodex] = useState<ModelOption[]>([]);
  const [branchAlreadyExists, setBranchAlreadyExists] = useState(false);
  const [fileDiffModal, setFileDiffModal] = useState<{ path: string; diff: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resetState = () => {
    setCommitMessage("");
    setPushDone(false);
    setShowCreatePR(false);
    setExistingPrUrl(null);
    setPrStep("idle");
    setPrTitle("");
    setPrBody("");
    setPrUrl("");
    setError(null);
    setNewBranch(false);
    setNewBranchName("");
    setBaseBranch("");
    setBranchAlreadyExists(false);
    setIsCommitOnly(false);
    setCommitedOnly(false);
    setIsLoadingFiles(true);
    setRefreshKey((k) => k + 1);
  };

  const handleClose = () => {
    if (pushDone) {
      setSelected(new Set());
      setRefreshKey((k) => k + 1);
    }
    if (prStep === "done" || (pushDone && !showCreatePR)) resetState();
    onClose();
  };

  // Fetch dynamic models for opencode/codex on mount
  useEffect(() => {
    invoke<string>("fetch_opencode_models").then((json) => {
      try {
        const raw: OpenCodeModel[] = JSON.parse(json);
        const free = raw.filter((m) => m.free);
        const paid = raw.filter((m) => !m.free);
        setDynamicOpencode([
          ...free.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: "Free", free: true as const })),
          ...paid.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: `$${m.costIn}/${m.costOut} per MTok`, free: false as const })),
        ]);
      } catch {}
    }).catch(() => {});
    invoke<string>("fetch_codex_models").then((json) => {
      try {
        const models: ModelOption[] = JSON.parse(json);
        if (models.length > 0) setDynamicCodex(models);
      } catch {}
    }).catch(() => {});
  }, []);

  const models = useMemo(() => {
    if (provider === "opencode" && dynamicOpencode.length > 0) return dynamicOpencode;
    if (provider === "codex" && dynamicCodex.length > 0) return dynamicCodex;
    return modelsForProvider(provider);
  }, [provider, dynamicOpencode, dynamicCodex]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setIsLoadingFiles(true);

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
        setBranch(result.branch);
        // Preserve existing selections on re-open; only default to staged on fresh open
        setSelected((prev) => {
          if (prev.size > 0) {
            // Keep previously selected paths that still exist, add any newly staged
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

  // Check if new branch name already exists
  useEffect(() => {
    if (!newBranch || !newBranchName.trim()) { setBranchAlreadyExists(false); return; }
    let cancelled = false;
    invoke<boolean>("git_branch_exists", { directory, branchName: newBranchName.trim() })
      .then((exists) => { if (!cancelled) setBranchAlreadyExists(exists); })
      .catch(() => { if (!cancelled) setBranchAlreadyExists(false); });
    return () => { cancelled = true; };
  }, [directory, newBranch, newBranchName]);

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

  const stageFiles = async () => {
    const toStage = allFiles.filter((f) => selected.has(f.path) && !f.staged).map((f) => f.path);
    if (toStage.length > 0) await invoke("git_stage_files", { directory, files: toStage });
    const toUnstage = allFiles.filter((f) => !selected.has(f.path) && f.staged).map((f) => f.path);
    if (toUnstage.length > 0) await invoke("git_unstage_files", { directory, files: toUnstage });
  };

  const handleBranchSwitch = async (origBranch: string) => {
    if (newBranch && newBranchName.trim()) {
      if (branchAlreadyExists) {
        await invoke("git_checkout_branch", { directory, branchName: newBranchName.trim() });
      } else {
        await invoke("git_checkout_new_branch", { directory, branchName: newBranchName.trim() });
      }
      setBaseBranch(origBranch);
      setBranch(newBranchName.trim());
    }
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) { setError("Please enter a commit message."); return; }
    if (selected.size === 0) { setError("No files selected."); return; }
    if (newBranch && !newBranchName.trim()) { setError("Please enter a branch name."); return; }
    setIsPushing(true);
    setIsCommitOnly(true);
    setError(null);
    const origBranch = branch;
    try {
      await handleBranchSwitch(origBranch);
      await stageFiles();
      await invoke("git_commit_only", { directory, message: commitMessage.trim() });
      setIsPushing(false);
      setIsCommitOnly(false);
      setCommitedOnly(true);
      setPushDone(true);
    } catch (err) {
      setError(`Commit failed: ${err}`);
      if (newBranch && origBranch && !branchAlreadyExists) {
        try { await invoke("git_checkout_branch", { directory, branchName: origBranch }); } catch {}
        setBranch(origBranch);
      }
      setIsPushing(false);
      setIsCommitOnly(false);
    }
  };

  const handlePushAfterCommit = async () => {
    setIsPushing(true);
    setError(null);
    try {
      await invoke("git_push_only", { directory });
      setIsPushing(false);
      setCommitedOnly(false);

      const activeBranch = newBranch ? newBranchName.trim() : branch;
      if (activeBranch && activeBranch !== "main" && activeBranch !== "master") {
        try {
          const prs = await invoke<{ myPrs: { headRefName: string; url: string }[]; reviewRequested: { headRefName: string; url: string }[] }>("get_pull_requests", { directory });
          const allPrs = [...(prs.myPrs || []), ...(prs.reviewRequested || [])];
          const existingPR = allPrs.find((pr) => pr.headRefName === activeBranch);
          if (existingPR) {
            setExistingPrUrl(existingPR.url);
            setShowCreatePR(false);
          } else {
            setShowCreatePR(true);
          }
        } catch {
          setShowCreatePR(true);
        }
      }
    } catch (err) {
      setError(`Push failed: ${err}`);
      setIsPushing(false);
    }
  };

  const handleGenerateMessage = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const files = selected.size > 0 ? Array.from(selected) : undefined;
      let msg = await invoke<string>("generate_commit_message", { directory, model, provider, files });
      // Strip backticks/code fences the LLM sometimes wraps around the message
      if (msg) {
        msg = msg.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").replace(/^`|`$/g, "").trim();
      }
      setCommitMessage(msg || "");
      if (newBranch && msg) setNewBranchName(slugify(msg));
    } catch (err) {
      setError(`Failed to generate message: ${err}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGeneratePR = async () => {
    setPrStep("generating");
    setError(null);
    try {
      const result = await invoke<{ title?: string; description?: string }>("generate_pr_description", {
        directory,
        model,
        provider,
        base: baseBranch || undefined,
      });
      setPrTitle(result.title || "");
      setPrBody(result.description || "");
      setPrStep("preview");
    } catch (err) {
      setError(`Failed to generate PR description: ${err}`);
      setPrStep("idle");
    }
  };

  const handleCreatePR = async () => {
    if (!prTitle.trim()) { setError("PR title is required."); return; }
    setPrStep("creating");
    setError(null);
    try {
      const url = await invoke<string>("gh_create_pr", {
        directory,
        title: prTitle.trim(),
        body: prBody.trim(),
        base: baseBranch || undefined,
      });
      setPrUrl(url);
      setPrStep("done");
    } catch (err) {
      setError(`Failed to create PR: ${err}`);
      setPrStep("preview");
    }
  };

  const busy = isPushing || isGenerating || prStep === "generating" || prStep === "creating";
  const hasNoFiles = !isLoadingFiles && allFiles.length === 0;

  return (
    <>
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, display: visible ? "flex" : "none", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.85)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        style={{ background: "var(--bg-primary)", border: "2px solid var(--accent-color)", borderRadius: 0, width: prStep === "preview" || prStep === "creating" ? 620 : 520, maxWidth: "90vw", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "6px 6px 0px rgba(255, 122, 0,0.15)", transition: "width 0.2s ease" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "2px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Commit &amp; Push</span>
          <button onClick={handleClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}>✕</button>
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
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
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
          </div>

          {/* Branch */}
          {!hasNoFiles && branch && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0 }}>Branch</span>
                <span style={{ fontSize: 12, fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", color: "var(--text-primary)", fontWeight: 600 }}>{branch}</span>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}>
                    <input
                      type="checkbox"
                      checked={newBranch}
                      onChange={(e) => {
                        setNewBranch(e.target.checked);
                        if (e.target.checked && !newBranchName) {
                          setNewBranchName(slugify(commitMessage) || "");
                        }
                      }}
                      disabled={busy}
                      style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "inherit" }}
                    />
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", userSelect: "none" }}>New branch</span>
                  </label>
                </div>
              </div>
              {newBranch && (
                <div style={{ marginTop: 6 }}>
                  <input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value.replace(/\s+/g, "-"))}
                    placeholder="branch-name"
                    disabled={busy}
                    style={{
                      width: "100%",
                      background: "var(--bg-secondary)",
                      border: `2px solid ${branchAlreadyExists ? "var(--accent)" : "var(--border-color)"}`,
                      borderRadius: 0,
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)",
                      color: "var(--text-primary)",
                      outline: "none",
                      boxSizing: "border-box" as const,
                    }}
                    onFocus={(e) => { e.target.style.borderColor = "var(--accent)"; }}
                    onBlur={(e) => { e.target.style.borderColor = branchAlreadyExists ? "var(--accent)" : "var(--border-color)"; }}
                  />
                  {branchAlreadyExists && (
                    <span style={{ fontSize: 10, color: "var(--accent)", marginTop: 3, display: "block" }}>
                      Branch already exists — will switch to it
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Commit message */}
          {!hasNoFiles && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Commit message</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <select
                    value={provider}
                    onChange={(e) => {
                      const p = e.target.value as AgentProvider;
                      setProvider(p);
                      localStorage.setItem("commit-provider", p);
                      const dynModels = p === "opencode" ? dynamicOpencode : p === "codex" ? dynamicCodex : modelsForProvider(p);
                      const newModel = defaultModelForProvider(p) || dynModels[0]?.id || "";
                      setModel(newModel);
                      localStorage.setItem("commit-model", newModel);
                    }}
                    disabled={busy}
                    style={{
                      background: "var(--bg-secondary)",
                      border: "2px solid var(--border-color)",
                      borderRadius: 0,
                      padding: "2px 6px",
                      fontSize: 11,
                      color: "var(--text-secondary)",
                      cursor: busy ? "not-allowed" : "pointer",
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  >
                    {AGENT_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  {models.length > 0 && (
                    <select
                      value={model}
                      onChange={(e) => { setModel(e.target.value); localStorage.setItem("commit-model", e.target.value); }}
                      disabled={busy}
                      style={{
                        background: "var(--bg-secondary)",
                        border: "2px solid var(--border-color)",
                        borderRadius: 0,
                        padding: "2px 6px",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        cursor: busy ? "not-allowed" : "pointer",
                        outline: "none",
                        fontFamily: "inherit",
                      }}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              <div style={{ position: "relative" }}>
                <textarea
                  ref={textareaRef}
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder={isGenerating ? "Generating commit message..." : "Enter commit message..."}
                  disabled={busy}
                  style={{ width: "100%", minHeight: 72, resize: "none", background: "var(--bg-secondary)", border: "2px solid var(--border-color)", borderRadius: 0, padding: "8px 10px", fontSize: 12, fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box", overflow: "hidden" }}
                  onFocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--accent)"; }}
                  onBlur={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--border-subtle)"; }}
                />
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "2px solid rgba(239,68,68,0.3)", borderRadius: 0, padding: "8px 10px", fontSize: 12, color: "#f87171" }}>
              {error}
            </div>
          )}
        </div>

        {/* PR Preview (shown after push, when generating/editing PR) */}
        {pushDone && (prStep === "generating" || prStep === "preview" || prStep === "creating") && (
          <div style={{ padding: "0 18px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {prStep === "generating" ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: "6px 0" }}>Generating PR title and description...</div>
            ) : (
              <>
                <div>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>PR Title</span>
                  <input
                    value={prTitle}
                    onChange={(e) => setPrTitle(e.target.value)}
                    disabled={prStep === "creating"}
                    maxLength={70}
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
                  <span style={{ fontSize: 9, color: prTitle.length > 60 ? "#fb923c" : "var(--text-tertiary)", marginTop: 2, display: "block" }}>
                    {prTitle.length}/70
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>Description</span>
                  <textarea
                    value={prBody}
                    onChange={(e) => setPrBody(e.target.value)}
                    disabled={prStep === "creating"}
                    style={{
                      width: "100%",
                      minHeight: 150,
                      maxHeight: 250,
                      resize: "vertical",
                      background: "var(--bg-secondary)",
                      border: "2px solid var(--border-color)",
                      borderRadius: 0,
                      padding: "8px 10px",
                      fontSize: 11,
                      fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)",
                      color: "var(--text-primary)",
                      outline: "none",
                      boxSizing: "border-box" as const,
                    }}
                    onFocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--accent)"; }}
                    onBlur={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--border-color)"; }}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* PR Done */}
        {prStep === "done" && prUrl && (
          <div style={{ padding: "0 18px 14px" }}>
            <div style={{ background: "rgba(74,222,128,0.1)", border: "2px solid rgba(74,222,128,0.3)", borderRadius: 0, padding: "8px 10px", fontSize: 12, color: "#4ade80", display: "flex", alignItems: "center", gap: 8 }}>
              <span>PR created</span>
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); import("../lib/bridge").then(({ openUrl }) => openUrl(prUrl)); }}
                style={{ color: "#e2e8f0", textDecoration: "underline", fontSize: 11, fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {prUrl}
              </a>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "2px solid var(--border-color)", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {pushDone ? (
            <>
              <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 700, marginRight: "auto", textTransform: "uppercase", letterSpacing: "0.05em" }}>{commitedOnly ? "Committed" : "Pushed"}</span>
              <Btn onClick={resetState} disabled={prStep === "generating" || prStep === "creating" || isPushing}>Reset</Btn>
              {commitedOnly && prStep === "idle" && (
                <Btn onClick={handlePushAfterCommit} disabled={isPushing} primary>
                  {isPushing ? "Pushing..." : "Push"}
                </Btn>
              )}
              {!commitedOnly && existingPrUrl && prStep === "idle" && (
                <Btn onClick={() => import("../lib/bridge").then(({ openUrl }) => openUrl(existingPrUrl!))} primary>
                  View PR
                </Btn>
              )}
              {!commitedOnly && showCreatePR && prStep === "idle" && (
                <Btn onClick={handleGeneratePR} primary>
                  Create PR
                </Btn>
              )}
              {prStep === "preview" && (
                <>
                  <Btn onClick={() => setPrStep("idle")}>Cancel</Btn>
                  <Btn onClick={handleCreatePR} primary disabled={!prTitle.trim()}>
                    Create PR
                  </Btn>
                </>
              )}
              {prStep === "creating" && (
                <Btn onClick={() => {}} disabled>Creating...</Btn>
              )}
              {prStep === "done" && prUrl && (
                <Btn onClick={() => import("../lib/bridge").then(({ openUrl }) => openUrl(prUrl))} primary>
                  Open PR
                </Btn>
              )}
            </>
          ) : (
            <>
              <Btn onClick={handleGenerateMessage} disabled={busy || isLoadingFiles || hasNoFiles}>
                {isGenerating ? "Generating..." : "Generate Message"}
              </Btn>
              <Btn
                onClick={handleCommit}
                disabled={busy || isLoadingFiles || hasNoFiles || selected.size === 0 || !commitMessage.trim()}
                primary
              >
                {isCommitOnly ? "Committing..." : "Commit"}
              </Btn>
            </>
          )}
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
