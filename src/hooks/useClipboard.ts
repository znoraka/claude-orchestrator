import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useClipboard(onImagePath: (path: string) => void) {
  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          const buffer = await blob.arrayBuffer();
          const base64 = btoa(
            String.fromCharCode(...new Uint8Array(buffer))
          );

          try {
            const filePath = await invoke<string>("save_clipboard_image", {
              base64Data: base64,
            });
            onImagePath(filePath);
          } catch (err) {
            console.error("Failed to save clipboard image:", err);
          }
          break;
        }
      }
    },
    [onImagePath]
  );

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handlePaste]);
}
