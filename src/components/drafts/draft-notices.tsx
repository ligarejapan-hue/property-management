/** 作業中の入力の控えに関する帯(設計書 §3・§5)。見た目だけ=SSRで試せる。 */
import { AlertTriangle, History } from "lucide-react";

const fmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 控えた時刻を日本時間の「H時MM分」で。 */
export function formatDraftTime(ms: number): string {
  const parts = fmt.formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}時${m.padStart(2, "0")}分`;
}

const BOX = "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm";
const INFO = `${BOX} border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200`;
const WARN = `${BOX} border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200`;
const BTN =
  "ml-auto rounded-md border border-current px-2 py-0.5 text-xs font-medium hover:bg-white/60 dark:hover:bg-black/20";

export function DraftRestoredNotice({ savedAt, onDiscard }: { savedAt: number; onDiscard: () => void }) {
  return (
    <div role="status" data-testid="draft-restored-notice" className={INFO}>
      <History className="h-4 w-4 shrink-0" />
      <span>前回の続きを表示しています（{formatDraftTime(savedAt)}の入力）</span>
      <button type="button" onClick={onDiscard} className={BTN}>
        最初からやり直す
      </button>
    </div>
  );
}

export function DraftPendingNotice({ onConfirm }: { onConfirm: () => void }) {
  return (
    <div role="alert" data-testid="draft-pending-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>前回、登録の途中で画面を離れました。登録されたかどうかを物件一覧で確かめてください。</span>
      <button type="button" onClick={onConfirm} className={BTN}>
        確かめたので続ける
      </button>
    </div>
  );
}

export function DraftStaleNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="status" data-testid="draft-stale-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>ほかの方が保存したため、入力途中の内容は使えませんでした。</span>
      <button type="button" onClick={onDismiss} className={BTN}>
        閉じる
      </button>
    </div>
  );
}

export function DraftTooLargeNotice() {
  return (
    <div role="status" data-testid="draft-too-large-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>このファイルは大きいため、別の画面へ移ると消えます。</span>
    </div>
  );
}
