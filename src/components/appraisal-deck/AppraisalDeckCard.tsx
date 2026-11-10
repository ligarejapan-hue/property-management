"use client";

/**
 * 物件ページの「お客様向け資料（査定のご報告）」カード(2026-11-10)。
 * - 査定報告書を開ける権限が無い人(一覧 API が 403)・資料が1件も無い物件では出さない。
 * - 確認待ち → 「確認する」/ 確認済み → 「資料を見る」「ダウンロード」「直す」。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckSquare, Download, Eye } from "lucide-react";
import StatusBadge from "@/components/ui/status-badge";

export interface AppraisalDeckSummary {
  id: string;
  status: string;
  kind: string | null;
  appraisedOn: string | null;
  warningCount: number;
  confirmedAt: string | null;
}

const KIND: Record<string, string> = { house: "戸建", mansion: "マンション", land: "土地" };

export function appraisalDeckReviewHref(propertyId: string, deckId: string): string {
  return `/properties/${propertyId}/appraisal-decks/${deckId}`;
}
export function appraisalDeckViewUrl(propertyId: string, deckId: string, download = false): string {
  return `/api/properties/${propertyId}/appraisal-decks/${deckId}/view${download ? "?download=1" : ""}`;
}

export function formatAppraisedOn(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日の査定` : "査定日の記載なし";
}

const btn =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500";
const btnPrimary = `${btn} bg-indigo-600 text-white hover:bg-indigo-700`;
const btnSecondary = `${btn} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700`;

export function AppraisalDeckCardView({ propertyId, decks }: { propertyId: string; decks: AppraisalDeckSummary[] }) {
  if (decks.length === 0) return null;
  return (
    <div className="mb-4 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        お客様向け資料（査定のご報告）
        <span className="text-xs font-normal text-gray-400 dark:text-gray-500">査定報告書を添付すると自動で下書きができます</span>
      </h3>
      <ul>
        {decks.map((d) => {
          const confirmed = d.status === "confirmed";
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-2 border-t border-gray-100 py-2 first:border-t-0 dark:border-gray-700">
              <div className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-100">
                <span className="font-semibold">{formatAppraisedOn(d.appraisedOn)}</span>
                {d.kind && KIND[d.kind] ? (
                  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{KIND[d.kind]}</span>
                ) : null}
              </div>
              {confirmed ? (
                <StatusBadge intent="success">確認済み</StatusBadge>
              ) : (
                <StatusBadge intent="warning">確認待ち</StatusBadge>
              )}
              {!confirmed && d.warningCount > 0 ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">注意 {d.warningCount}件</span>
              ) : null}
              {confirmed ? (
                <>
                  <a href={appraisalDeckViewUrl(propertyId, d.id)} target="_blank" rel="noopener" className={btnSecondary}>
                    <Eye className="h-4 w-4" aria-hidden />
                    資料を見る
                  </a>
                  <a href={appraisalDeckViewUrl(propertyId, d.id, true)} className={btnSecondary}>
                    <Download className="h-4 w-4" aria-hidden />
                    ダウンロード
                  </a>
                  <Link
                    href={appraisalDeckReviewHref(propertyId, d.id)}
                    className="text-sm font-semibold text-indigo-700 hover:underline dark:text-indigo-300"
                  >
                    直す
                  </Link>
                </>
              ) : (
                <Link href={appraisalDeckReviewHref(propertyId, d.id)} className={btnPrimary}>
                  <CheckSquare className="h-4 w-4" aria-hidden />
                  確認する
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 一覧を取って出す。403(権限なし)・失敗・0件なら何も出さない。 */
export function AppraisalDeckCard({ propertyId }: { propertyId: string }) {
  const [decks, setDecks] = useState<AppraisalDeckSummary[]>([]);
  useEffect(() => {
    let active = true;
    fetch(`/api/properties/${propertyId}/appraisal-decks`)
      .then((r) => (r.ok ? r.json() : { decks: [] }))
      .then((data: { decks?: unknown }) => {
        if (active) setDecks(Array.isArray(data?.decks) ? (data.decks as AppraisalDeckSummary[]) : []);
      })
      .catch(() => {
        if (active) setDecks([]);
      });
    return () => {
      active = false;
    };
  }, [propertyId]);
  return <AppraisalDeckCardView propertyId={propertyId} decks={decks} />;
}
