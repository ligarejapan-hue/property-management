"use client";

/**
 * 売却DMの手順の案内(発注者決定 2026-09-27「おすすめで」)。
 *  - 画面上部の帯: 手順の並び(済み/いま)と「次にやること」。「案内を消す」で各自が消せる(この端末に記憶)。
 *  - 次に押すボタンを光らせ、横に一言のアドバイスを出す。
 *  - 順番の違うボタン(先の段)を押しても止めない。先にやることを一言で出す。
 * 段の決め方は lib/sale-dm-letter/step-guide.ts(純関数)。ボタンは data-guide の目印で探す。
 *
 * ⚠光らせる・吹き出しの位置合わせは DOM を直接触る(React の state を effect で書かない=
 *   react-hooks/set-state-in-effect を避け、開閉のたびに描き直しを起こさない)。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SALE_DM_GUIDE_STEPS,
  guideStepIndex,
  guideTargetCandidates,
  isAheadOfGuide,
  visibleGuideSteps,
  type SaleDmGuideState,
} from "@/lib/sale-dm-letter/step-guide";

const STORAGE_KEY = "pm-sale-dm-guide-off";
// 光らせる見た目(Tailwind の class を文字列のまま持つ=ビルドで拾われる)。
const GLOW_CLASSES = ["ring-4", "ring-amber-400", "ring-offset-2", "motion-safe:animate-pulse"];

const listeners = new Set<() => void>();
function readOff(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOff(off: boolean) {
  try {
    if (off) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できない端末では、この画面を開いているあいだだけ効く。
  }
  memoryOff = off;
  listeners.forEach((l) => l());
}
let memoryOff: boolean | null = null;
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const getSnapshot = () => (memoryOff ?? readOff());
const getServerSnapshot = () => false;

const STATE_MESSAGES: Partial<Record<SaleDmGuideState, string>> = {
  no_recipients: "宛先がありません。物件一覧で、DM状態が「送付可」で住所のある所有者がいる物件を選び、売却DMを作り直してください。",
  done: "すべて送付済みです。申込は「査定の申込」に届きます。",
  done_excluded: "送れる宛先はすべて送付済みです。残りの宛先は拒否・宛先不明の記録があるため、印刷にも送付にも使えません。",
};

export function SaleDmStepGuide({
  state,
  onPrintConfirmed,
  onSkipLp,
  scenarioCampaign = false,
}: {
  state: SaleDmGuideState;
  /** 種類つきの発送(DMの種類)。帯に「LP型を作る」「均等に割り当て」を並べない。 */
  scenarioCampaign?: boolean;
  /** LP型が1つも無いときだけ渡る。「LP型を使わずに進む」(QRは外部LPへ転送=正式な使い方)。 */
  onSkipLp?: () => void;
  /** 印刷を押したあとだけ渡る。帯の「印刷できた」で呼ぶ(押すまで次の段へ進めない)。 */
  onPrintConfirmed?: () => void;
}) {
  const off = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const on = !off;
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleTextRef = useRef<HTMLSpanElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const idx = guideStepIndex(state);
  const current = idx >= 0 ? SALE_DM_GUIDE_STEPS[idx] : null;

  // 光らせる+吹き出しの位置合わせ。枠の開閉でボタンが出入りするので、DOM の変化でも付け直す。
  useEffect(() => {
    const clear = () => {
      targetRef.current?.classList.remove(...GLOW_CLASSES);
      targetRef.current = null;
      if (bubbleRef.current) bubbleRef.current.hidden = true;
    };
    if (!on || !current) {
      clear();
      return;
    }
    let raf = 0;
    const place = () => {
      const el = guideTargetCandidates(current.key)
        .map((k) => document.querySelector<HTMLElement>(`[data-guide="${k}"]`))
        .find((e): e is HTMLElement => !!e && e.offsetParent !== null) ?? null;
      if (el !== targetRef.current) {
        targetRef.current?.classList.remove(...GLOW_CLASSES);
        el?.classList.add(...GLOW_CLASSES);
        targetRef.current = el;
      }
      const b = bubbleRef.current;
      if (!b) return;
      if (!el) {
        b.hidden = true;
        return;
      }
      // 同じ文言を書き直すと DOM の変化として自分の見張りに拾われ、描き直しが続く=違うときだけ書く。
      if (bubbleTextRef.current && bubbleTextRef.current.textContent !== current.tip) {
        bubbleTextRef.current.textContent = current.tip;
      }
      b.hidden = false;
      const r = el.getBoundingClientRect();
      const width = b.offsetWidth;
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      // 画面(ビューポート)基準で置く=管理画面の中身が枠の中でスクロールしても合う(scroll は捕捉で拾う)。
      b.style.left = `${left}px`;
      b.style.top = `${r.bottom + 10}px`;
      // ボタンが画面外にあるときは吹き出しも隠す(帯の「光っているボタンへ移動」で寄れる)。
      b.hidden = r.bottom < 0 || r.top > window.innerHeight;
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    schedule();
    const mo = new MutationObserver(schedule);
    // 同じ段のまま目印(data-guide)だけが別の型のボタンへ移ることがある=属性の変化も見る(@codex #449 R6)。
    // ⚠光らせる class の付け外しは見ない(attributeFilter で data-guide だけ)=自分の書き込みで回り続けない。
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-guide"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      clear();
    };
  }, [on, current]);

  // 順番の違うボタン(先の段)を押したら、先にやることを一言(押すこと自体は止めない)。
  useEffect(() => {
    if (!on || !current) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-guide]") : null;
      const key = t?.dataset.guide;
      if (!key || !isAheadOfGuide(key, state)) return;
      setHint(`先に「${current.label}」を済ませてください。${current.tip}`);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(null), 6000);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [on, current, state]);

  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  if (!on) {
    return (
      <div className="flex justify-end">
        <button type="button" onClick={() => writeOff(false)} className="text-xs text-indigo-700 underline hover:no-underline dark:text-indigo-300">
          手順の案内を出す
        </button>
      </div>
    );
  }

  return (
    <>
      <section aria-label="手順の案内" className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
            {current ? (
              <>
                <span className="mr-1.5 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-bold text-amber-900 dark:bg-amber-800 dark:text-amber-100">次にやること</span>
                {current.label}
              </>
            ) : (
              STATE_MESSAGES[state]
            )}
          </span>
          <span className="ml-auto flex gap-3">
            {current && (
              <button
                type="button"
                onClick={() => targetRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })}
                className="text-indigo-700 underline hover:no-underline dark:text-indigo-300"
              >
                光っているボタンへ移動
              </button>
            )}
            <button type="button" onClick={() => writeOff(true)} className="text-gray-600 underline hover:no-underline dark:text-gray-300">
              案内を消す
            </button>
          </span>
        </div>
        {state === "add_lp" && onSkipLp && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-gray-700 dark:text-gray-200">
            <span>ご案内ページを使わない場合は、お手紙のQRは外部LPへ転送されます。</span>
            <button type="button" onClick={onSkipLp} className="text-indigo-700 underline hover:no-underline dark:text-indigo-300">
              LP型を使わずに進む
            </button>
          </div>
        )}
        {state === "print" && onPrintConfirmed && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-gray-700 dark:text-gray-200">
            <span>別のタブで手紙とQR(申込用・配信停止用)が出たら、次へ進みます。</span>
            <button
              type="button"
              onClick={onPrintConfirmed}
              className="rounded-md bg-amber-500 px-2.5 py-1 font-medium text-white hover:bg-amber-600"
            >
              印刷できた
            </button>
            <span className="text-gray-500 dark:text-gray-400">(開かない・白いページのときは押さずに、もう一度「印刷」)</span>
          </div>
        )}
        {current && (
          <ol className="mt-1.5 flex flex-wrap gap-1.5" aria-label="手順">
            {visibleGuideSteps(scenarioCampaign).map((s, i) => ({ s, i, at: guideStepIndex(s.key) })).map(({ s, i, at }) => (
              <li
                key={s.key}
                aria-current={at === idx ? "step" : undefined}
                className={
                  at < idx
                    ? "rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                    : at === idx
                      ? "rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 font-bold text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"
                      : "rounded-full border border-gray-200 bg-white px-2 py-0.5 text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
                }
              >
                {at < idx ? "✓ " : `${i + 1}. `}
                {s.label}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* 光らせたボタンの横の一言(位置は上の effect が合わせる)。 */}
      <div
        ref={bubbleRef}
        hidden
        role="status"
        className="fixed z-40 w-[min(320px,calc(100vw-32px))] rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
      >
        <strong className="block text-[11px] tracking-wide text-amber-300 dark:text-amber-700">ここを押す</strong>
        <span ref={bubbleTextRef} />
      </div>

      {hint && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2.5 text-xs leading-relaxed text-white shadow-lg dark:bg-gray-100 dark:text-gray-900">
          {hint}
        </div>
      )}
    </>
  );
}
