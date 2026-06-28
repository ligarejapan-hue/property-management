"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SaleLandSheetButton({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/properties/${propertyId}/sales-sheets/new`, {
        method: "POST",
      });
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

  return (
    <div>
      <button
        type="button"
        onClick={handleCreate}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-md border border-indigo-300 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900/20 disabled:opacity-50"
      >
        {busy ? "作成中…" : "販売図面を作成"}
      </button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
