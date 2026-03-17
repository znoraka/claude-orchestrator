import { CheckIcon, ShieldAlertIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";

interface InlinePermissionComposerProps {
  permission: { toolName: string; input: Record<string, unknown> };
  onAllow: () => void;
  onDeny: () => void;
  onAllowInNew: () => void;
  onFeedback: (text: string) => void;
}

export function InlinePermissionComposer({
  permission,
  onAllow,
  onDeny,
  onAllowInNew,
}: InlinePermissionComposerProps) {
  const isExitPlan = permission.toolName === "ExitPlanMode";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {isExitPlan ? (
          <>
            <Badge variant="secondary">
              <CheckIcon className="size-3 mr-1" />
              Plan ready
            </Badge>
            <span className="text-sm font-medium text-foreground">How do you want to proceed?</span>
          </>
        ) : (
          <>
            <Badge variant="secondary">
              <ShieldAlertIcon className="size-3 mr-1" />
              Permission requested
            </Badge>
            <span className="font-mono text-sm text-muted-foreground truncate max-w-[300px]">
              {permission.toolName}
              {permission.input?.command != null && (
                <span className="text-muted-foreground/60 ml-1">
                  {String(permission.input.command).substring(0, 200)}
                </span>
              )}
              {permission.input?.file_path != null && (
                <span className="text-muted-foreground/60 ml-1">
                  {String(permission.input.file_path)}
                </span>
              )}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!isExitPlan && (
          <Button size="sm" onClick={onAllow}>
            Allow
          </Button>
        )}
        <Button size="sm" onClick={onAllowInNew} variant={isExitPlan ? "default" : "outline"}>
          {isExitPlan ? "Execute plan" : "Allow in new session"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDeny}>
          Deny
        </Button>
      </div>
    </div>
  );
}
