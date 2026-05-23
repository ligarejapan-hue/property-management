"use client";

// 法人番号 lookup preview パネル（Phase B）。
//
// 仕様:
// - 「法人情報を検索」ボタン押下で POST /api/owners/[id]/corporate-lookup を叩く
// - 13桁正規化できない / lookup capability 無効時はボタン disabled
// - 検索中: ボタンを「検索中...」表示
// - 結果は preview のみで、Owner.name / Owner.address への書き込みは行わない
// - 廃止法人は警告バッジ
// - Phase C で apply（反映実行）するため、反映ボタンは disabled の placeholder で表示
//
// raw XML / API レスポンス本文を画面外に持ち出すことはしない。
// 検索結果は React state のみで保持し、自動保存・自動 lookup はしない。

import { useState } from "react";
import { AlertTriangle, Search, Loader2 } from "lucide-react";
import { lookupOwnerCorporateNumber, type CorporateLookupApiResponse } from "@/lib/api-client";
import { normalizeCorporateNumber } from "@/lib/corporate-number";

interface CorporateLookupPanelProps {
  ownerId: string;
  /** 入力中の法人番号（form.corporateNumber）。正規化前でよい。 */
  rawCorporateNumber: string;
  /** lookup capability（env 未設定なら false）。UI 上は判定不能なので props で渡す。
   *  未指定時は true 扱い（=server-side で 503 が返ったらエラー表示）。 */
  configured?: boolean;
  /** 編集権限がない場合は描画自体しない（呼び出し側で制御） */
  disabledReason?: string | null;
}

export default function CorporateLookupPanel({
  ownerId,
  rawCorporateNumber,
  configured = true,
  disabledReason = null,
}: CorporateLookupPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CorporateLookupApiResponse["lookup"] | null>(null);
  // この result / error が「どの 13桁正規化値」に対するものか。
  // 現在の入力値と一致しなくなったら preview / error を出さない（古い検索結果が
  // 別の入力値に対して表示されないことを保証）。
  const [searchedFor, setSearchedFor] = useState<string | null>(null);

  const normalized = normalizeCorporateNumber(rawCorporateNumber);
  const canSearch = !!normalized && !loading && configured && !disabledReason;

  // 検索結果と現在の入力が一致している場合のみ表示する。
  // 入力が変わった瞬間に「古い preview / 古いエラー」を隠す。
  // setState を useEffect で呼ぶより安全（無限ループ・stale state 防止）。
  const showResult = result !== null && searchedFor !== null && searchedFor === normalized;
  const showError = error !== null && searchedFor !== null && searchedFor === normalized;

  const handleSearch = async () => {
    if (!normalized) {
      setError("法人番号は13桁の数字で入力してください");
      setSearchedFor(normalized);
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    // 開始時点で「この検索はどの番号に紐づくか」を確定させる。
    const searchTarget = normalized;
    setSearchedFor(searchTarget);
    try {
      const res = await lookupOwnerCorporateNumber(ownerId, searchTarget);
      setResult(res.lookup);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "検索に失敗しました";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSearch}
          disabled={!canSearch}
          aria-label="法人情報を検索"
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400"
        >
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              検索中...
            </>
          ) : (
            <>
              <Search className="h-3 w-3" />
              法人情報を検索
            </>
          )}
        </button>
        {!configured && (
          <span className="text-xs text-gray-500">
            法人番号API未設定（管理者に env 設定を依頼してください）
          </span>
        )}
        {disabledReason && (
          <span className="text-xs text-gray-500">{disabledReason}</span>
        )}
      </div>

      {showError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {showResult && result && !result.found && (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          該当する法人が見つかりませんでした（法人番号: {searchedFor}）
        </div>
      )}

      {showResult && result && result.found && result.record && (
        <div
          data-testid="corporate-lookup-preview"
          className="space-y-2 rounded-md border border-blue-200 bg-blue-50/40 px-3 py-3 text-xs text-gray-800"
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-700">国税庁データ</span>
            {result.isClosed && (
              <span className="rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                廃止法人
              </span>
            )}
            <span className="ml-auto text-[10px] text-gray-500">
              取得: {result.fetchedAt.slice(0, 10)} / {result.source}
            </span>
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2">
            <PreviewField label="法人番号" value={result.record.corporateNumber} mono />
            <PreviewField label="更新年月日" value={result.record.updateDate} mono />
            <div className="md:col-span-2">
              <PreviewField label="会社名" value={result.record.name} />
            </div>
            {result.record.furigana && (
              <div className="md:col-span-2">
                <PreviewField label="フリガナ" value={result.record.furigana} />
              </div>
            )}
            {result.record.postCode && (
              <PreviewField label="郵便番号" value={result.record.postCode} mono />
            )}
            <div className="md:col-span-2">
              <PreviewField label="所在地" value={result.record.address} />
            </div>
            {result.isClosed && result.closeDate && (
              <PreviewField label="廃止年月日" value={result.closeDate} mono />
            )}
          </dl>
          {/* Phase C の反映ボタン。Phase B では DB 書込導線を持たない（disabled）。 */}
          <div className="border-t border-blue-100 pt-2">
            <button
              type="button"
              disabled
              title="所有者名・現住所への反映は次フェーズ (Phase C) で実装予定です"
              className="cursor-not-allowed rounded-md border border-gray-200 bg-gray-100 px-2.5 py-1 text-[11px] text-gray-400"
            >
              所有者名・現住所に反映（Phase C で実装予定）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={mono ? "font-mono text-gray-900" : "text-gray-900"}>{value ?? "-"}</dd>
    </div>
  );
}
