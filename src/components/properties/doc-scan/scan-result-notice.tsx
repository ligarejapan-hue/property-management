"use client";

/**
 * 書類を撮ったあとの知らせ(添付タブの上)。
 * - 種類が当たった: 「PDFにして添付に入れました(3枚)」+「売買契約書」と判別し、③契約関係に入れました
 * - 当たらなかった: 「その他」に入れたので、行の「種類」で選んでください
 * - 文字がほとんど無かった: 現地の写真なら写真タブへ移せます(ボタン)
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ScanNotice =
  | {
      kind: "saved";
      pages: number;
      kindLabel: string | null;
      stageLabel: string | null;
      littleText: boolean;
      moving: boolean;
    }
  | { kind: "photos"; count: number };

interface ScanResultNoticeProps {
  notice: ScanNotice;
  onMoveToPhotos: () => void;
  onDismiss: () => void;
}

export default function ScanResultNotice({ notice, onMoveToPhotos, onDismiss }: ScanResultNoticeProps) {
  return (
    <div
      role="status"
      className="mb-3 flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-bold">
          {notice.kind === "photos"
            ? `写真タブへ入れました(${notice.count}枚)`
            : `PDFにして添付に入れました(${notice.pages}枚)`}
        </span>
        {/* data-ui=raw: 知らせの角の閉じる×(ボタンの形をしていない押せる面) */}
        <button type="button" data-ui="raw" aria-label="知らせを閉じる" onClick={onDismiss} className="-m-1 p-1">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {notice.kind === "saved" &&
        (notice.kindLabel ? (
          <span className="leading-relaxed">
            文字を読んで「{notice.kindLabel}」と判別し、{notice.stageLabel ?? "その他"}に入れました。
          </span>
        ) : (
          <span className="leading-relaxed text-amber-800 dark:text-amber-300">
            種類が分かりませんでした。「その他」に入れたので、行の「種類」で選んでください。
          </span>
        ))}
      {notice.kind === "saved" && notice.littleText && (
        <div className="flex flex-col gap-2 rounded-md border border-indigo-200 bg-indigo-50 p-2 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200">
          <span>文字がほとんど写っていません。現地の写真なら写真タブへ移せます。</span>
          <Button type="button" variant="secondary" onClick={onMoveToPhotos} loading={notice.moving} className="h-11 font-bold">
            写真タブへ移す
          </Button>
        </div>
      )}
    </div>
  );
}
