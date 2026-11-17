"use client";

import { useEffect, useRef, useState } from "react";
import type { DirectoryChoice } from "@/lib/bank-directory/account-fields";

/**
 * 金融機関・支店の名前の入力欄(候補つき・2026-11-17 発注者「一文字目で検索・支店はその銀行の中から」)。
 * - 打った字で候補を出し、選ぶと正式な名前を入れる。候補に無くても打ったまま保存できる(自由入力)。
 * - 候補の問い合わせは「どの字に対する結果か」と一緒に持ち、今の字と一致するときだけ出す(古い結果を出さない)。
 */

type Result = { key: string; status: "ok" | "error"; data: DirectoryChoice[] };

/** 候補の一覧(SSR テストのため切り出す)。 */
export function DirectoryOptionList({
  options, activeIndex, listId, onPick, showCode,
}: {
  options: DirectoryChoice[];
  activeIndex: number;
  listId: string;
  onPick: (c: DirectoryChoice) => void;
  /** 金融機関はコードも小さく出す(同じような名前を見分けるため)。 */
  showCode?: boolean;
}) {
  return (
    <ul id={listId} role="listbox"
      className="absolute z-20 mt-1 max-h-72 w-full min-w-[14rem] overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
      {options.map((o, i) => (
        <li key={o.code} id={`${listId}-opt-${i}`} role="option" aria-selected={i === activeIndex}
          onMouseDown={(e) => { e.preventDefault(); onPick(o); }}
          className={`flex min-h-[40px] cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm ${
            i === activeIndex ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"
          }`}>
          <span className="text-gray-900 dark:text-gray-100">{o.name}</span>
          {showCode && <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{o.code}</span>}
        </li>
      ))}
    </ul>
  );
}

/** 候補の代わりに出す一言(読み込み中・該当なし・支店は銀行を選んでから など)。 */
export function DirectoryStatus({ text, listId }: { text: string; listId: string }) {
  return (
    <div id={listId} role="status"
      className="absolute z-20 mt-1 w-full min-w-[14rem] rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
      {text}
    </div>
  );
}

/** 一覧の代わりに出す一言(純関数)。null=一覧を出す。 */
export function directoryStatusText(p: {
  value: string; url: string | null; noUrlText: string; result: Result | null; resultMatches: boolean;
}): string | null {
  if (p.value.trim() === "") return null;
  if (p.url === null) return p.noUrlText;
  if (!p.result || !p.resultMatches) return "候補を探しています…";
  if (p.result.status === "error") return "候補を読み込めませんでした。そのまま入力できます";
  if (p.result.data.length === 0) return "候補がありません。そのまま入力できます";
  return null;
}

export default function DirectoryCombobox({
  id, value, onType, onPick, searchUrl, noUrlText = "", ariaLabel, placeholder, maxLength, className, showCode,
}: {
  id: string;
  value: string;
  onType: (text: string) => void;
  onPick: (c: DirectoryChoice) => void;
  /** 打った字から問い合わせ先を作る。null=候補を出せない(支店で銀行がまだ選ばれていない)。 */
  searchUrl: (q: string) => string | null;
  /** searchUrl が null のときに出す一言。 */
  noUrlText?: string;
  ariaLabel: string;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  showCode?: boolean;
}) {
  const url = value.trim() === "" ? null : searchUrl(value.trim());
  const [result, setResult] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const seqRef = useRef(0);

  useEffect(() => {
    // ⚠打ち直したら古い問い合わせを無効にする(連番を進める)。set は非同期の続きの中だけ。
    seqRef.current += 1;
    const seq = seqRef.current;
    if (url === null) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(url);
        if (seq !== seqRef.current) return;
        const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
        if (seq !== seqRef.current) return;
        const data = res.ok && body && Array.isArray(body.data) ? (body.data as DirectoryChoice[]) : null;
        setResult({ key: url, status: data ? "ok" : "error", data: data ?? [] });
        setActiveIndex(-1);
      } catch {
        if (seq === seqRef.current) setResult({ key: url, status: "error", data: [] });
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [url]);

  const resultMatches = !!result && url !== null && result.key === url;
  const statusText = directoryStatusText({ value, url, noUrlText, result, resultMatches });
  const options = result && resultMatches && result.status === "ok" ? result.data : [];
  const listId = `${id}-options`;
  const showList = open && value.trim() !== "";

  const pick = (c: DirectoryChoice) => {
    onPick(c);
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && activeIndex >= 0 && activeIndex < options.length ? `${listId}-opt-${activeIndex}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        className={className}
        onChange={(e) => {
          onType(e.target.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          // 変換中(IME)の Enter・矢印は文字の確定に使うので触らない。
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            setOpen(false);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!showList) {
              setOpen(true);
              return;
            }
            if (options.length === 0) return;
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((cur) => (cur < 0 ? (step === 1 ? 0 : options.length - 1) : (cur + step + options.length) % options.length));
          } else if (e.key === "Enter" && showList && activeIndex >= 0 && activeIndex < options.length) {
            e.preventDefault();
            pick(options[activeIndex]);
          }
        }}
      />
      {showList && (statusText !== null
        ? <DirectoryStatus text={statusText} listId={listId} />
        : <DirectoryOptionList options={options} activeIndex={activeIndex} listId={listId} onPick={pick} showCode={showCode} />)}
    </div>
  );
}

/** 金融機関の候補の問い合わせ先。 */
export const bankSearchUrl = (q: string) => `/api/deals/bank-directory/banks?q=${encodeURIComponent(q)}`;
/** 支店の候補の問い合わせ先(銀行が候補から選ばれていないときは null)。 */
export const branchSearchUrl = (bankCode: string) => (q: string) =>
  /^\d{4}$/.test(bankCode) ? `/api/deals/bank-directory/branches?bank=${bankCode}&q=${encodeURIComponent(q)}` : null;
export const BRANCH_NEEDS_BANK_TEXT = "銀行名を候補から選ぶと、その銀行の支店が候補に出ます(そのまま入力もできます)";
