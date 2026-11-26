"use client";

/**
 * どこからでも開ける検索の枠「探す」(2026-11-26 発注者依頼「単語を入力すれば該当するページに飛ぶ」)。
 * - 右上の「探す」か Ctrl+K(Mac は ⌘K)で開く
 * - 画面の名前・別名と「やりたいこと」(答え+飛び先)を引く=lib/quick-jump/search.ts
 * - 外には何も送らない。打った言葉は記録しない
 * - 見せるのは、その人の役割で開ける画面だけ(メニューと同じ決まり)
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Search, ArrowRight } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { SIDEBAR_GROUPS } from "./sidebar-model";
import { searchQuickJump, type QuickJumpResult } from "@/lib/quick-jump/search";

export const QUICK_JUMP_OPTION_ID = (i: number) => `pm-quick-jump-${i}`;

/** 結果の一覧(見た目だけ・SSR でテストする)。 */
export function QuickJumpResults({
  query,
  results,
  activeIndex,
  onPick,
}: {
  query: string;
  results: QuickJumpResult[];
  activeIndex: number;
  onPick?: () => void;
}) {
  if (!query.trim()) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        画面の名前や、やりたいことを打ってください。例: 「規約」「鍵の本数を入力したい」「固定資産税評価額はどの書類に載ってる？」
      </p>
    );
  }
  if (results.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        見つかりませんでした。短い言葉で言い換えてみてください(例: 「鍵受領書」「謄本」)。
        詳しくは
        <a href="/docs/manual.html" target="_blank" rel="noopener noreferrer" className="mx-1 text-indigo-600 underline dark:text-indigo-400">
          取り扱いマニュアル
        </a>
        を見てください。
      </p>
    );
  }
  return (
    <ul role="listbox" aria-label="探した結果" className="max-h-[60vh] space-y-1 overflow-y-auto">
      {results.map((r, i) => {
        const active = i === activeIndex;
        const cls = `block rounded-md px-3 py-2 text-left ${
          active ? "bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-950/40 dark:ring-indigo-700" : "hover:bg-gray-50 dark:hover:bg-gray-800"
        }`;
        const body = (
          <>
            <span className="flex items-center gap-2">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                  r.kind === "howto"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                    : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                }`}
              >
                {r.kind === "howto" ? "やりかた" : "画面"}
              </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{r.title}</span>
            </span>
            <span className="mt-0.5 block text-sm text-gray-600 dark:text-gray-400">{r.detail}</span>
            {r.kind === "howto" && (
              <span className="mt-1 inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400">
                {r.hrefLabel ?? "開く"}
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            )}
          </>
        );
        return (
          <li key={r.key} role="option" aria-selected={active}>
            {r.external ? (
              <a
                id={QUICK_JUMP_OPTION_ID(i)}
                href={r.href}
                target={r.windowName ?? "_blank"}
                rel={r.windowName ? undefined : "noopener noreferrer"}
                className={cls}
                onClick={onPick}
              >
                {body}
              </a>
            ) : (
              <Link id={QUICK_JUMP_OPTION_ID(i)} href={r.href} className={cls} onClick={onPick}>
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Ctrl+K / ⌘K か(打ちかけの日本語の確定中は除く)。 */
export function isQuickJumpShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): boolean {
  // Shift/Alt が付いたもの(Ctrl+Shift+K=ブラウザの開発者ツールなど)は奪わない
  return !e.isComposing && !e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
}

function QuickJumpDialog({ userRole, onClose }: { userRole: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchQuickJump(query, userRole, SIDEBAR_GROUPS), [query, userRole]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 矢印で選んだ行が見えるように
  useEffect(() => {
    document.getElementById(QUICK_JUMP_OPTION_ID(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // 押したのと同じ道で開く(リンクを押す)
      document.getElementById(QUICK_JUMP_OPTION_ID(Math.min(activeIndex, results.length - 1)))?.click();
    }
  };

  return (
    <ModalShell
      title="探す"
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          閉じる
        </Button>
      }
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="画面の名前・やりたいこと(例: 鍵の本数を入力したい)"
          aria-label="探す言葉"
          aria-controls="pm-quick-jump-results"
          aria-activedescendant={results.length ? QUICK_JUMP_OPTION_ID(Math.min(activeIndex, results.length - 1)) : undefined}
          autoComplete="off"
          className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
      </div>
      <div id="pm-quick-jump-results">
        <QuickJumpResults query={query} results={results} activeIndex={activeIndex} onPick={onClose} />
      </div>
    </ModalShell>
  );
}

/** 右上の「探す」ボタン+Ctrl+K。 */
export default function QuickJump({ userRole }: { userRole: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isQuickJumpShortcut(e)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="border border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300"
        title="探す(Ctrl+K)"
        aria-label="探す"
      >
        <Search className="h-4 w-4" />
        <span className="hidden md:inline">探す</span>
        <kbd className="hidden rounded border border-gray-300 px-1 text-xs text-gray-500 lg:inline dark:border-gray-600 dark:text-gray-400">Ctrl K</kbd>
      </Button>
      {open && <QuickJumpDialog userRole={userRole} onClose={() => setOpen(false)} />}
    </>
  );
}
