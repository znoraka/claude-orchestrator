import { MarkdownContent } from "./MarkdownContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ImageWithLightbox, LocalFileImage } from "./ImageWithLightbox";
import type { ContentBlock } from "../../types";

export function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text" && block.text) {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking" && block.thinking) {
    return <ThinkingBlock thinking={block.thinking} />;
  }

  if (block.type === "image" && block.source) {
    if (block.source.type === "local-file" && block.source.path) {
      return <LocalFileImage path={block.source.path} />;
    }
    const src = block.source.type === "base64"
      ? `data:${block.source.media_type};base64,${block.source.data}`
      : block.source.url ?? "";
    return <ImageWithLightbox src={src} />;
  }

  return null;
}
