import { useState, useCallback, useEffect } from "react";
import { invoke } from "../../../lib/bridge";
import { listen } from "../../../lib/bridge";

export type ImageAttachment = { id: string; data: string; mediaType: string; name: string };
export type PastedFile = { id: string; name: string; content: string; mimeType: string };

export function useAttachments(isActive: boolean, inputRef: React.RefObject<HTMLTextAreaElement | null>) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pastedFiles, setPastedFiles] = useState<PastedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const addImageFromFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const [header, data] = result.split(",");
      const mediaType = header.match(/data:(.*);/)?.[1] || "image/png";
      setImages((prev) => [
        ...prev,
        { id: `img-${Date.now()}-${Math.random()}`, data, mediaType, name: file.name || "pasted-image" },
      ]);
    };
    reader.readAsDataURL(file);
  }, []);

  const addFileFromClipboard = useCallback((file: File) => {
    if (file.size > 500 * 1024) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setPastedFiles(prev => [...prev, {
        id: `file-${Date.now()}-${Math.random()}`,
        name: file.name,
        content,
        mimeType: file.type,
      }]);
    };
    reader.readAsText(file);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFromFile(file);
      } else if (item.kind === "file" && !item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addFileFromClipboard(file);
      }
    }
  }, [addImageFromFile, addFileFromClipboard]);

  // Document-level paste listener
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: ClipboardEvent) => {
      if (document.activeElement === inputRef.current) return;
      // If any other textarea/input is focused, let that component's own onPaste handle it
      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let hasAttachment = false;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          hasAttachment = true;
          const file = item.getAsFile();
          if (file) addImageFromFile(file);
        } else if (item.kind === "file" && !item.type.startsWith("image/")) {
          hasAttachment = true;
          const file = item.getAsFile();
          if (file) addFileFromClipboard(file);
        }
      }
      if (hasAttachment) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [addImageFromFile, addFileFromClipboard, isActive, inputRef]);

  // Drag-and-drop (Tauri native)
  useEffect(() => {
    if (!isActive) return;
    const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "avif"]);
    const IMAGE_MIME: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
      tiff: "image/tiff", avif: "image/avif",
    };
    const unlistenPromise = Promise.all([
      listen("tauri://drag-enter", () => setIsDragging(true)),
      listen("tauri://drag-leave", () => setIsDragging(false)),
      listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
        setIsDragging(false);
        for (const path of event.payload.paths) {
          const ext = path.split(".").pop()?.toLowerCase() ?? "";
          if (IMAGE_EXTS.has(ext)) {
            try {
              const data = await invoke<string>("read_file_base64", { filePath: path });
              const mediaType = IMAGE_MIME[ext] ?? "image/png";
              const name = path.split("/").pop() ?? "image";
              setImages(prev => [...prev, { id: `img-${Date.now()}-${Math.random()}`, data, mediaType, name }]);
            } catch { }
          } else {
            try {
              const content = await invoke<string>("read_file", { filePath: path });
              const name = path.split("/").pop() ?? "file";
              setPastedFiles(prev => [...prev, { id: `file-${Date.now()}-${Math.random()}`, name, content, mimeType: "" }]);
            } catch { }
          }
        }
        inputRef.current?.focus();
      }),
    ]);
    return () => { unlistenPromise.then(fns => fns.forEach(fn => fn())); };
  }, [isActive, inputRef]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const removePastedFile = useCallback((id: string) => {
    setPastedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setImages([]);
    setPastedFiles([]);
  }, []);

  return {
    images, setImages,
    pastedFiles, setPastedFiles,
    isDragging,
    handlePaste,
    removeImage,
    removePastedFile,
    clearAttachments,
  };
}
