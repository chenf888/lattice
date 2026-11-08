/** CodeMirror 6 SQL 编辑器封装：行号/折叠/括号匹配/多光标/历史/补全/注释热键 */

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { sql, PostgreSQL, MySQL, StandardSQL } from "@codemirror/lang-sql";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { latticeEditorTheme, latticeHighlightStyle } from "./cm-theme";
import { makeCompletionSource, type CatalogContext, type SchemaCache } from "./completions";

export type SqlDialect = "postgres" | "mysql" | "sqlite" | null;

export interface SqlEditorProps {
  value: string;
  dialect: SqlDialect;
  schemaCache: SchemaCache;
  getCatalog: () => CatalogContext | null;
  /** 自动补全开关（设置页） */
  completions: boolean;
  /** Tab 宽度（设置页） */
  tabSize: number;
  /** 变化时应用光标/滚动恢复（切标签时 = tab.id） */
  restoreKey: string;
  cursorFrom: number;
  cursorTo: number;
  scrollTop: number;
  onChange: (sql: string) => void;
  onSelectionChange: (from: number, to: number) => void;
  onScroll: (scrollTop: number) => void;
}

/** 由 dialect 构造语言扩展（无连接时用标准 SQL） */
function dialectExtension(dialect: SqlDialect): Extension {
  const config = {
    upperCaseKeywords: true,
    schema: undefined,
  };
  switch (dialect) {
    case "postgres":
      return sql({ dialect: PostgreSQL, ...config });
    case "mysql":
      return sql({ dialect: MySQL, ...config });
    default:
      return sql({ dialect: StandardSQL, ...config });
  }
}

export function SqlEditor(props: SqlEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 回调经 ref 转发，编辑器只创建一次
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  // 外部值回写去重：区分用户输入与切标签/回填
  const lastEmittedRef = useRef(props.value);
  const lastScrollReportRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: callbacksRef.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          foldGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          EditorState.tabSize.of(callbacksRef.current.tabSize),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          ...(callbacksRef.current.completions
            ? [
                autocompletion({
                  override: [
                    makeCompletionSource(callbacksRef.current.schemaCache, () =>
                      callbacksRef.current.getCatalog(),
                    ),
                  ],
                }),
              ]
            : []),
          keymap.of([
            ...defaultKeymap,
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
            { key: "Mod-/", run: toggleComment },
          ]),
          dialectExtension(callbacksRef.current.dialect),
          latticeEditorTheme,
          latticeHighlightStyle,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              lastEmittedRef.current = text;
              callbacksRef.current.onChange(text);
            }
            if (update.selectionSet) {
              const range = update.state.selection.main;
              callbacksRef.current.onSelectionChange(range.from, range.to);
            }
          }),
          EditorView.domEventHandlers({
            scroll: (event, target) => {
              if (event.target !== target.scrollDOM) {
                return false;
              }
              // 节流 200ms：滚动高频，避免每帧触发 store 更新
              const now = Date.now();
              if (now - lastScrollReportRef.current > 200) {
                lastScrollReportRef.current = now;
                callbacksRef.current.onScroll(target.scrollDOM.scrollTop);
              }
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // dialect 变化通过 React key 重建编辑器（见 WorkbenchView），此处不重建
  }, []);

  // 外部值变化（切标签 / 回填 / 格式化）：与用户输入回环去重
  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.value === lastEmittedRef.current) {
      return;
    }
    lastEmittedRef.current = props.value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.value },
      selection: { anchor: Math.min(props.value.length, view.state.selection.main.anchor) },
      effects: [],
    });
    view.requestMeasure();
  }, [props.value]);

  // 光标/滚动恢复（切标签 / 启动恢复；在值替换 effect 之后运行）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const docLength = view.state.doc.length;
    const clamp = (offset: number): number => Math.max(0, Math.min(docLength, offset));
    view.dispatch({
      selection: { anchor: clamp(props.cursorFrom), head: clamp(props.cursorTo) },
    });
    view.scrollDOM.scrollTop = props.scrollTop;
    // 仅在 restoreKey 变化时应用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.restoreKey]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
