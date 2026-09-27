"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Image as ImageIcon, Eye } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import ScenarioTextEditor from "@/components/sale-dm/scenario-text-editor";
import LpMediaPanel from "@/components/sale-dm/lp-media-panel";
import LpPreviewPanel from "@/components/sale-dm/lp-preview-panel";
import {
  fetchSaleDmScenario,
  updateSaleDmScenario,
  scenarioLpMediaApi,
  SCENARIO_PREVIEW_URL,
  type SaleDmScenario,
} from "@/lib/api-client";

/**
 * DMの種類(台帳)1件の編集(管理者・設計 2026-09-27 §3.6)。
 * 名前・並び順と、手紙/LPの文面づくり。LPの文章が登録済みなら「写真と図」「プレビュー」も使える
 * (発送の画面と同じ部品。呼び先だけ台帳のものを渡す)。
 */
export default function AdminDmScenarioDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [scenario, setScenario] = useState<SaleDmScenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<"media" | "preview" | null>(null);
  // 「写真と図」の呼び先。⚠useMemo で固定する(部品は api が変わるたびに読み直す)。
  const mediaApi = useMemo(() => scenarioLpMediaApi(id), [id]);

  const load = useCallback(async () => {
    try {
      const s = await fetchSaleDmScenario(id);
      setScenario(s);
      setName(s.name);
      setSortOrder(String(s.sortOrder));
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  // 文面を保存・設定を変えたときは、名前欄の入力を残したまま中身だけ読み直す。
  const reloadContent = async () => {
    try {
      const s = await fetchSaleDmScenario(id);
      setScenario(s);
      // LPの文章が消えた(設定を変えた)ら、写真と図・プレビューは閉じる。
      if (!s.lpBodyText) setPanel(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    }
  };

  const saveBasics = async () => {
    if (!scenario || busy) return;
    const n = Number(sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      setError("並び順は 0〜9999 の整数で入れてください");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await updateSaleDmScenario(scenario.id, { name: name.trim(), sortOrder: n });
      setNotice(r.changedFields.length > 0 ? "保存しました" : "変更はありません");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (!scenario) {
    return (
      <div>
        <PageHeader title="DMの種類" back={{ href: "/admin/dm-scenarios", to: "DMの種類" }} />
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : <p className="text-sm text-gray-500"><Loader2 className="inline h-4 w-4 animate-spin" /> 読み込み中</p>}
      </div>
    );
  }

  const basicsDirty = name.trim() !== scenario.name || sortOrder !== String(scenario.sortOrder);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`DMの種類「${scenario.name}」`}
        description={scenario.autoKey ? "この種類は、導入ルートから自動で選ばれます(削除はできません。止めるときは一覧で「使わない」にしてください)。" : undefined}
        back={{ href: "/admin/dm-scenarios", to: "DMの種類" }}
      />
      {!scenario.active && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">この種類は「使わない」になっています。物件や発送では選べません。</p>}

      <section className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
            名前
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="w-56 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
            並び順(小さいほど上)
            <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          </label>
          <Button size="sm" onClick={() => void saveBasics()} disabled={busy || !basicsDirty || name.trim() === ""}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}保存
          </Button>
        </div>
        {notice && <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">{notice}</p>}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>

      <ScenarioTextEditor scenario={scenario} kind="letter" onChanged={() => void reloadContent()} />
      <ScenarioTextEditor scenario={scenario} kind="lp" onChanged={() => void reloadContent()} />

      {scenario.lpBodyText && (
        <section className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">LPの写真と図・プレビュー</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPanel(panel === "media" ? null : "media")} aria-pressed={panel === "media"}>
              <ImageIcon className="h-3.5 w-3.5" />写真と図
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPanel("preview")}>
              <Eye className="h-3.5 w-3.5" />プレビュー
            </Button>
          </div>
          {panel === "media" && <LpMediaPanel api={mediaApi} label={scenario.name} onClose={() => setPanel(null)} />}
          {panel === "preview" && <LpPreviewPanel previewUrl={(d) => SCENARIO_PREVIEW_URL(id, d)} label={scenario.name} onClose={() => setPanel(null)} />}
        </section>
      )}
    </div>
  );
}
