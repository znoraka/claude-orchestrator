import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export function useUpdater() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    check()
      .then((u) => {
        if (u) setUpdate(u);
      })
      .catch((e) => console.error("Update check failed:", e));
  }, []);

  const install = async () => {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      setInstalling(false);
    }
  };

  const dismiss = () => setUpdate(null);

  return { update, installing, install, dismiss };
}
