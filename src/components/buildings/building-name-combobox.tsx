"use client";

import { useEffect, useRef, useState } from "react";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import type { BuildingSuggestion } from "@/lib/building-link/suggest";
import {
  canUseListKeys,
  choiceSummary,
  listState,
  isLatestRequest,
  nextActiveIndex,
  pickAtIndex,
  selectedInArea,
  shouldHandleListKey,
  shouldFetchSuggestions,
  shouldOpenOnArrow,
  suggestionBadges,
  suggestArea,
  suggestQueryStringForArea,
  type SuggestListState,
  type SuggestResult,
} from "@/lib/building-link/combobox-model";

export interface BuildingNameComboboxProps {
  id: string;
  testId?: string;
  value: string;
  onChange: (name: string) => void;
  address: string;
  choice: BuildingChoice;
  onChoiceChange: (choice: BuildingChoice) => void;
  disabled?: boolean;
  placeholder?: string;
  inputClassName?: string;
}

/** 候補の一覧(SSR テストのため切り出す)。一番下は常に「新しい棟として登録する」(D8)。 */
export function BuildingSuggestionList({
  suggestions,
  activeIndex,
  onPick,
  listId,
}: {
  suggestions: BuildingSuggestion[];
  activeIndex: number;
  onPick: (s: BuildingSuggestion | "new") => void;
  listId: string;
}) {
  return (
    <ul
      id={listId}
      role="listbox"
      className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      {suggestions.map((s, i) => (
        <li
          key={s.id}
          id={`${listId}-opt-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
          }}
          className={`flex min-h-[44px] cursor-pointer flex-col justify-center px-3 py-1.5 text-sm ${
            i === activeIndex ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"
          }`}
        >
          <span className="flex flex-wrap items-center gap-1 text-gray-900 dark:text-gray-100">
            {s.name}
            {suggestionBadges(s).map((b) => (
              <span
                key={b}
                className={`rounded px-1 text-[10px] ${
                  b === "丁目が違います"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    : "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                }`}
              >
                {b}
              </span>
            ))}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {s.area || "住所不明"}・{s.unitCount}部屋
          </span>
        </li>
      ))}
      <li
        id={`${listId}-opt-${suggestions.length}`}
        role="option"
        aria-selected={activeIndex === suggestions.length}
        onMouseDown={(e) => {
          e.preventDefault();
          onPick("new");
        }}
        className={`flex min-h-[44px] cursor-pointer items-center border-t border-gray-100 px-3 text-sm text-indigo-700 dark:border-gray-800 dark:text-indigo-300 ${
          activeIndex === suggestions.length ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"
        }`}
      >
        新しい棟として登録する
      </li>
    </ul>
  );
}

/**
 * 読み込み中・失敗のときの行(@codex R3)。⚠選べる行(option)を持たない=
 * 「新しい棟として登録する」も出さない(終わる前に選ぶと重複の棟を作りうる)。
 */
export function BuildingSuggestionStatus({ state, listId }: { state: Exclude<SuggestListState, "ready">; listId: string }) {
  return (
    <div
      id={listId}
      role="status"
      className="absolute z-20 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
    >
      {state === "loading" ? "候補を探しています…" : "候補を読み込めませんでした。保存するときに自動で判断します"}
    </div>
  );
}

export default function BuildingNameCombobox(props: BuildingNameComboboxProps) {
  const { id, testId, value, onChange, address, choice, onChoiceChange, disabled, placeholder, inputClassName } = props;
  // 候補は「どの入力に対する結果か」と一緒に持つ。入力と一致するときだけ出す
  // (⚠effect の中で同期的に setState しない=eslint react-hooks/set-state-in-effect)。
  // ⚠どの町丁目で並べた結果かも持つ。住所を変えたら前の丁目の候補は出さない(@codex R2)。
  const area = suggestArea(address);
  // ⚠成否も持つ。今の名前+丁目の問い合わせが成功で終わるまで、選べる一覧は出さない(@codex R3)。
  const [result, setResult] = useState<SuggestResult | null>(null);
  const state = listState(result, value, area);
  const suggestions = state === "ready" && result ? result.data : [];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // 選んだ棟は「どの丁目で選んだか」と一緒に持つ。丁目が変わったら要約に使わない(@codex R4)。
  const [selected, setSelected] = useState<{ suggestion: BuildingSuggestion; area: string } | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    // ⚠打ち直したら古い候補を無効にする(連番を進める)。
    seqRef.current += 1;
    const seq = seqRef.current;
    if (!shouldFetchSuggestions(value)) return;
    // 失敗は「今の名前+丁目で失敗した」として残す(一覧は「読み込めませんでした」になり、
    // 「新しい棟」は選べない)。⚠set はこの非同期の続きの中だけ(effect 本体では呼ばない)。
    const fail = () => {
      if (!isLatestRequest(seq, seqRef.current)) return;
      setResult({ query: value, area, status: "error", data: [] });
      setActiveIndex(-1);
    };
    const timer = setTimeout(async () => {
      try {
        // ⚠住所はそのまま送らない(町丁目に丸める=suggestQueryString)。
        const res = await fetch(`/api/buildings/suggest?${suggestQueryStringForArea(value, area)}`);
        if (!isLatestRequest(seq, seqRef.current)) return;
        if (!res.ok) return fail();
        const body = (await res.json()) as { data?: unknown };
        if (!Array.isArray(body.data)) return fail();
        if (isLatestRequest(seq, seqRef.current)) {
          setResult({ query: value, area, status: "ok", data: body.data as BuildingSuggestion[] });
          setActiveIndex(-1);
        }
      } catch {
        // 候補が出なくても入力と保存は止めない(保存時に自動で判断する)。
        fail();
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [value, area]);

  const pick = (s: BuildingSuggestion | "new") => {
    if (s === "new") {
      setSelected(null);
      onChoiceChange({ kind: "new" });
    } else {
      setSelected({ suggestion: s, area });
      onChange(s.name);
      onChoiceChange({ kind: "existing", buildingId: s.id });
    }
    setOpen(false);
    setActiveIndex(-1);
  };

  const optionCount = suggestions.length + 1;
  const listId = `${id}-suggestions`;
  const summary = choiceSummary(choice, selectedInArea(selected, area));

  return (
    <div className="relative">
      <input
        id={id}
        data-testid={testId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && state === "ready" && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        className={inputClassName}
        onChange={(e) => {
          onChange(e.target.value);
          // 打ち直したら選択を外して自動の判断に戻す(§6.1)。
          if (choice.kind !== "auto") onChoiceChange({ kind: "auto" });
          setSelected(null);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          // Esc・選んだ後に閉じた一覧は、上下キーで開き直す。
          if (shouldOpenOnArrow({ open, key: e.key, isComposing: e.nativeEvent.isComposing, value })) {
            e.preventDefault();
            setOpen(true);
            return;
          }
          if (!open || !shouldFetchSuggestions(value)) return;
          if (!shouldHandleListKey(e.nativeEvent.isComposing)) return;
          if (e.key === "Escape") {
            setOpen(false);
            return;
          }
          // ⚠読み込み中・失敗のときは上下キー・Enter で何も選ばない(「新しい棟」も)。
          if (!canUseListKeys(state)) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((cur) => nextActiveIndex(cur, e.key as "ArrowDown" | "ArrowUp", optionCount));
          } else if (e.key === "Enter") {
            const target = pickAtIndex(activeIndex, suggestions);
            if (target === null) return;
            e.preventDefault();
            pick(target);
          }
        }}
      />
      {open && shouldFetchSuggestions(value) && (
        state === "ready" ? (
          <BuildingSuggestionList suggestions={suggestions} activeIndex={activeIndex} onPick={pick} listId={listId} />
        ) : (
          <BuildingSuggestionStatus state={state} listId={listId} />
        )
      )}
      {summary && (
        <p data-testid={testId ? `${testId}-choice` : undefined} className="mt-1 text-xs text-indigo-700 dark:text-indigo-300">
          {summary}
        </p>
      )}
    </div>
  );
}
