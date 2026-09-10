"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Loader2, Upload, ImagePlus } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { uploadSaleDmLpAsset, LP_ASSET_URL, type SaleDmLpAsset } from "@/lib/api-client";
import { prepareLpAssetForUpload } from "@/lib/lp-asset-prepare";

/**
 * LP用の写真ライブラリ(全キャンペーン共通・設計 §2.3)。
 *  選ぶ: 一覧から1枚。追加: ファイル選択 / ドロップ / Ctrl+V 貼り付け(画像をコピーしてこの窓で貼る)。
 *  見本: どこかのLP型に付いて保存された写真だけ画像が出る(公開口は参照中しか返さない)。
 *  それまでは文字カード(寸法とラベル)。
 */
export default function LpAssetLibrary({ open, onClose, onPick, assets, onAssetsChanged }: {
  open: boolean; onClose: () => void; onPick: (asset: SaleDmLpAsset) => void; assets: SaleDmLpAsset[]; onAssetsChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    if (busy) return;
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) { setError("画像ファイルを選んでください"); return; }
    setBusy(true);
    setError(null);
    let uploaded = 0;
    try {
      for (const f of images.slice(0, 5)) {
        const prepared = await prepareLpAssetForUpload(f);
        if (!prepared.ok) { setError(prepared.message); continue; }
        await uploadSaleDmLpAsset(prepared.blob, prepared.fileName, label.trim() || undefined);
        uploaded += 1;
      }
      setLabel("");
    } catch (e) {
      const message = e instanceof Error ? e.message : "写真を追加できませんでした";
      setError(uploaded > 0 ? `${uploaded}枚は登録できました。残りの追加に失敗しました: ${message}` : message);
    } finally {
      setBusy(false);
      if (uploaded > 0) onAssetsChanged();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  };

  if (!open) return null;
  return (
    <ModalShell
      title="LPの写真"
      onClose={onClose}
      size="lg"
      footer={<Button type="button" variant="secondary" onClick={onClose}>閉じる</Button>}
    >
      <div tabIndex={0} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} className="space-y-3 outline-none">
        <div className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-xs text-gray-600">
          <p>写真をここに<strong>貼り付け(Ctrl+V)</strong>するか、ドラッグして置くか、「ファイルを選ぶ」で追加します。JPEG / PNG / WebP / HEIC。写真はどの形式でも端末側でJPEGに変換して登録します(長辺1600pxに縮小・透過は白・撮影情報は残しません)。</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="ラベル(任意・例: 会社の外観)" className="rounded border border-gray-300 px-2 py-1 text-xs" />
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} ファイルを選ぶ
            </Button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          </div>
          {error && <p className="mt-2 text-red-600">{error}</p>}
        </div>
        {assets.length === 0 ? (
          <p className="text-xs text-gray-500">まだ写真がありません。</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {assets.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => onPick(a)} className="block w-full overflow-hidden rounded-md border border-gray-200 text-left hover:border-indigo-400">
                  {a.referenced ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={LP_ASSET_URL(a.publicId)} alt={a.label ?? "写真"} width={a.width} height={a.height} className="aspect-video w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex aspect-video w-full flex-col items-center justify-center bg-gray-100 text-gray-500"><ImagePlus className="h-5 w-5" /><span className="mt-1 text-[10px]">LP型に付けて保存すると見本が出ます</span></div>
                  )}
                  <div className="truncate px-2 py-1 text-[11px] text-gray-700">{a.label ?? "(ラベルなし)"} · {a.width}×{a.height}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ModalShell>
  );
}
