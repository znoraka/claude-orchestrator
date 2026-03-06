import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// One Dark Pro colors for CodeMirror syntax highlighting
export const oneDarkHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#c678dd" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "#e06c75" },
  { tag: [t.propertyName], color: "#e06c75" },
  { tag: [t.function(t.variableName), t.labelName], color: "#61afef" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#d19a66" },
  { tag: [t.definition(t.name), t.separator], color: "#abb2bf" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#e5c07b" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#56b6c2" },
  { tag: [t.meta, t.comment], color: "#5c6370", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#56b6c2", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "#e06c75" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#d19a66" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "#98c379" },
  { tag: t.invalid, color: "#ffffff", backgroundColor: "#e06c75" },
]);
