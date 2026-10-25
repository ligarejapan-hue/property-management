"use client";

/**
 * 物件の添付タブの「書類を撮る」ボタン。スマホ・タブレットで開いたときだけ出す(発注者指示 2026-10-25)。
 * 押すと全画面の撮影画面(DocScanDialog)を開く。撮影画面の部品(OpenCV.js)は押したときに読み込む。
 */
import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadFile, uploadScannedDocument, type ScanUploadResult } from "@/lib/api-client";
import DocScanDialog, { type ScannedPage } from "./doc-scan-dialog";
import { useTouchDevice } from "./use-touch-device";

interface DocScanLauncherProps {
  propertyId: string;
  /** PDF にして添付に入れた。originals は「写真タブへ移す」に使う元の写真。 */
  onSaved: (result: ScanUploadResult, originals: readonly Blob[]) => Promise<void> | void;
  /** 書類ではなかった=写真タブへ入れた枚数。 */
  onPhotosSaved: (count: number) => void;
}

/** 元の写真を写真タブへ1枚ずつ入れる(写真タブの口は1件ずつ受ける)。 */
export async function uploadOriginalsAsPhotos(
  propertyId: string,
  originals: readonly Blob[],
  /** 名前の番号の始まり(途中から入れ直すとき)。 */
  offset = 0,
): Promise<void> {
  for (const [i, blob] of originals.entries()) {
    await uploadFile(propertyId, new File([blob], `撮影_${offset + i + 1}.jpg`, { type: "image/jpeg" }), "photo");
  }
}

export default function DocScanLauncher({ propertyId, onSaved, onPhotosSaved }: DocScanLauncherProps) {
  const touch = useTouchDevice();
  const [open, setOpen] = useState(false);
  // 写真タブへ入れ終わった撮影(押し直しで二重に入れないため)。
  const photoDone = useRef(new Set<string>());
  if (!touch) return null;

  const savePdf = async (pages: readonly ScannedPage[]) => {
    const result = await uploadScannedDocument(
      propertyId,
      pages.map((p) => p.scanned),
    );
    await onSaved(
      result,
      pages.map((p) => p.original),
    );
  };

  const savePhotos = async (pages: readonly ScannedPage[]) => {
    // ⚠途中で失敗して押し直したとき、入れ終わった写真を二重に入れない。
    for (const [i, page] of pages.entries()) {
      if (photoDone.current.has(page.id)) continue;
      await uploadOriginalsAsPhotos(propertyId, [page.original], i);
      photoDone.current.add(page.id);
    }
    photoDone.current.clear();
    onPhotosSaved(pages.length);
  };

  return (
    <div className="mb-3 flex flex-col gap-2">
      <Button type="button" size="lg" onClick={() => setOpen(true)} className="h-14 w-full gap-2 text-base font-bold">
        <Camera className="h-6 w-6" aria-hidden="true" />
        書類を撮る
      </Button>
      <span className="text-xs leading-relaxed text-gray-600 dark:text-gray-300">
        何枚でも続けて撮れます。紙の四隅を自動で見つけて形を直し、1つのPDFにしてこの物件の添付に入れます。種類(売買契約書など)は文字を読んで自動で判別します。
      </span>
      {open && <DocScanDialog onClose={() => setOpen(false)} onSavePdf={savePdf} onSavePhotos={savePhotos} />}
    </div>
  );
}
