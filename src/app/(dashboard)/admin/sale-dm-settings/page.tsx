"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { BackLink } from "@/components/ui/back-link";
import { Loader2, Save, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  isSaleDmPrintReady,
  missingSaleDmPrintRequirements,
} from "@/lib/sale-dm-letter/print-ready";
import {
  fetchSaleDmSettings,
  updateSaleDmSettings,
  type SaleDmSettings,
} from "@/lib/api-client";
import { DEFAULT_PRIVACY_TEXT } from "@/lib/sale-dm-letter/privacy-text";
import { Button } from "@/components/ui/button";

// 売却促進DM の設定(管理者のみ)。
// 設定するのは「追跡用URL・既定LP URL・差出人名・差出人連絡先」の4つだけ。
// ⚠AI関連の入力欄は 2026-09-12 に画面から外した(発注者決定)。
//   文面はお手元のAIで作って貼り付ける方式(実績91でAI直結を廃止)なので、
//   使わない入力欄が管理画面にあると「設定しないと動かない」と誤解を生み、
//   不要な有料契約に進みかねない。DB列(sale_dm_config の該当列)は将来の復活用に残す。
export default function SaleDmSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 編集用 state(現在値で初期化)。
  const [trackingBaseUrl, setTrackingBaseUrl] = useState("");
  const [lpUrl, setLpUrl] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderContact, setSenderContact] = useState("");
  const [privacyText, setPrivacyText] = useState("");
  // 広告用の公開ページ(/lp/<公開名>)の Google のタグ(設計 2026-10-20)。DM 用のページには入らない。
  const [googleTagId, setGoogleTagId] = useState("");
  const [googleConvLabel, setGoogleConvLabel] = useState("");

  const applySettings = (data: SaleDmSettings) => {
    setTrackingBaseUrl(data.trackingBaseUrl ?? "");
    setLpUrl(data.lpUrl ?? "");
    setSenderName(data.senderName ?? "");
    setSenderContact(data.senderContact ?? "");
    setPrivacyText(data.privacyText ?? "");
    setGoogleTagId(data.googleTagId ?? "");
    setGoogleConvLabel(data.googleConvLabel ?? "");
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchSaleDmSettings();
        applySettings(res.data);
      } catch (e) {
        setMessage({ kind: "err", text: e instanceof Error ? e.message : "設定の取得に失敗しました" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      // 送るのは画面にある項目だけ(サーバー側は部分更新なので、送らない列は触られない)。
      const res = await updateSaleDmSettings({
        trackingBaseUrl,
        lpUrl,
        senderName,
        senderContact,
        privacyText,
        googleTagId,
        googleConvLabel,
      });
      applySettings(res.data);
      setMessage({ kind: "ok", text: "設定を保存しました" });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "保存に失敗しました" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
      </div>
    );
  }

  // この設定で売却DMが「使える」状態かどうか。
  // ⚠判定は**サーバーと同じ純関数**を使う（print-ready.ts）。以前はここに条件を書き写して
  //   いたため、AI直結の生成を廃止したあとも画面だけが古い条件を要求し続け、
  //   **使えるのに「使えません」**と表示していた。
  const printReadyInput = { trackingBaseUrl, lpUrl, senderName, senderContact };
  const enabledHint = isSaleDmPrintReady(printReadyInput);
  const missingRequirements = missingSaleDmPrintRequirements(printReadyInput);

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <BackLink href="/lp" to="LPメニュー" />
      <PageHeader
        title="売却DM設定"
        description="売却DMの追跡用URL・既定LP URL・差出人を設定します。手紙の文面はお手元のブラウザのAIで作り、貼り付ける方式です(このシステム側にAIの契約や設定は不要です)。"
      />

      <div className={`flex items-center gap-2 rounded-md border p-3 text-xs ${enabledHint ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"}`}>
        {enabledHint ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        {enabledHint
          ? "売却DMを使う設定が揃っています(利用者には「物件情報の編集」権限が必要です)。"
          : `売却DMを使うには次の設定が必要です: ${missingRequirements.join(" / ")}。⚠URLは http(s) から始まる絶対URLで入力してください。`}
      </div>

      {message && (
        <p className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="alert">
          {message.text}
        </p>
      )}

      <div className="space-y-4">
        <Field label="追跡用URL(お客さまがQRで開く公開ページのアドレス)">
          <input value={trackingBaseUrl} onChange={(e) => setTrackingBaseUrl(e.target.value)} placeholder="例: https://app.example.com" maxLength={2000} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          {/* 第4回 E: メール送信設定の「アプリのURL」と同じ欄に見えて二重入力と思われやすい。別物なのでまとめない
              (本番はこちら=公開ページ・あちら=社内から開くこのシステムで、住所が違う)。 */}
          <p data-testid="sale-dm-tracking-url-note" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            お手紙のQRを読んだお客さまが開く、外から見える住所です。社内の人が通知メールから開く住所は別の欄です(
            <Link href="/admin/mail-settings" className="font-semibold underline underline-offset-2">メール送信設定</Link>
            の「アプリのURL」)。
          </p>
        </Field>
        <Field label="既定LP URL(QRの遷移先・型ごとLP未設定時のフォールバック)">
          <input value={lpUrl} onChange={(e) => setLpUrl(e.target.value)} placeholder="例: https://lp.example.com" maxLength={2000} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="差出人名">
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="例: 株式会社○○不動産" maxLength={100} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="差出人連絡先">
          <input value={senderContact} onChange={(e) => setSenderContact(e.target.value)} placeholder="例: 03-0000-0000" maxLength={200} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="個人情報の取扱い文(公開LPの申込フォームに表示)">
          <textarea value={privacyText} onChange={(e) => setPrivacyText(e.target.value)} placeholder={DEFAULT_PRIVACY_TEXT} maxLength={2000} rows={5} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          <span className="mt-1 block text-xs text-gray-500">空欄のときは、薄く表示している見本の文章をそのまま使います。</span>
        </Field>
        <Field label="Googleタグ ID(広告用ページだけに入れる計測タグ・任意)">
          <input value={googleTagId} onChange={(e) => setGoogleTagId(e.target.value)} placeholder="例: AW-123456789 または G-XXXXXXXXXX" maxLength={40} autoCapitalize="characters" spellCheck={false} data-testid="sale-dm-google-tag-id" className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          <span className="mt-1 block text-xs text-gray-500">Google広告(AW-…)またはGoogleアナリティクス(G-…)の管理画面にある ID です。入れると、DMの種類に公開名を付けた広告用ページ(/lp/…)だけで Google の計測タグを読み込みます。手紙のQRから開くご案内ページには入りません。空欄なら何も読み込みません。</span>
        </Field>
        <Field label="申込完了のコンバージョン ラベル(Google広告・任意)">
          <input value={googleConvLabel} onChange={(e) => setGoogleConvLabel(e.target.value)} placeholder="例: AbCdEfGhIjK-1234567" maxLength={80} spellCheck={false} data-testid="sale-dm-google-conv-label" className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          <span className="mt-1 block text-xs text-gray-500">Google広告の「コンバージョン」で作ったタグの「send_to」のスラッシュの後ろの部分です。入れると、広告用ページで申込が完了したときに Google広告へ成果を送ります(タグ ID が AW-… のとき)。</span>
        </Field>
      </div>

      <Button onClick={save} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}
