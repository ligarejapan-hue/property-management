/** 作業中の入力の控えに関する帯(設計書 §3・§5)。見た目だけ=SSRで試せる。 */
import { AlertTriangle, History } from "lucide-react";
import { isSameFileName } from "@/lib/drafts/reselect";

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

/** 大きすぎて控えられないときの知らせ。kind="input"=入力欄(小窓)、既定=読み込んだファイル。 */
export function DraftTooLargeNotice({ kind = "file" }: { kind?: "file" | "input" }) {
  return (
    <div role="status" data-testid="draft-too-large-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        {kind === "input" ? "入力した内容が大きいため" : "このファイルは大きいため"}、別の画面へ移ると消えます。
      </span>
    </div>
  );
}

/**
 * 控えから戻した画面で、ファイル本体だけは戻せないので選び直しを求める(設計書 §4.3)。
 * 選んだ後は、名前が違うときだけ確かめる一文を出す(同じなら何も出さない)。
 */
export function DraftReselectFileNotice({ expectedName, chosenName }: { expectedName: string; chosenName: string | null }) {
  if (chosenName == null) {
    return (
      <div role="status" data-testid="draft-reselect-notice" className={WARN}>
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>PDF「{expectedName}」を選び直してください（登録のときに添付します。読み取った結果はそのまま使います）。</span>
      </div>
    );
  }
  if (isSameFileName(expectedName, chosenName)) return null;
  return (
    <div role="status" data-testid="draft-reselect-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>前回と違う名前のファイルです（前回: {expectedName}）。同じ書類か確かめてください。</span>
    </div>
  );
}

/**
 * 取り込み(CSV)の結果が分からない(設計書 §5.1 S4)。内容は戻さず、履歴で確かめてもらう。
 * reason="left" = 送信中に画面を離れて戻った / "unknown" = 画面に残ったまま 5xx・通信切れになった。
 */
export function DraftImportPendingNotice({
  onDismiss,
  reason = "left",
}: {
  onDismiss: () => void;
  reason?: "left" | "unknown";
}) {
  return (
    <div role="alert" data-testid="draft-import-pending-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {reason === "left" ? (
        <span>前回、取り込みの途中で画面を離れました。下の「取り込み履歴」で結果を確かめてください。</span>
      ) : (
        <span>取り込みの結果が分かりませんでした（通信が切れたか、サーバーで問題が起きました）。下の「取り込み履歴」で結果を確かめてから続けてください。</span>
      )}
      <button type="button" onClick={onDismiss} className={BTN}>
        {reason === "left" ? "閉じる" : "確かめたので続ける"}
      </button>
    </div>
  );
}
