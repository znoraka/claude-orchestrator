import { useEffect, useState } from "react";
import { checkUpdate, relaunch } from "../lib/bridge";

export type UpdateStatus = "idle" | "downloading" | "installing";

export function useUpdater(onError?: (msg: string) => void) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [update, setUpdate] = useState<any | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    checkUpdate()
      .then((u: unknown) => {
        if (u) setUpdate(u);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Update check failed:", e);
        onError?.(`Update check failed: ${msg}`);
      });
  }, []);

  const install = async () => {
    if (!update) return;
    setStatus("downloading");
    setProgress(0);
    let downloaded = 0;
    let total = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await update.downloadAndInstall((event: any) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) setProgress(Math.round((downloaded / total) * 100));
            break;
          case "Finished":
            setStatus("installing");
            setProgress(100);
            break;
        }
      });
      await relaunch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Update install failed:", e);
      onError?.(`Update install failed: ${msg}`);
      setStatus("idle");
      setProgress(0);
    }
  };

  const dismiss = () => setUpdate(null);

  return { update, status, progress, install, dismiss };
}
