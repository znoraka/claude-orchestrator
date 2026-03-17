import { memo, useState, useId, useCallback } from "react";
import { EllipsisIcon } from "lucide-react";
import { cn } from "../../../../lib/cn";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../../ui/menu";
import { Badge } from "../../../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { invoke } from "../../../../lib/bridge";
import { MarkdownContent } from "./MarkdownContent";

// ── Helpers ─────────────────────────────────────────────────────────────

function parsePlanTitle(planMarkdown: string): string {
  const match = planMarkdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "Proposed plan";
}

function buildPlanFilename(planMarkdown: string): string {
  const title = parsePlanTitle(planMarkdown);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "plan"}.md`;
}

function downloadPlanAsMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildCollapsedPreview(planMarkdown: string, maxLines = 10): string {
  const lines = planMarkdown.split("\n");
  if (lines.length <= maxLines) return planMarkdown;
  return lines.slice(0, maxLines).join("\n") + "\n\n*(plan truncated — click to expand)*";
}

// ── Component ────────────────────────────────────────────────────────────

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd: _cwd,
  workspaceRoot,
}: {
  planMarkdown: string;
  cwd?: string;
  workspaceRoot?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(null);
  const savePathInputId = useId();

  const title = parsePlanTitle(planMarkdown);
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const filename = buildPlanFilename(planMarkdown);

  const handleDownload = useCallback(() => {
    downloadPlanAsMarkdown(filename, planMarkdown);
  }, [filename, planMarkdown]);

  const openSaveDialog = useCallback(() => {
    setSavePath((existing) => (existing.length > 0 ? existing : filename));
    setSaveResult(null);
    setIsSaveDialogOpen(true);
  }, [filename]);

  const handleSaveToWorkspace = useCallback(async () => {
    const relativePath = savePath.trim();
    if (!relativePath || !workspaceRoot) return;
    setIsSaving(true);
    setSaveResult(null);
    try {
      await invoke("write_file", {
        path: `${workspaceRoot}/${relativePath}`,
        content: planMarkdown,
      });
      setSaveResult("success");
      setTimeout(() => setIsSaveDialogOpen(false), 1000);
    } catch (err) {
      console.error("Failed to save plan:", err);
      setSaveResult("error");
    } finally {
      setIsSaving(false);
    }
  }, [savePath, workspaceRoot, planMarkdown]);

  const displayedMarkdown =
    canCollapse && !expanded ? buildCollapsedPreview(planMarkdown) : planMarkdown;

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            {workspaceRoot ? (
              <MenuItem onClick={openSaveDialog} disabled={isSaving}>
                Save to workspace
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>

      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-96 overflow-hidden")}>
          <MarkdownContent text={displayedMarkdown} />
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSaving) setIsSaveDialogOpen(open);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to{" "}
              <code className="text-xs">{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(e) => setSavePath(e.target.value)}
                placeholder={filename}
                spellCheck={false}
                disabled={isSaving}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isSaving) void handleSaveToWorkspace();
                }}
              />
            </label>
            {saveResult === "success" && (
              <p className="text-xs text-success-foreground">Plan saved successfully!</p>
            )}
            {saveResult === "error" && (
              <p className="text-xs text-destructive-foreground">Failed to save plan. Check the path and try again.</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSaving || !savePath.trim()}
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
