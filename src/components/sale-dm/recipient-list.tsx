"use client";

import { useState } from "react";
import type { SaleDmCampaign } from "@/lib/api-client";
import { updateSaleDmOutcome } from "@/lib/api-client";
import { variantLabel, isInquiry, buildOutcomePayload } from "@/lib/sale-dm-letter/recipient-actions";

const DELIVERY_OPTIONS = [
  { value: "unknown", label: "未確認" },
  { value: "delivered", label: "届いた" },
  { value: "returned_undeliverable", label: "宛先不明で返送" },
  { value: "returned_other", label: "その他返送" },
];

export default function SaleDmRecipientList({
  campaign,
  selectedId,
  onSelect,
  onChanged,
}: {
  campaign: SaleDmCampaign;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patchOutcome = async (id: string, input: { deliveryStatus?: string; phoneInquiry?: boolean }) => {
    setBusyId(id);
    setError(null);
    try {
      await updateSaleDmOutcome(id, buildOutcomePayload(input));
      onChanged();
    } catch (e) {
      // 失敗を握り潰さず表示する(他の sale-dm 画面と同方針)。コントロールは onChanged 不発で旧値に戻るため、
      // 記録できたか分からない無言失敗を避ける。
      setError(e instanceof Error ? e.message : "配達結果の更新に失敗しました");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-700">宛先リスト</h3>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <ul className="divide-y divide-gray-100">
        {campaign.recipients.map((r) => {
          const inquiry = isInquiry(r);
          const isSent = r.status === "sent";
          return (
            <li
              key={r.id}
              className={`cursor-pointer rounded-md p-2 ${r.id === selectedId ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"}`}
              onClick={() => onSelect(r.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span data-pii-protected data-pii-surface="owner" className="flex-1 truncate text-sm text-gray-800">
                  {r.recipientName} {r.honorific}
                </span>
                <span className="shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700">
                  型 {variantLabel(campaign.variants, r.variantId)}
                </span>
                {/* 型変更/均等割り当てで本文がクリアされた下書きは「要再生成」= 確定/印刷/送付の対象外。
                    一括クリア後に半分空の A/B バッチを完了と誤認しないよう、各宛先で明示する。 */}
                {r.status === "draft" && r.body === "" && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                    要再生成
                  </span>
                )}
                {inquiry && (
                  <span className="shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                    反響あり
                  </span>
                )}
              </div>

              {/* 配達結果/反響は確定(sent)後のみ入力可 */}
              {isSent && (
                <div className="mt-1 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={r.deliveryStatus}
                    disabled={busyId === r.id}
                    onChange={(e) => patchOutcome(r.id, { deliveryStatus: e.target.value })}
                    className="rounded-md border border-gray-300 px-1.5 py-1 text-xs"
                  >
                    {DELIVERY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={Boolean(r.phoneInquiryAt)}
                      disabled={busyId === r.id}
                      onChange={(e) => patchOutcome(r.id, { phoneInquiry: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    電話問い合わせ
                  </label>
                </div>
              )}
            </li>
          );
        })}
        {campaign.recipients.length === 0 && (
          <li className="py-6 text-center text-sm text-gray-500">宛先がありません</li>
        )}
      </ul>
    </div>
  );
}
