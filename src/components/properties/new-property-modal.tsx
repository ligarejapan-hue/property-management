"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { PROPERTY_TYPE_OPTIONS, INTRODUCTION_ROUTE_OPTIONS } from "@/lib/property-types";
import { createProperty } from "@/lib/api-client";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";

interface Props {
  onClose: () => void;
}

export default function NewPropertyModal({ onClose }: Props) {
  const router = useRouter();

  const [propertyType, setPropertyType] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [address, setAddress] = useState("");
  // 住所補完の user-edit signal（Codex P2-G）。住所 input をユーザーが直接編集した時だけ true。
  const [addressEdited, setAddressEdited] = useState(false);
  const [lotNumber, setLotNumber] = useState("");
  const [introductionRoute, setIntroductionRoute] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!propertyType) {
      setError("物件種別を選択してください");
      return;
    }
    if (!address.trim()) {
      setError("住所を入力してください");
      return;
    }

    setSubmitting(true);
    try {
      const result = await createProperty({
        propertyType,
        postalCode: postalCode.trim() || null,
        address: address.trim(),
        lotNumber: lotNumber.trim() || null,
        introductionRoute: introductionRoute || null,
        note: note.trim() || null,
      });
      router.push(`/properties/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[90vw] sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">新規物件登録</h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* 物件種別 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              物件種別 <span className="text-red-500">*</span>
            </label>
            <select
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            >
              <option value="">選択してください</option>
              {PROPERTY_TYPE_OPTIONS.filter(
                (o) => !["building", "unit"].includes(o.value),
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* 郵便番号 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              郵便番号 <span className="text-xs text-gray-400 dark:text-gray-500">任意</span>
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              disabled={submitting}
              placeholder="例: 1000005"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
          </div>

          {/* 住所 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              住所 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => {
                // ユーザーの直接編集＝user-edit signal（住所検索のトリガー）。
                setAddressEdited(true);
                setAddress(e.target.value);
              }}
              disabled={submitting}
              placeholder="例: 東京都千代田区丸の内1-1-1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
            {/* 郵便番号⇄住所 補完。onZipChange/onAddressChange は state 更新のみ＝
                addressEdited は立てない（候補 apply で再検索しない）。 */}
            <div className="mt-1.5">
              <AddressLookupControls
                zip={postalCode}
                address={address}
                onZipChange={setPostalCode}
                onAddressChange={setAddress}
                addressEdited={addressEdited}
                disabled={submitting}
                mode="both"
              />
            </div>
          </div>

          {/* 地番 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              地番 <span className="text-xs text-gray-400 dark:text-gray-500">任意</span>
            </label>
            <input
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 1番1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
          </div>

          {/* 導入ルート */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              導入ルート <span className="text-xs text-gray-400 dark:text-gray-500">任意</span>
            </label>
            <select
              value={introductionRoute}
              onChange={(e) => setIntroductionRoute(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            >
              <option value="">未設定</option>
              {INTRODUCTION_ROUTE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* メモ */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              メモ <span className="text-xs text-gray-400 dark:text-gray-500">任意</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="登録メモがあれば入力してください"
              className="w-full resize-y rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-100 dark:border-gray-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              登録する
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
