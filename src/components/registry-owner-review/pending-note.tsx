/**
 * 品質チェックの画面に出す「謄本の名義 比べ直し待ち N件」(情報・警告ではない・2026-11-08)。
 * 毎晩(日本時間 2〜5時)自動で少しずつ比べる。開ける人には確認の画面へのリンクを出す。
 */
import Link from "next/link";
import { Info } from "lucide-react";

import { REGISTRY_OWNER_REVIEW_HREF } from "@/lib/quality-check-rules";

export default function RegistryOwnerPendingNote({ count, canOpen }: { count: number; canOpen: boolean }) {
  return (
    <div
      role="note"
      className="mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        謄本の名義 比べ直し待ち <strong>{count.toLocaleString()}</strong> 件
        <span className="ml-2 text-xs">
          （まだ比べていない物件・所有者や謄本が変わった物件。毎晩自動で少しずつ比べます）
        </span>
        {canOpen ? (
          <Link href={REGISTRY_OWNER_REVIEW_HREF} className="ml-2 text-xs text-indigo-600 hover:underline">
            謄本の名義の確認を開く
          </Link>
        ) : null}
      </p>
    </div>
  );
}
