import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

export function ImageWithLightbox({ src, thumbnail }: { src: string; thumbnail?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <>
      <img
        src={src}
        className={thumbnail
          ? "w-full h-full object-cover cursor-zoom-in"
          : "max-w-full max-h-64 rounded-lg my-1 cursor-zoom-in"
        }
        alt="Attached image"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      />
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 cursor-zoom-out"
            onClick={() => setOpen(false)}
          >
            <img
              src={src}
              className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
              alt="Attached image"
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body
        )}
    </>
  );
}

export function LocalFileImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("read_file_base64", { filePath: path })
      .then(b64 => setSrc(`data:image/png;base64,${b64}`))
      .catch(() => setSrc(""));
  }, [path]);
  if (src === null) return null;
  if (src === "") return <span className="text-xs text-[var(--muted)]">[image unavailable]</span>;
  return <ImageWithLightbox src={src} />;
}
