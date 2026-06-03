"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useScreenProtection } from "./screen-protection-provider";
import {
  resolveProtectedSurfaceForNode,
  resolveProtectedSurfaceForRanges,
  type ScreenProtectionEventType,
  type ScreenProtectionSurface,
  type DomNodeLike,
  type DomRangeLike,
  type DomElementLike,
} from "@/lib/screen-protection";

/**
 * S1b-3: copy / cut / contextmenu / print の抑止＋client 監査。
 *
 * - useScreenProtection().bypass=true（screen_protection:bypass 保持者）なら抑止も監査もしない。
 *   bypass は fail-safe（判定確定まで false = 抑止側）。
 * - copy / cut / contextmenu は [data-pii-protected] 領域の中だけ抑止する。
 *   input / textarea / select / button / a / contenteditable は除外し通常操作・a11y を壊さない。
 * - Codex P1: copy / cut は event.target だけでなく document.getSelection() の range
 *   (commonAncestor / start / end) も確認し、非editable text 選択で target が body になる
 *   抜け道を塞ぐ。contextmenu は従来どおり target 判定。
 * - 印刷はページ単位（beforeprint / Ctrl+Cmd+P）を監査し、@media print の警告バナーを出す。
 * - 監査送信は throttle 済の直接 fetch("/api/me/audit-events")（api-client は使わない）。
 *
 * できないこと（deterrent であって防止ではない）: OS スクリーンショット・画面録画・外部カメラ撮影は
 * Web から検知も禁止もできない。DevTools / 拡張 /「PDF として保存」等で本抑止は回避可能。
 */

const PII_REGION_SELECTOR = "[data-pii-protected]";
const SURFACE_ATTR = "data-pii-surface";
// 編集系要素(input/textarea/select/contenteditable)の中は常に抑止しない（編集操作・a11y 維持）。
const EDITABLE_SELECTOR =
  "input, textarea, select, [contenteditable], [contenteditable='true']";
// interactive wrapper（button / a）。広い [data-pii-protected] container の中にあるだけの
// 通常 button/link は抑止しない（contextmenu 等の UX を壊さない）。ただし button / a より内側に
// 明示的な PII fragment（owner/phone search suggestions の owner span 等）がある場合のみ保護する。
const INTERACTIVE_SELECTOR = "button, a";
const NOTICE_MS = 2500;
// 同一 eventType の連打を間引く（クライアント側 throttle）。サーバ側 rate-limit と二段防御。
const SEND_THROTTLE_MS = 800;

const REGION_OPTS = {
  piiSelector: PII_REGION_SELECTOR,
  editableSelector: EDITABLE_SELECTOR,
  interactiveSelector: INTERACTIVE_SELECTOR,
  surfaceAttr: SURFACE_ATTR,
};

/** イベント対象（要素 / テキストノード）が PII 保護領域内なら surface を返す。 */
function surfaceFromTarget(
  target: EventTarget | null,
): ScreenProtectionSurface | null {
  if (!(target instanceof Node)) return null;
  return (
    (resolveProtectedSurfaceForNode(
      target as unknown as DomNodeLike,
      REGION_OPTS,
    ) as ScreenProtectionSurface | null) ?? null
  );
}

/**
 * Codex P1: copy/cut では選択範囲も確認する。copy event の target が body / focused element
 * でも、選択(range)の commonAncestor / start / end のいずれかが PII 領域内なら抑止対象にする。
 */
function surfaceFromSelection(): ScreenProtectionSurface | null {
  if (typeof document === "undefined") return null;
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const ranges: DomRangeLike[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    ranges.push(sel.getRangeAt(i) as unknown as DomRangeLike);
  }
  // Codex P2: protected panel をまたぐ選択を range.intersectsNode で検知するため、
  // document 内の保護領域要素を渡す。
  const protectedEls = Array.from(
    document.querySelectorAll(PII_REGION_SELECTOR),
  ) as unknown as DomElementLike[];
  return (
    (resolveProtectedSurfaceForRanges(
      ranges,
      protectedEls,
      REGION_OPTS,
    ) as ScreenProtectionSurface | null) ?? null
  );
}

export default function ScreenProtectionGuard() {
  const { bypass } = useScreenProtection();
  const [notice, setNotice] = useState<string | null>(null);
  const lastSentRef = useRef<Record<string, number>>({});

  const sendAudit = useCallback(
    (eventType: ScreenProtectionEventType, surface: ScreenProtectionSurface) => {
      const now = Date.now();
      const last = lastSentRef.current[eventType] ?? 0;
      if (now - last < SEND_THROTTLE_MS) return;
      lastSentRef.current[eventType] = now;
      // 直接 fetch（api-client 不使用）。失敗してもユーザー操作は妨げない。
      void fetch("/api/me/audit-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType, surface }),
        keepalive: true,
      }).catch(() => {});
    },
    [],
  );

  // 一時通知（aria-live）。
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (bypass) return; // bypass は抑止・監査なし

    const handleClipboard =
      (eventType: "copy" | "cut") => (e: Event) => {
        // Codex P1: target だけでなく選択範囲も確認する。非editable text を選択して
        // Ctrl/Cmd+C した場合に target が body / focused element になる抜け道を塞ぐ。
        const surface = surfaceFromTarget(e.target) ?? surfaceFromSelection();
        if (!surface) return;
        e.preventDefault();
        sendAudit(eventType, surface);
        setNotice("この情報のコピーは制限されています（操作は記録されます）");
      };
    const onCopy = handleClipboard("copy");
    const onCut = handleClipboard("cut");
    const onContextMenu = (e: Event) => {
      const surface = surfaceFromTarget(e.target);
      if (!surface) return;
      e.preventDefault();
      sendAudit("contextmenu", surface);
      setNotice("この情報の操作は制限されています（操作は記録されます）");
    };
    const onBeforePrint = () => {
      // ページ単位。印刷ダイアログ起動を記録（完全ブロックは不可）。
      sendAudit("print", "dashboard");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const isPrint =
        (e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P");
      if (!isPrint) return;
      sendAudit("print_shortcut", "dashboard");
      setNotice("印刷は記録されます");
      e.preventDefault(); // best-effort（確実には止まらない）
    };

    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCut, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("beforeprint", onBeforePrint);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("beforeprint", onBeforePrint);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [bypass, sendAudit]);

  if (bypass) return null;

  return (
    <>
      {/* 印刷時のみ表示する保護バナー（screen では display:none、globals.css で制御）。 */}
      <div
        data-screen-protection-print-notice
        className="screen-protection-print-notice"
      >
        この文書には個人情報が含まれます。印刷・複製は記録され、無断持ち出しは禁止されています。
      </div>
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-md bg-gray-900/90 px-4 py-2 text-sm text-white shadow-lg"
        >
          {notice}
        </div>
      )}
    </>
  );
}
