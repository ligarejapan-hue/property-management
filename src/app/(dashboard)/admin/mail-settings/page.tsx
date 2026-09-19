"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Loader2, Save, Send, ShieldCheck, ShieldAlert, AlertTriangle } from "lucide-react";
import {
  getMailSettings,
  updateMailSettings,
  sendMailSettingsTest,
  apiErrorSmtpCode,
  type MailSettings,
} from "@/lib/api-client";

// メール送信設定(管理者のみ)。査定申込が届いたときの通知メールを送る
// Xserver のメールボックス(サーバー名・ポート・ユーザー名・パスワード・送信元アドレス)と、
// 通知メールのリンクに使うアプリのURL・通知の詳しさを設定する画面。
//
// ⚠パスワードは画面へ絶対に戻さない(サーバーも hasPassword しか返さない)。
//   欄は毎回空で始まり、空のまま保存すると「変更しない」として扱われる(サーバー側の挙動)。
export default function MailSettingsPage() {
  const [loading, setLoading] = useState(true);
  // 初回読み込みが一度でも成功したか。⚠これが false の間は保存・テスト送信を必ず止める
  // (読み込み失敗のまま空の初期値で保存すると、保存済みのホスト/ユーザー名/送信元/URL が
  //  null に正規化されて上書きされ、動いていた設定を壊してしまうため)。
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testMessage, setTestMessage] = useState<{ kind: "ok" | "err"; text: string; smtpCode?: string | null; hint?: string | null } | null>(null);

  // メタ情報(パスワードの値は含まない)。
  const [meta, setMeta] = useState<MailSettings | null>(null);

  // 編集用 state。
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUser, setSmtpUser] = useState("");
  // ⚠変数名は smtp + Pass を連続させない(値を画面に戻さない方針のマーカーとして、
  //   走査テストがそれを束縛する記法を禁じている)。
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [appBaseUrl, setAppBaseUrl] = useState("");
  const [inquiryMailDetail, setInquiryMailDetail] = useState<"minimal" | "full">("minimal");

  // 接続方式ごとの既定ポート(選択を変えたときだけポートを合わせる用)。
  const KNOWN_DEFAULT_PORTS = ["465", "587"];

  // 接続方式(SSL/STARTTLS)を変えたとき、ポートが空欄か「もう一方の既定値」のままなら
  // 新しい既定値へ合わせる。手入力で別のポート(例: 2525)を使っている場合は変えない。
  // ⚠読み込み時(applySettings)からは呼ばない=保存済みの値を勝手に書き換えない。
  const handleSmtpSecureChange = (nextSecure: boolean) => {
    setSmtpSecure(nextSecure);
    setSmtpPort((prev) => {
      const trimmed = prev.trim();
      if (trimmed === "" || KNOWN_DEFAULT_PORTS.includes(trimmed)) {
        return nextSecure ? "465" : "587";
      }
      return prev;
    });
  };

  // 直近に保存された値(未保存の変更があるかどうかの判定に使う)。パスワードは含めない
  // (欄は常に空スタートのため、未保存判定は「入力されているか」だけで見る)。
  const [savedSnapshot, setSavedSnapshot] = useState({
    smtpHost: "",
    smtpPort: "465",
    smtpSecure: true,
    smtpUser: "",
    fromAddress: "",
    appBaseUrl: "",
    inquiryMailDetail: "minimal" as "minimal" | "full",
  });

  const applySettings = (data: MailSettings) => {
    setMeta(data);
    setSmtpHost(data.smtpHost ?? "");
    setSmtpPort(String(data.smtpPort ?? 465));
    setSmtpSecure(data.smtpSecure);
    setSmtpUser(data.smtpUser ?? "");
    setPassword("");
    setFromAddress(data.fromAddress ?? "");
    setAppBaseUrl(data.appBaseUrl ?? "");
    setInquiryMailDetail(data.inquiryMailDetail);
    setSavedSnapshot({
      smtpHost: data.smtpHost ?? "",
      smtpPort: String(data.smtpPort ?? 465),
      smtpSecure: data.smtpSecure,
      smtpUser: data.smtpUser ?? "",
      fromAddress: data.fromAddress ?? "",
      appBaseUrl: data.appBaseUrl ?? "",
      inquiryMailDetail: data.inquiryMailDetail,
    });
  };

  // 読み込み(初回・再読み込み共通)。失敗しても loaded は true にしない=
  // 保存・テスト送信ボタンは disabled のまま。
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await getMailSettings();
      applySettings(res.data);
      setLoaded(true);
    } catch (e) {
      setLoaded(false);
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "設定の取得に失敗しました" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 未保存の変更があるか(パスワードは「入力欄に何か入っているか」で見る=元の値と比較できないため)。
  const isDirty =
    smtpHost !== savedSnapshot.smtpHost ||
    smtpPort !== savedSnapshot.smtpPort ||
    smtpSecure !== savedSnapshot.smtpSecure ||
    smtpUser !== savedSnapshot.smtpUser ||
    fromAddress !== savedSnapshot.fromAddress ||
    appBaseUrl !== savedSnapshot.appBaseUrl ||
    inquiryMailDetail !== savedSnapshot.inquiryMailDetail ||
    password.trim() !== "";

  const save = async () => {
    if (saving) return;
    const portNum = Number(smtpPort.trim());
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setMessage({ kind: "err", text: "ポート番号を正しく入力してください(1〜65535)" });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const body: Parameters<typeof updateMailSettings>[0] = {
        smtpHost,
        smtpPort: portNum,
        smtpSecure,
        smtpUser,
        fromAddress,
        appBaseUrl,
        inquiryMailDetail,
      };
      // パスワードは入力があったときだけ送る(空欄=現状維持。サーバーは未指定キーを触らない)。
      if (password.trim() !== "") {
        body.smtpPassword = password;
      }
      const res = await updateMailSettings(body);
      applySettings(res.data);
      setMessage({ kind: "ok", text: "設定を保存しました" });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "保存に失敗しました" });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    if (isDirty) {
      setTestMessage({ kind: "err", text: "先に保存してください" });
      return;
    }
    setTesting(true);
    setTestMessage(null);
    try {
      await sendMailSettingsTest();
      setTestMessage({ kind: "ok", text: "テストメールを送信しました。届いているか確認してください" });
    } catch (e) {
      const smtpCode = apiErrorSmtpCode(e);
      setTestMessage({
        kind: "err",
        text: e instanceof Error ? e.message : "テスト送信に失敗しました",
        smtpCode,
        hint: smtpCode ? smtpCodeHint(smtpCode) : null,
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
      </div>
    );
  }

  const complete = meta?.complete ?? false;

  // 接続方式とポートの既知の食い違い(ヒントのみ=保存は止めない)。
  const trimmedPort = smtpPort.trim();
  const portMismatchNote =
    smtpSecure && trimmedPort === "587"
      ? "この接続方式では通常 465 を使います(587 のままでも保存はできます)"
      : !smtpSecure && trimmedPort === "465"
        ? "この接続方式では通常 587 を使います(465 のままでも保存はできます)"
        : null;

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <PageHeader
        title="メール送信設定"
        description="査定申込が届いたときの通知メールを送る、Xserver のメールボックスを設定します。ここで設定したメールアドレスから、通知を受け取る利用者へ届きます。"
      />

      <div className={`flex items-center gap-2 rounded-md border p-3 text-xs ${complete ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"}`}>
        {complete ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        {complete
          ? "通知メールを送る設定が揃っています。"
          : "通知メールを送るには、送信サーバー・ポート・ユーザー名・パスワード・送信元アドレスをすべて設定してください。"}
      </div>

      {meta && meta.notifyRecipientCount === 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          通知先が未設定です。利用者一覧の「通知」から、通知を受け取る人を設定してください。
        </div>
      )}

      {meta && meta.cryptoConfigured === false && (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          サーバーの暗号化キーが未設定のため、パスワードを保存できません
        </div>
      )}

      {message && (
        <p className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="alert">
          {message.text}
        </p>
      )}

      <div className="space-y-4">
        <Field label="送信サーバー">
          <input
            value={smtpHost}
            onChange={(e) => setSmtpHost(e.target.value)}
            placeholder="例: sv2035.xserver.jp"
            maxLength={255}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </Field>
        <Field label="ポート(既定 465)">
          <input
            value={smtpPort}
            onChange={(e) => setSmtpPort(e.target.value)}
            inputMode="numeric"
            placeholder="465"
            maxLength={5}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
          {portMismatchNote && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{portMismatchNote}</p>
          )}
        </Field>
        <Field label="接続方式">
          <select
            value={smtpSecure ? "ssl" : "starttls"}
            onChange={(e) => handleSmtpSecureChange(e.target.value === "ssl")}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="ssl">SSL(465)</option>
            <option value="starttls">STARTTLS(587)</option>
          </select>
        </Field>
        <Field label="ユーザー名(メールアドレス全体)">
          <input
            value={smtpUser}
            onChange={(e) => setSmtpUser(e.target.value)}
            placeholder="例: info@ligarejapan.com"
            maxLength={254}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </Field>
        <Field label="パスワード">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={meta?.cryptoConfigured === false}
            placeholder={meta?.hasPassword ? "設定済み(変更する場合のみ入力)" : "メールボックスのパスワード"}
            maxLength={500}
            autoComplete="new-password"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
          <span className="mt-1 block text-xs text-gray-500">空欄のまま保存すると、いまの設定を変えません。</span>
        </Field>
        <Field label="送信元アドレス">
          <input
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="例: info@ligarejapan.com"
            maxLength={254}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </Field>
        <Field label="アプリのURL(社内から開く https のアドレス・通知メールのリンクに使う)">
          <input
            value={appBaseUrl}
            onChange={(e) => setAppBaseUrl(e.target.value)}
            placeholder="例: https://app.example.com"
            maxLength={2000}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </Field>
        <Field label="通知の詳しさ">
          <select
            value={inquiryMailDetail}
            onChange={(e) => setInquiryMailDetail(e.target.value as "minimal" | "full")}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="minimal">最小(町名・種別・お名前・リンク)</option>
            <option value="full">詳しく(電話・メール・要望も)※電話とメールを見られる人にだけ</option>
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !loaded}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          保存
        </button>
        <button
          type="button"
          onClick={runTest}
          disabled={testing || saving || !loaded}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          テスト送信
        </button>
      </div>

      {!loaded && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>設定を読み込めませんでした。再読み込みしてください。保存・テスト送信は行えません。</span>
          <button
            type="button"
            onClick={loadSettings}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 font-medium text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-gray-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            再読み込み
          </button>
        </div>
      )}

      {testMessage && (
        <div className={`rounded-md border p-3 text-xs ${testMessage.kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300"}`} role="alert">
          <p>{testMessage.text}</p>
          {testMessage.smtpCode && (
            <p className="mt-1">
              エラーコード: <code>{testMessage.smtpCode}</code>
              {testMessage.hint && <span>({testMessage.hint})</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// SMTP の許可リスト一致コード(EAUTH 等・自由文なし)から、平易な日本語のヒントを出す。
// 該当が無いコードは null(コードだけ表示し、当てずっぽうの説明は出さない)。
function smtpCodeHint(code: string): string | null {
  if (code.includes("AUTH")) {
    return "ユーザー名またはパスワードが違う可能性があります";
  }
  if (
    code.includes("TIMEOUT") ||
    code.includes("TIMED") ||
    code.includes("CONNECTION") ||
    code.includes("ECONNREFUSED") ||
    code.includes("ENOTFOUND") ||
    code.includes("RESET")
  ) {
    return "送信サーバー名またはポートが違う可能性があります";
  }
  return null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}
