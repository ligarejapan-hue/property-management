"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const FIELDS: { key: string; label: string }[] = [
  { key: "price", label: "価格" },
  { key: "access", label: "交通" },
  { key: "landArea", label: "土地面積" },
  { key: "landCategory", label: "地目" },
  { key: "transactionType", label: "取引態様" },
  { key: "deliveryTiming", label: "引渡" },
  { key: "remarks", label: "備考（公開）" },
];

/**
 * 新規デザイン作成 API へのリクエスト内容を組み立てる純関数。
 * コンポーネントから独立させることでテスト可能にする。
 */
export function buildCreateRequest(
  propertyId: string,
  values: Record<string, string>,
): { url: string; init: RequestInit } {
  return {
    url: `/api/properties/${propertyId}/sales-sheets/new`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    },
  };
}

export function SaleLandSheetButton({
  propertyId,
  canWrite,
}: {
  propertyId: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { url, init } = buildCreateRequest(propertyId, values);
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? "販売図面の作成に失敗しました");
        return;
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/properties/${propertyId}/sales-sheets/${id}/edit`);
    } catch {
      setError("販売図面の作成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  // /sales-sheets/new は property:write を要求するため、read-only ユーザーには作成導線を出さない
  // （表示してもクリックで 403 dead-end になる）。route 側の property:write チェックは別途維持。
  if (!canWrite) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-indigo-300 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900/20"
      >
        販売図面を作成（売土地）
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[420px] rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-800">
            <h2 className="mb-3 text-base font-bold text-gray-900 dark:text-gray-100">
              販売図面（売土地）の作成
            </h2>
            <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
              システムに無い項目を入力してください（空欄可）。作成後、配置や文字はエディタで調整できます。
            </p>
            <div className="space-y-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <label
                    htmlFor={`ss-${f.key}`}
                    className="w-20 text-sm text-gray-700 dark:text-gray-300"
                  >
                    {f.label}
                  </label>
                  <input
                    id={`ss-${f.key}`}
                    aria-label={f.label}
                    className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
                    value={values[f.key] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-neutral-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={create}
                disabled={busy}
                className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy ? "作成中…" : "作成してエディタを開く"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
