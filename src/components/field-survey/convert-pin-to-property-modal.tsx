"use client";

import { useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import { convertPinToProperty } from "@/lib/api-client";
import { normalizeRealEstateNumber } from "@/lib/address-normalizer";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";

interface Props {
  pinId: string;
  onClose: () => void;
  onConverted: (propertyId: string) => void;
}

/**
 * 「物件化候補」ピンを物件にする modal。
 * - 位置(GPS)は入力せず、サーバーがピンから継承する。
 * - 種別/住所(+補完)/地番/家屋番号を収集し、所在検索に必要な項目を満たす。
 */
export default function ConvertPinToPropertyModal({ pinId, onClose, onConverted }: Props) {
  const [propertyType, setPropertyType] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [address, setAddress] = useState("");
  const [addressEdited, setAddressEdited] = useState(false);
  const [lotNumber, setLotNumber] = useState("");
  const [buildingNumber, setBuildingNumber] = useState("");
  // 不動産番号が既に分かっている場合の近道 (13桁)。あれば通常の謄本自動取得が
  // 所在検索より確実に使える。API/validator は元々受け付けており入力欄のみ追加。
  const [realEstateNumber, setRealEstateNumber] = useState("");
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
    // 不動産番号は正規化して保存する (全角数字・区切り付きの生値のまま保存すると
    // CSV 取込の重複判定 [完全一致] をすり抜けて二重登録になり得る。Codex P2)。
    // 数字にならない入力は正規化で黙って捨てず、その場でエラーにする
    // (validator と同じ判定基準: 許容文字種 + 正規化後 1〜13 桁)。
    const rawRen = realEstateNumber.trim();
    const normalizedRen = normalizeRealEstateNumber(rawRen);
    if (
      rawRen !== "" &&
      !(
        /^[0-9０-９\s　\-‐-―ー－−]+$/.test(rawRen) &&
        /^\d{1,13}$/.test(normalizedRen)
      )
    ) {
      setError("不動産番号は数字(最大13桁)で入力してください");
      return;
    }
    setSubmitting(true);
    try {
      const result = await convertPinToProperty(pinId, {
        propertyType,
        postalCode: postalCode.trim() || null,
        address: address.trim(),
        lotNumber: lotNumber.trim() || null,
        buildingNumber: buildingNumber.trim() || null,
        realEstateNumber: rawRen === "" ? null : normalizedRen,
      });
      onConverted(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "物件化に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[90vw] sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">この場所を物件にする</h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">位置(GPS)はこの調査ピンから自動で引き継ぎます。</p>

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
              {PROPERTY_TYPE_OPTIONS.filter((o) => !["building", "unit"].includes(o.value)).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              住所 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => {
                setAddressEdited(true);
                setAddress(e.target.value);
              }}
              disabled={submitting}
              placeholder="例: 東京都千代田区丸の内1-1-1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
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

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              家屋番号 <span className="text-xs text-gray-400 dark:text-gray-500">任意(建物)</span>
            </label>
            <input
              type="text"
              value={buildingNumber}
              onChange={(e) => setBuildingNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 1番1の1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              不動産番号 <span className="text-xs text-gray-400 dark:text-gray-500">任意(13桁・分かる場合)</span>
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={realEstateNumber}
              onChange={(e) => setRealEstateNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 0123456789012"
              data-testid="convert-real-estate-number"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              入力しておくと、謄本の自動取得をすぐに使えます。
            </p>
          </div>

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
              物件にする
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
