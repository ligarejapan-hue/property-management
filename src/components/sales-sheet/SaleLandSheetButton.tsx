"use client";

import { useState } from "react";

const FIELDS: { key: string; label: string }[] = [
  { key: "price", label: "価格" },
  { key: "access", label: "交通" },
  { key: "landArea", label: "土地面積" },
  { key: "landCategory", label: "地目" },
  { key: "transactionType", label: "取引態様" },
  { key: "deliveryTiming", label: "引渡" },
];

export function SaleLandSheetButton({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/properties/${propertyId}/sales-sheet/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        setError("PDFの作成に失敗しました");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "販売図面.pdf";
      a.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

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
              システムに無い項目を入力してください（空欄可）。
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
                className="rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-neutral-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={generate}
                disabled={busy}
                className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy ? "作成中…" : "PDFを作成"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
