"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import { createProperty } from "@/lib/api-client";

interface Props {
  onClose: () => void;
}

export default function NewPropertyModal({ onClose }: Props) {
  const router = useRouter();

  const [propertyType, setPropertyType] = useState("");
  const [address, setAddress] = useState("");
  const [lotNumber, setLotNumber] = useState("");
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
        address: address.trim(),
        lotNumber: lotNumber.trim() || null,
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
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-800">新規物件登録</h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
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
            <label className="mb-1 block text-sm font-medium text-gray-700">
              物件種別 <span className="text-red-500">*</span>
            </label>
            <select
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
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

          {/* 住所 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              住所 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={submitting}
              placeholder="例: 東京都千代田区丸の内1-1-1"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
            />
          </div>

          {/* 地番 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              地番 <span className="text-xs text-gray-400">任意</span>
            </label>
            <input
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 1番1"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
            />
          </div>

          {/* メモ */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              メモ <span className="text-xs text-gray-400">任意</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="登録メモがあれば入力してください"
              className="w-full resize-y rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
            />
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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
