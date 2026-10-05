"use client";

import { useState } from "react";
import { Loader2, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import LpAssetLibrary from "@/components/sale-dm/lp-asset-library";
import { fetchSaleDmLpAssets, saveSaleDmScenarioLetterIllustration, type SaleDmLpAsset } from "@/lib/api-client";

/**
 * 台帳の「手紙のイラスト」(設計 2026-10-05 §5)。LPの写真と同じライブラリから1枚選ぶ/外す。
 * 手紙に入った姿は、キャンペーン画面の手紙の見本で確かめる(この画面に手紙の見本は無い)。
 */
export default function LetterIllustrationPanel({ scenarioId, illustration, onChanged }: {
  scenarioId: string;
  illustration: { src: string; width: number; height: number } | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<SaleDmLpAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 成否を返す。⚠失敗したまま選択の窓を開くと、空の一覧が「写真が無い」と見え、赤字も窓の裏に隠れる。
  const loadAssets = async (): Promise<boolean> => {
    try {
      setAssets((await fetchSaleDmLpAssets()).assets);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "写真の一覧を読み込めませんでした");
      // 窓を開いたまま(写真を追加した後の読み直し)なら閉じて、赤字を見えるようにする。
      setOpen(false);
      return false;
    }
  };
  const openLibrary = async () => {
    setError(null);
    if (!(await loadAssets())) return;
    setOpen(true);
  };
  const save = async (assetId: string | null) => {
    if (busy) return;
    // 先に選択の窓を閉じる(失敗したときの赤字が窓の裏に隠れないように)。
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await saveSaleDmScenarioLetterIllustration(scenarioId, assetId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">手紙のイラスト</h2>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        手紙の本文の【イラスト】の行に入ります(無ければ本文の上)。横長(約3:1)がおすすめです。手紙に入った姿は、発送の画面の手紙の見本で確かめられます。
      </p>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        {illustration ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={illustration.src} alt="" width={illustration.width} height={illustration.height} className="h-auto max-h-32 w-64 rounded border border-gray-200 object-contain dark:border-gray-700" />
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">まだ登録されていません(登録するまで、手紙は今までの見た目で刷られます)。</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void openLibrary()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}イラストを選ぶ…
          </Button>
          {illustration && (
            <Button variant="secondary" size="sm" onClick={() => void save(null)} disabled={busy}>
              <X className="h-3.5 w-3.5" />外す
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <LpAssetLibrary
        open={open}
        onClose={() => setOpen(false)}
        onPick={(a) => void save(a.id)}
        assets={assets}
        onAssetsChanged={() => void loadAssets()}
      />
    </section>
  );
}
