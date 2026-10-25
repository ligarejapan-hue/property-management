"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Cloud, CloudOff, ExternalLink, FolderOpen, Link2, Loader2, Search, Unlink } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DRIVE_ALERT_AFTER_FAILURES } from "@/lib/drive/failure-alert";
import {
  createDriveLink,
  deleteDriveLink,
  disconnectDrive,
  getDriveStatus,
  listDriveFolders,
  listDriveLinks,
  searchPropertiesForReportInbox,
  type DriveConnectionStatus,
  type DriveFolderLink,
  type DriveFolderRow,
  type ReportInboxSearchRow,
} from "@/lib/api-client";

/**
 * 管理 › ドライブ連携(書類の自動整理 第2段a・2026-10-24)。
 * - 接続: 「Google に接続」で Google の同意画面へ(戻ってくると ?connected=1)。トークンは画面に出ない。
 * - 紐づけ: ドライブのフォルダをたどり、行の候補(名前一致・住所が近い)か「物件を探す」で物件を選んで紐づける。
 * ⚠候補はあくまで候補。紐づけるのは人が押したときだけ(自動では紐づけない)。
 */

const REASON_LABELS: Record<string, string> = {
  name_room: "物件名・号室が一致",
  name: "物件名が一致",
  address: "所在地が近い",
};

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "サーバーに Google のクライアント設定(app.env)がありません。管理者(保守)に連絡してください。",
  no_redirect_uri: "アプリの入口の URL(NEXTAUTH_URL)が設定されていないため、戻り先を作れません。",
  no_state_secret: "サーバーの秘密(NEXTAUTH_SECRET)が設定されていません。",
  crypto: "暗号化キー(SALE_DM_SETTINGS_ENC_KEY)が未設定のため、接続の鍵を保存できません。",
  state: "接続のやり直しが必要です(確認用の合言葉が合いませんでした。10分以上たったか、別の人が始めた接続です)。",
  no_code: "Google から認可コードが返りませんでした。もう一度お試しください。",
  denied: "Google の画面で許可されませんでした。",
  no_refresh_token: "更新用の鍵が返りませんでした。もう一度「Google に接続」を押し、Google の画面で許可してください。",
  exchange: "Google とのやりとりに失敗しました。Cloud Console の戻り先 URL とクライアント設定を確かめてください。",
};

function propertyLabel(p: { buildingName: string | null; roomNo: string | null; address: string }): string {
  const name = [p.buildingName, p.roomNo ? `${p.roomNo}号室` : null].filter(Boolean).join(" ");
  return name || p.address;
}

// useSearchParams を使う画面は Suspense で包む必要がある(build 時の静的化の決まり)。
// インナーに本体を置き、default export 側で Suspense ラップする。
export default function DriveAdminPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 p-6 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
        </div>
      }
    >
      <DriveAdminPageInner />
    </Suspense>
  );
}

function DriveAdminPageInner() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<DriveConnectionStatus | null>(null);
  const [links, setLinks] = useState<DriveFolderLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);

  // Google から戻ったときの結果(URL の ?connected=1 / ?error=…)は描画のたびに URL から導く(state に写さない)。
  const paramNotice = searchParams.get("connected") === "1" ? "Google ドライブに接続しました。" : null;
  const paramErrorCode = searchParams.get("error");
  const paramError = paramErrorCode ? (ERROR_MESSAGES[paramErrorCode] ?? "接続に失敗しました。") : null;

  const reload = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([getDriveStatus(), listDriveLinks()]);
      setStatus(s);
      setLinks(l);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 紐づけ・外しのあと: 状態と紐づけ一覧を読み直し、フォルダの一覧も読み直させる(rev を進める)。
  const [linksRev, setLinksRev] = useState(0);
  const afterLinkChange = useCallback(async () => {
    await reload();
    setLinksRev((v) => v + 1);
  }, [reload]);

  const onDisconnect = async () => {
    setBusy(true);
    try {
      setStatus(await disconnectDrive());
      setNotice("接続を切りました。紐づけはそのまま残っています。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "接続を切れませんでした");
    } finally {
      setBusy(false);
      setConfirmDisconnect(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
      </div>
    );
  }

  const connected = status?.connected ?? false;
  const canConnect = (status?.clientConfigured ?? false) && (status?.cryptoConfigured ?? false);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="ドライブ連携"
        description="会社の Google ドライブに接続し、ドライブの物件フォルダとアプリの物件を紐づけます。アプリが触るのは紐づけたフォルダの中だけです。書類の往復(複製・取り込み)は次の段で入ります。"
      />

      {(notice ?? paramNotice) && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice ?? paramNotice}
        </div>
      )}
      {(error ?? paramError) && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error ?? paramError}</span>
        </div>
      )}

      {/* 接続 */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {connected ? <Cloud className="h-5 w-5 text-emerald-600" /> : <CloudOff className="h-5 w-5 text-gray-400" />}
            <div>
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {connected ? "接続済み" : "未接続"}
                {connected && status?.accountEmail && (
                  <span className="ml-2 font-normal text-gray-600 dark:text-gray-300">{status.accountEmail}</span>
                )}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {connected
                  ? `接続日時: ${status?.connectedAt ? new Date(status.connectedAt).toLocaleString("ja-JP") : "—"} ／ 紐づけたフォルダ: ${status?.linkedFolderCount ?? 0} ／ 最後の見回り: ${status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString("ja-JP") : "まだ"}`
                  : "「Google に接続」を押すと Google の画面が開きます。会社のアカウント(ドライブの持ち主)で許可してください。"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canConnect ? (
              // Google の同意画面へは API の道(302)を経由するので、素のリンク(画面遷移そのもの)で飛ぶ。
              // 見た目は共通 Button の primary と同じ(indigo)。
              <a
                href="/api/drive/oauth/start"
                className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-indigo-700"
              >
                <Cloud className="h-4 w-4" /> {connected ? "接続をやり直す" : "Google に接続"}
              </a>
            ) : (
              <span className="text-xs text-amber-700 dark:text-amber-300">接続に必要なサーバー設定が揃っていません(下の案内)</span>
            )}
            {connected && (
              <Button variant="secondary" size="sm" onClick={() => setConfirmDisconnect(true)} disabled={busy}>
                接続を切る
              </Button>
            )}
          </div>
        </div>

        {status && !canConnect && (
          <div className="mt-3 space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="font-semibold">保守の方へ(発注者の操作は不要です)</div>
            {!status.clientConfigured && (
              <div>
                app.env に <code>GOOGLE_DRIVE_CLIENT_ID</code> / <code>GOOGLE_DRIVE_CLIENT_SECRET</code>(Cloud Console の「ウェブ アプリケーション」型 OAuth クライアント)を置き、
                承認済みのリダイレクト URI に次を登録してください:
                <div className="mt-1 select-all break-all rounded bg-white px-2 py-1 font-mono text-[11px] dark:bg-gray-900">
                  {status.redirectUri ?? "(NEXTAUTH_URL が未設定のため作れません)"}
                </div>
              </div>
            )}
            {!status.cryptoConfigured && <div>暗号化キー(SALE_DM_SETTINGS_ENC_KEY)が未設定です。</div>}
          </div>
        )}
        {status?.lastError && (
          <div className="mt-3 text-xs text-red-700 dark:text-red-300">
            直近の失敗: {status.lastError}
            {status.consecutiveFailures >= DRIVE_ALERT_AFTER_FAILURES && `(${status.consecutiveFailures}回続いています)`}
          </div>
        )}
      </section>

      {/* 紐づけ済み */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">紐づけ済みの一覧({links.length})</h2>
        {links.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">まだありません。下の「ドライブのフォルダ」から紐づけてください。</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {links.map((l) => (
              <LinkRow key={l.id} link={l} onRemoved={afterLinkChange} />
            ))}
          </ul>
        )}
      </section>

      {/* フォルダをたどる */}
      {connected && <FolderBrowser links={links} rev={linksRev} onLinked={afterLinkChange} />}

      {confirmDisconnect && (
        <ConfirmDialog
          title="Google ドライブの接続を切りますか?"
          message="保存している接続の鍵を消します。紐づけはそのまま残り、接続し直せばまた使えます。ドライブのファイルは消えません。"
          confirmLabel="接続を切る"
          busy={busy}
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={onDisconnect}
        />
      )}
    </div>
  );
}

function LinkRow({ link, onRemoved }: { link: DriveFolderLink; onRemoved: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteDriveLink(link.id);
      await onRemoved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "外せませんでした");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium text-gray-900 dark:text-gray-100">{propertyLabel(link.property)}</div>
        <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="truncate">{link.folderPath || link.folderName}</span>
          {link.webViewLink && (
            <a href={link.webViewLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-blue-700 underline dark:text-blue-300">
              開く <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {err && <div className="text-xs text-red-700 dark:text-red-300">{err}</div>}
      </div>
      <Button variant="secondary" size="sm" onClick={() => setConfirm(true)} disabled={busy}>
        <Unlink className="mr-1 h-3.5 w-3.5" /> 外す
      </Button>
      {confirm && (
        <ConfirmDialog
          title="この紐づけを外しますか?"
          message="アプリとドライブのファイルはどちらも消えません。往復の記録(台帳)だけが消えます。"
          confirmLabel="外す"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={remove}
        />
      )}
    </li>
  );
}

type Crumb = { id: string; name: string };

function FolderBrowser({
  links,
  rev,
  onLinked,
}: {
  links: DriveFolderLink[];
  /** 紐づけ・外しのたびに増える番号。変わったらフォルダの一覧も読み直す(候補と「紐づけ済」をサーバーの今の状態に)。 */
  rev: number;
  onLinked: () => Promise<void>;
}) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: "root", name: "マイドライブ" }]);
  const [rows, setRows] = useState<DriveFolderRow[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const parent = crumbs[crumbs.length - 1].id;

  // 読み込みの世代。移動・絞り込み・さらに読むが重なったとき、最後に始めたもの以外の応答は捨てる
  // (古い応答が今のパンくずの下に別のフォルダの一覧を出してしまう・@codex #577 R3)。
  const loadGen = useRef(0);

  // ⚠effect の中で同期に state を変えない(読み込み中の印は押した側で立てる)。
  const load = useCallback(
    async (append = false, pageToken?: string) => {
      const gen = ++loadGen.current;
      try {
        const r = await listDriveFolders({ parent, q: q.trim() || undefined, pageToken });
        if (gen !== loadGen.current) return;
        setRows((prev) => (append ? [...prev, ...r.data] : r.data));
        setNextToken(r.nextPageToken);
        setErr(null);
      } catch (e) {
        if (gen !== loadGen.current) return;
        setErr(e instanceof Error ? e.message : "フォルダを読めませんでした");
      } finally {
        if (gen === loadGen.current) setLoading(false);
      }
    },
    [parent, q],
  );

  useEffect(() => {
    void load(false);
  }, [load, rev]);

  /** フォルダを移る(押した側で読み込み中の印を立ててから場所を変える)。 */
  const go = (next: Crumb[]) => {
    // 同じフォルダ(今のパンくず・選択中のタブ)で絞り込みも無い=読み込み直す理由が無い。ここで印を立てると、
    // load の依存(parent・q)が変わらず effect が走らないので「読み込み中」のまま固まる(@codex #577 R2)。
    const same = next.length === crumbs.length && next[next.length - 1].id === parent;
    if (same && q === "") return;
    setLoading(true);
    setRows([]);
    setNextToken(null);
    // ⚠名前の絞り込みは「いま開いているフォルダの中」用。移ったら外す(残すと、建物名で絞って開いた
    //   物件フォルダの中の「売却」「購入」が隠れて「フォルダがありません」になる・@codex #577 P2)。
    setQ("");
    setCrumbs(next);
  };

  /**
   * 絞り込みを変える。前の問い合わせの続きの印(nextToken)は別の問い合わせには使えないので消し、
   * 読み込み中にする(「さらに読む」が新しい1ページ目を追い越して捨てさせない・@codex #577 R4)。
   */
  const changeFilter = (v: string) => {
    setLoading(true);
    setRows([]);
    setNextToken(null);
    setQ(v);
  };

  // 「紐づけ済」の表示と候補の使えなさは、読み込んだ時点の行ではなく今の紐づけ一覧から決める
  // (外した直後でも紐づけ直せるように・@codex #577 R2)。
  const linkByFolder = new Map(links.map((l) => [l.folderId, l]));
  const linkedFolderByProperty = new Map(links.map((l) => [l.propertyId, l.folderId]));

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">ドライブのフォルダ</h2>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            aria-pressed={crumbs[0].id === "root"}
            className={`rounded px-2 py-1 ${crumbs[0].id === "root" ? "bg-gray-100 font-semibold dark:bg-gray-800" : "text-gray-600 dark:text-gray-300"}`}
            onClick={() => go([{ id: "root", name: "マイドライブ" }])}
          >
            マイドライブ
          </button>
          <button
            type="button"
            aria-pressed={crumbs[0].id === "shared"}
            className={`rounded px-2 py-1 ${crumbs[0].id === "shared" ? "bg-gray-100 font-semibold dark:bg-gray-800" : "text-gray-600 dark:text-gray-300"}`}
            onClick={() => go([{ id: "shared", name: "共有アイテム" }])}
          >
            共有アイテム
          </button>
        </div>
      </div>
      <nav className="mb-2 flex flex-wrap items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <span>›</span>}
            <Button variant="ghost" size="sm" className="px-1 py-0.5 underline-offset-2 hover:underline" onClick={() => go(crumbs.slice(0, i + 1))}>
              {c.name}
            </Button>
          </span>
        ))}
      </nav>
      <div className="mb-2 flex items-center gap-2">
        <Search className="h-4 w-4 text-gray-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => changeFilter(e.target.value)}
          placeholder="このフォルダの中を名前で絞る"
          aria-label="フォルダを名前で絞る"
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
        />
      </div>
      {err && <div className="mb-2 text-xs text-red-700 dark:text-red-300">{err}</div>}
      {loading && rows.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 読み込み中…</div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">フォルダがありません。</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              linkedTo={linkByFolder.get(f.id)?.property ?? null}
              linkedFolderByProperty={linkedFolderByProperty}
              onOpen={() => go([...crumbs, { id: f.id, name: f.name }])}
              onLinked={onLinked}
            />
          ))}
        </ul>
      )}
      {nextToken && (
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={() => { setLoading(true); void load(true, nextToken); }} disabled={loading}>
            さらに読む
          </Button>
        </div>
      )}
    </section>
  );
}

function FolderRow({
  folder,
  linkedTo,
  linkedFolderByProperty,
  onOpen,
  onLinked,
}: {
  folder: DriveFolderRow;
  /** このフォルダが今紐づいている物件(今の紐づけ一覧から)。null=紐づいていない。 */
  linkedTo: { buildingName: string | null; roomNo: string | null; address: string } | null;
  /** 物件 → 紐づいているフォルダ(今の紐づけ一覧から)。候補の「紐づけ済」をこれで決める。 */
  linkedFolderByProperty: Map<string, string>;
  onOpen: () => void;
  onLinked: () => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReportInboxSearchRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ propertyId: string; label: string } | null>(null);

  const link = async (propertyId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await createDriveLink(propertyId, folder.id);
      setPicking(false);
      await onLinked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "紐づけられませんでした");
    } finally {
      setBusy(false);
      setPendingLink(null);
    }
  };

  const search = async () => {
    if (query.trim() === "") return;
    setBusy(true);
    try {
      setResults(await searchPropertiesForReportInbox(query.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "探せませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onOpen} className="min-w-0 justify-start px-1 py-0.5 text-left text-sm font-medium text-gray-900 hover:underline dark:text-gray-100" title="このフォルダの中を見る">
            <FolderOpen className="mr-1 h-4 w-4 shrink-0 text-amber-500" />
            <span className="truncate">{folder.name}</span>
          </Button>
          {!folder.ownedByMe && folder.ownerEmail && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">所有者: {folder.ownerEmail}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {linkedTo ? (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Link2 className="h-3 w-3" /> 紐づけ済: {propertyLabel(linkedTo)}
            </span>
          ) : (
            <>
              {folder.candidates.map((c) => {
                const otherFolder = linkedFolderByProperty.get(c.propertyId) ?? null;
                return (
                  <Button
                    key={c.propertyId}
                    variant="secondary"
                    size="sm"
                    disabled={busy || otherFolder !== null}
                    onClick={() => setPendingLink({ propertyId: c.propertyId, label: propertyLabel(c) })}
                    title={otherFolder ? "この物件は別のフォルダと紐づいています" : REASON_LABELS[c.reason]}
                  >
                    <Link2 className="mr-1 h-3 w-3" /> {propertyLabel(c)}
                    <span className="ml-1 text-[10px] text-gray-500">({otherFolder ? "紐づけ済" : REASON_LABELS[c.reason]})</span>
                  </Button>
                );
              })}
              <Button variant="secondary" size="sm" onClick={() => setPicking((v) => !v)} disabled={busy}>
                物件を探す
              </Button>
            </>
          )}
        </div>
      </div>
      {picking && (
        <div className="mt-2 rounded-md border border-gray-200 p-2 dark:border-gray-700">
          <div className="flex gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
              placeholder="マンション名・所在地・部屋番号で探す(例: 東急ドエル 302)"
              aria-label="物件を探す"
              className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
            />
            <Button size="sm" onClick={search} disabled={busy || query.trim() === ""}>探す</Button>
          </div>
          {results && (
            <ul className="mt-2 space-y-1">
              {results.length === 0 && <li className="text-xs text-gray-500">見つかりませんでした</li>}
              {results.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                  <span>{propertyLabel({ buildingName: r.buildingName, roomNo: r.roomNo, address: r.address })} <span className="text-gray-500">{r.address}</span></span>
                  <Button size="sm" onClick={() => setPendingLink({ propertyId: r.id, label: propertyLabel({ buildingName: r.buildingName, roomNo: r.roomNo, address: r.address }) })} disabled={busy}>
                    この物件に紐づける
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {err && <div className="mt-1 text-xs text-red-700 dark:text-red-300">{err}</div>}
      {pendingLink && (
        <ConfirmDialog
          title="このフォルダを物件に紐づけますか?"
          message={`ドライブ「${folder.name}」 ⇄ 物件「${pendingLink.label}」。紐づけたフォルダの中だけをアプリが見ます(ファイルはまだ動かしません)。`}
          confirmLabel="紐づける"
          busy={busy}
          onCancel={() => setPendingLink(null)}
          onConfirm={() => link(pendingLink.propertyId)}
        />
      )}
    </li>
  );
}
