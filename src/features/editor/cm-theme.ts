/** CodeMirror 6 主题：全部引用设计 token CSS 变量，随主题/密度自动切换 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export const latticeEditorTheme: Extension = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--bg-base)",
    color: "var(--text-primary)",
  },
  ".cm-scroller": {
    fontFamily: "var(--app-font-mono)",
    lineHeight: "1.55",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    padding: "8px 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--bg-hover) 60%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-base)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--bg-hover)",
    color: "var(--text-primary)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid var(--accent)",
    color: "inherit",
  },
  ".cm-foldGutter span": {
    color: "var(--text-muted)",
  },
  ".cm-foldGutter span:hover": {
    color: "var(--accent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "var(--app-shadow-pop)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--bg-active)",
    color: "var(--text-primary)",
  },
  ".cm-completionLabel": {
    color: "var(--text-primary)",
  },
  ".cm-completionDetail": {
    color: "var(--text-muted)",
  },
});

export const latticeHighlightStyle: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--accent)" },
    { tag: tags.controlKeyword, color: "var(--accent)" },
    { tag: tags.moduleKeyword, color: "var(--accent)" },
    { tag: tags.number, color: "#d2a8ff" },
    { tag: tags.string, color: "var(--success)" },
    { tag: tags.comment, color: "var(--text-muted)", fontStyle: "italic" },
    { tag: tags.variableName, color: "var(--text-primary)" },
    { tag: tags.propertyName, color: "#79c0ff" },
    { tag: tags.function(tags.variableName), color: "#d2a8ff" },
    { tag: tags.operator, color: "var(--text-primary)" },
    { tag: tags.punctuation, color: "var(--text-muted)" },
    { tag: tags.typeName, color: "#ffa657" },
    { tag: tags.invalid, color: "var(--danger)" },
  ]),
);
