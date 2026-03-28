import { useCallback } from "react";
import type { ChatMessage, ContentBlock } from "../types";

export function useMessageActions(
  messages: ChatMessage[],
  setInputText: (text: string) => void,
  setImages: React.Dispatch<React.SetStateAction<Array<{ id: string; data: string; mediaType: string; name: string }>>>,
  setEditingMessageId: (id: string | null) => void,
  inputRef: React.RefObject<HTMLTextAreaElement | null>,
  sendMessage: (text?: string) => void,
  onForkRef: React.MutableRefObject<((systemPrompt: string) => void) | undefined>,
) {
  const editMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.type !== "user") return;
    const text = (Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : ""
    );
    if (Array.isArray(msg.content)) {
      const imgs = msg.content
        .filter((b) => b.type === "image" && b.source?.type === "base64")
        .map((b: ContentBlock, i) => ({
          id: `edit-img-${Date.now()}-${i}`,
          data: b.source!.data as string,
          mediaType: b.source!.media_type as string,
          name: "image",
        }));
      setImages(imgs);
    }
    setEditingMessageId(messageId);
    setInputText(text);
    inputRef.current?.focus();
  }, [messages, setInputText, setImages, setEditingMessageId, inputRef]);

  const forkFromMessage = useCallback((messageId: string) => {
    if (!onForkRef.current) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const transcript = messages.slice(0, idx + 1);
    const lines = transcript.map((m) => {
      const text = Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : "";
      if (m.type === "user") return `Human: ${text}`;
      if (m.type === "assistant") return `Assistant: ${text}`;
      return "";
    }).filter(Boolean);
    const systemPrompt = `This conversation was forked from a previous session. Here is the conversation context up to the fork point:\n\n<fork-context>\n${lines.join("\n\n")}\n</fork-context>\n\nContinue from this context. The user will now send their next message.`;
    onForkRef.current(systemPrompt);
  }, [messages, onForkRef]);

  const retryMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.type !== "user") return;
    const text = Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : "";
    // Set editingMessageId so sendMessage resets the session (same as the edit flow),
    // building context from messages before the retry point and starting a fresh session.
    // The displayMessages memo will immediately hide messages at/after the retry point.
    setEditingMessageId(messageId);
    // Delay so React re-renders first (updating sendMessageRef.current with the new
    // editingMessageId), then call via the ref-based wrapper to get the latest sendMessage.
    setTimeout(() => sendMessage(text), 0);
  }, [messages, setEditingMessageId, sendMessage]);

  const copyMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    const text = Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : "";
    if (text) navigator.clipboard.writeText(text);
  }, [messages]);

  return { editMessage, forkFromMessage, retryMessage, copyMessage };
}
