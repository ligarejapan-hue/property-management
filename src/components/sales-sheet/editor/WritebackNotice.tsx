"use client";

import { useEffect, useState } from "react";

export type WritebackSummary = {
  saved: string[];
  unreadable: string[];
  conflict: boolean;
  /** 入力されたが保存先が無かった項目([@codex P2]・棟に紐づいていない区分の棟項目)。 */
  noTarget?: string[];
};

/** 知らせの文言(純関数・テストで固定する)。 */
export function writebackMessages(s: WritebackSummary): string[] {
  const out: string[] = [];
  if (s.saved.length > 0) out.push(`${s.saved.join("・")}を物件に保存しました`);
  if (s.conflict) {
    out.push("他の人が先に物件を更新していたため、物件には保存していません(図面は作成済みです)");
  }
  if (s.unreadable.length > 0) {
    out.push(`${s.unreadable.join("・")}は数値や年月として読み取れなかったため、物件には保存していません`);
  }
  // 反映前に作られた知らせ(noTarget が無い)でも壊れないように ?? [] で受ける。
  const noTarget = s.noTarget ?? [];
  if (noTarget.length > 0) {
    out.push(
      `${noTarget.join("・")}は棟に保存する項目ですが、この物件は棟に紐づいていないため保存していません`,
    );
  }
  return out;
}

/**
 * 図面作成直後、エディタ上部で「物件への保存結果」を一度だけ知らせる(F3 Task6)。
 *
 * Task 5 が sessionStorage の `sales-sheet-writeback:<designId>` に残した
 * propertyWriteback を読み、読んだら即座に削除する(再読込・戻る操作で再表示しない)。
 * sessionStorage が使えない環境(プライベートウィンドウ等)でも例外を投げず、
 * 単に何も出さない。
 */
export function WritebackNotice({ designId }: { designId: string }): React.ReactElement | null {
  const [messages, setMessages] = useState<string[]>([]);
  useEffect(() => {
    // ⚠effect 内の同期 setState は lint 規約(react-hooks/set-state-in-effect)で禁止のため、
    // registry-preflight-warnings.tsx と同じく microtask 経由で行う(マウント直後には必ず反映される)。
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      const key = `sales-sheet-writeback:${designId}`;
      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return;
        sessionStorage.removeItem(key); // 一度だけ出す
        setMessages(writebackMessages(JSON.parse(raw) as WritebackSummary));
      } catch {
        // 読めないときは何も出さない
      }
    });
    return () => {
      cancelled = true;
    };
  }, [designId]);

  if (messages.length === 0) return null;
  return (
    <div className="mb-2 rounded border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-500 dark:bg-blue-900/30 dark:text-blue-100">
      <div className="flex items-start justify-between gap-2">
        <ul className="list-none space-y-0.5">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <button type="button" onClick={() => setMessages([])} className="shrink-0 text-xs underline">
          閉じる
        </button>
      </div>
    </div>
  );
}
