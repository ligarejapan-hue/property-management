"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Image as ImageIcon, Eye } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import ScenarioTextEditor from "@/components/sale-dm/scenario-text-editor";
import LpMediaPanel from "@/components/sale-dm/lp-media-panel";
import LpPreviewPanel from "@/components/sale-dm/lp-preview-panel";
import LetterIllustrationPanel from "@/components/sale-dm/letter-illustration-panel";
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
  // 広告用の公開ページの公開名(/lp/<公開名>・設計 2026-10-20)。空=公開しない。
  const [publicSlug, setPublicSlug] = useState("");
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
      setPublicSlug(s.publicSlug ?? "");
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
    const slug = publicSlug.trim().toLowerCase();
    if (slug !== "" && !/^[a-z0-9-]{2,40}$/.test(slug)) {
      setError("公開名は半角の小文字英数字とハイフンで 2〜40 文字にしてください(例: souzoku)");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await updateSaleDmScenario(scenario.id, { name: name.trim(), sortOrder: n, publicSlug: slug === "" ? null : slug });
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

  const basicsDirty =
    name.trim() !== scenario.name || sortOrder !== String(scenario.sortOrder) || publicSlug.trim().toLowerCase() !== (scenario.publicSlug ?? "");
  // 公開の条件(設計 2026-10-20 §1): 公開名あり・「使う」・LPの文章あり。足りないものを案内する。
  const publicMissing = [
    ...(scenario.active ? [] : ["「使わない」になっている"]),
    ...(scenario.lpBodyText ? [] : ["LPの文章が未登録"]),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={`DMの種類「${scenario.name}」`}
        description={scenario.autoKey ? <>この種類は、導入ルートや物件種別から自動で選ばれます(削除はできません。止めるときは<Link href="/admin/dm-scenarios" className="font-semibold underline underline-offset-2">一覧</Link>で「使わない」にしてください)。</> : undefined}
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
          <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
            広告用ページの公開名(URLの末尾・空なら公開しない)
            <input
              value={publicSlug}
              onChange={(e) => setPublicSlug(e.target.value)}
              maxLength={40}
              placeholder="例: souzoku"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="scenario-public-slug"
              className="w-56 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <Button size="sm" onClick={() => void saveBasics()} disabled={busy || !basicsDirty || name.trim() === ""}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}保存
          </Button>
        </div>
        {scenario.publicSlug ? (
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-400" data-testid="scenario-public-url">
            お客さまに見せるURL: <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{`<追跡用URL>/lp/${scenario.publicSlug}`}</code>
            (追跡用URLは <Link href="/admin/sale-dm-settings" className="font-semibold underline underline-offset-2">LPの設定</Link> の値。例: https://app.ligarejapan.com/lp/{scenario.publicSlug})
            {publicMissing.length > 0 && (
              <span className="ml-1 text-amber-700 dark:text-amber-300">⚠まだ公開されていません: {publicMissing.join("・")}</span>
            )}
          </p>
        ) : (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">公開名を付けて保存すると、手紙の宛先に関係なく誰にでも見せられるご案内ページ(広告用)のURLができます。</p>
        )}
        {notice && <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">{notice}</p>}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>

      <ScenarioTextEditor scenario={scenario} kind="letter" onChanged={() => void reloadContent()} />
      <LetterIllustrationPanel scenarioId={scenario.id} illustration={scenario.letterIllustration} onChanged={() => void reloadContent()} />
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
