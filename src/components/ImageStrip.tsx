import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

interface ImageStripProps {
  writeToPty: (data: string) => void;
  /** Register a function that Terminal calls on Enter to get pending image paths */
  onRegisterGetPending: (fn: (() => string) | null) => void;
}

interface Attachment {
  id: string;
  name: string;
  path: string;
  previewUrl: string;
  ptyText: string;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);

function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "' ";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

let idCounter = 0;

export default function ImageStrip({ writeToPty, onRegisterGetPending }: ImageStripProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const writeToPtyRef = useRef(writeToPty);
  useEffect(() => { writeToPtyRef.current = writeToPty; }, [writeToPty]);

  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

  // Register a function that Terminal calls on Enter to consume pending images.
  // Returns the pending paths as a string and clears the thumbnails, or "" if none.
  useEffect(() => {
    const getPending = (): string => {
      const pending = attachmentsRef.current;
      if (pending.length === 0) return "";
      const paths = pending.map((a) => a.ptyText).join("");

      // Clear thumbnails
      setAttachments((prev) => {
        for (const a of prev) {
          if (a.previewUrl.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
        }
        return [];
      });

      return paths;
    };

    onRegisterGetPending(getPending);
    return () => onRegisterGetPending(null);
  }, [onRegisterGetPending]);

  const addAttachment = useCallback((a: Omit<Attachment, "id">) => {
    setAttachments((prev) => [...prev, { ...a, id: `img-${++idCounter}` }]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Paste handler — save image, show thumbnail, but DON'T write to PTY yet
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          e.stopImmediatePropagation();

          const blob = item.getAsFile();
          if (!blob) return;

          try {
            const blobUrl = URL.createObjectURL(blob);
            const buffer = await blob.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);

            const filePath = await invoke<string>("save_clipboard_image", {
              base64Data: base64,
            });
            addAttachment({
              name: "clipboard-image.png",
              path: filePath,
              previewUrl: blobUrl,
              ptyText: shellQuote(filePath),
            });
          } catch (err) {
            console.error("ImageStrip: failed to save pasted image:", err);
          }
          return;
        }
      }

      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (!file || !isImageFile(file.name)) continue;
          e.preventDefault();
          e.stopImmediatePropagation();
          const path = (file as unknown as { path?: string }).path || file.name;
          addAttachment({
            name: file.name,
            path,
            previewUrl: convertFileSrc(path),
            ptyText: shellQuote(path),
          });
          return;
        }
      }

      try {
        const filePaths = await invoke<string[]>("get_clipboard_file_paths");
        const imagePaths = filePaths.filter((p) => isImageFile(p.split("/").pop() || ""));
        if (imagePaths.length > 0) {
          e.preventDefault();
          for (const path of imagePaths) {
            const name = path.split("/").pop() || path;
            addAttachment({
              name,
              path,
              previewUrl: convertFileSrc(path),
              ptyText: shellQuote(path),
            });
          }
        }
      } catch {
        // Not available
      }
    };

    document.addEventListener("paste", handler, true);
    return () => document.removeEventListener("paste", handler, true);
  }, [addAttachment]);

  if (attachments.length === 0 && !expandedImage) return null;

  return (
    <>
      <div ref={containerRef} className="image-strip">
        {attachments.map((a) => (
          <div key={a.id} className="image-strip-item group">
            <img
              src={a.previewUrl}
              alt={a.name}
              className="image-strip-thumbnail cursor-pointer"
              onClick={() => setExpandedImage(a.previewUrl)}
            />
            <button
              onClick={() => removeAttachment(a.id)}
              className="image-strip-remove"
              title="Remove"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Preview"
            className="max-w-[80vw] max-h-[80vh] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setExpandedImage(null)}
            className="absolute top-4 right-4 text-white/70 hover:text-white p-2"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
