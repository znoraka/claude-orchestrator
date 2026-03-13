import { ImageWithLightbox } from "../messages/shared/ImageWithLightbox";
import type { FileReference } from "../../FilePickerModal";
import type { ImageAttachment, PastedFile } from "../hooks/useAttachments";

interface AttachmentStripProps {
  fileReferences: FileReference[];
  images: ImageAttachment[];
  pastedFiles: PastedFile[];
  onRemoveFileRef: (path: string) => void;
  onRemoveImage: (id: string) => void;
  onRemovePastedFile: (id: string) => void;
  onViewFileRef: (ref: FileReference) => void;
}

export function AttachmentStrip({
  fileReferences, images, pastedFiles,
  onRemoveFileRef, onRemoveImage, onRemovePastedFile, onViewFileRef,
}: AttachmentStripProps) {
  if (fileReferences.length === 0 && images.length === 0 && pastedFiles.length === 0) return null;

  return (
    <div className="flex gap-2 flex-wrap items-center">
      {fileReferences.map((ref) => {
        const fileName = ref.filePath.split("/").pop()!;
        const previewLines = ref.content.split("\n").slice(0, 8);
        return (
          <div
            key={ref.filePath}
            className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-color)] cursor-pointer hover:border-[var(--accent)] transition-colors"
            onClick={() => onViewFileRef(ref)}
          >
            <div className="w-full h-full bg-[var(--bg-tertiary)] p-1 overflow-hidden">
              <pre className="text-[3.5px] leading-[4.5px] text-[var(--text-tertiary)] font-mono whitespace-pre overflow-hidden pointer-events-none select-none">{previewLines.join("\n")}</pre>
            </div>
            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-3 pb-0.5 px-1">
              <span className="text-[8px] text-white/90 font-medium truncate block leading-tight">{fileName}</span>
              <span className="text-[7px] text-white/60 block leading-tight">L{ref.startLine}-{ref.endLine}</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveFileRef(ref.filePath); }}
              className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        );
      })}
      {pastedFiles.map((f) => (
        <div key={f.id} className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-color)] bg-[var(--bg-tertiary)]">
          <div className="w-full h-full flex flex-col items-center justify-center p-1">
            <svg className="w-6 h-6 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          </div>
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-3 pb-0.5 px-1">
            <span className="text-[8px] text-white/90 font-medium truncate block leading-tight">{f.name}</span>
          </div>
          <button
            onClick={() => onRemovePastedFile(f.id)}
            className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
      {images.map((img) => (
        <div key={img.id} className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-color)]">
          <ImageWithLightbox src={`data:${img.mediaType};base64,${img.data}`} thumbnail />
          <button
            onClick={() => onRemoveImage(img.id)}
            className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
