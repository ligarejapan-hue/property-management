"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fetchSaleDmLpAssets, deleteSaleDmLpAsset, LP_ASSET_URL, type SaleDmLpAsset } from "@/lib/api-client";

/** LP用写真ライブラリの管理(管理者)。追加は売却DMの各LP型の「写真と図」から。ここは一覧と削除だけ。 */
export default function AdminLpAssetsPage() {
  const [assets, setAssets] = useState<SaleDmLpAsset[] | null>(null);
  const [target, setTarget] = useState<SaleDmLpAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { setAssets((await fetchSaleDmLpAssets()).assets); }
    catch (e) { setError(e instanceof Error ? e.message : "読み込みに失敗しました"); }
  };
  useEffect(() => { void load(); }, []);

  const remove = async () => {
    if (!target || busy) return;
    setBusy(true); setError(null);
    try { await deleteSaleDmLpAsset(target.id); setTarget(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "削除に失敗しました"); setTarget(null); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="LPの写真" description="売却DMのご案内ページ(LP)で使う写真の一覧です。追加は各キャンペーンのLP型「写真と図」から行います。LP型で使われている写真は削除できません。" />
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {assets === null ? (
        error ? null : <p className="text-sm text-gray-500"><Loader2 className="inline h-4 w-4 animate-spin" /> 読み込み中</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-gray-500">写真はまだありません。</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <li key={a.id} className="overflow-hidden rounded-md border border-gray-200 bg-white">
              {a.referenced ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={LP_ASSET_URL(a.publicId)} alt={a.label ?? "写真"} width={a.width} height={a.height} className="aspect-video w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center bg-gray-100 text-xs text-gray-500">未使用(LP型に付けると見本が出ます)</div>
              )}
              <div className="flex items-center justify-between px-2 py-1.5 text-xs">
                <span className="truncate text-gray-700">{a.label ?? "(ラベルなし)"} · {a.width}×{a.height} · {Math.round(a.bytes / 1024)}KB</span>
                <button type="button" onClick={() => setTarget(a)} disabled={a.referenced} title={a.referenced ? "LP型で使われています" : "削除"} className="text-red-600 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {target && <ConfirmDialog title="写真を削除しますか？" message="ライブラリから消えます。LP型で使われている写真は削除できません。" busy={busy} onCancel={() => setTarget(null)} onConfirm={() => void remove()} />}
    </div>
  );
}
