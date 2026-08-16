"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, Mail, ChevronLeft, ChevronRight, Plus, Trash2, MessageCircle } from "lucide-react";
import { dmMethodLabel, dmTypeLabel } from "@/lib/dm-method-labels";
import {
  REACTION_STATUSES,
  REACTION_LABELS,
  type ReactionStatus,
} from "@/lib/dm-reaction/core";
import {
  createPropertyDmLog,
  deletePropertyDmLog,
  updatePropertyDmLogReaction,
} from "@/lib/api-client";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import { useSession } from "next-auth/react";

// GET /api/properties/[id]/dm-logs のレスポンス形（note/reactionNote は server-side でマスク済み）。
interface DmLog {
  id: string;
  sentAt: string;
  method: string | null;
  dmType: string | null;
  sequence: number;
  /** サーバ判定の取消可否(売却DM由来・一括確定由来は false=ボタンを出さない)。 */
  deletable: boolean;
  note: string | null;
  reactionStatus: string;
  reactedAt: string | null;
  reactionNote: string | null;
  /** "manual" | "sale_dm_sync"(売却DMからの自動同期) | null */
  reactionSource: string | null;
  sentBy: { id: string; name: string } | null;
  createdAt: string;
}

const REACTION_BADGE_COLORS: Record<string, string> = {
  replied: "bg-green-100 text-green-800 dark:bg-green-500/10 dark:text-green-300",
  refused: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
  undeliverable: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
  no_response: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface DmLogsResponse {
  data: DmLog[];
  pagination: Pagination;
}

/** JST の今日(YYYY-MM-DD)。投函日の既定値・max。 */
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 個別記録の追加フォーム(next-action-tab の CreateActionForm と同型)。 */
function CreateLogForm({
  propertyId,
  onCreated,
  onCancel,
}: {
  propertyId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [sentOn, setSentOn] = useState(todayJst());
  const [method, setMethod] = useState<"mail" | "hand_delivery" | "other">("mail");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPropertyDmLog(propertyId, {
        sentOn,
        method,
        note: note.trim() ? note.trim() : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "記録の追加に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-500/40 dark:bg-blue-500/20"
    >
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-sm text-gray-700 dark:text-gray-200">
          投函日
          <input
            type="date"
            value={sentOn}
            max={todayJst()}
            onChange={(e) => setSentOn(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-200">
          方法
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as "mail" | "hand_delivery" | "other")
            }
            className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="mail">郵送</option>
            <option value="hand_delivery">手渡し</option>
            <option value="other">その他</option>
          </select>
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-200">
          メモ(任意)
          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例: 挨拶を兼ねて手渡し"
            className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={submitting || !sentOn}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "記録中..." : "記録する"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}

/** 反響のインライン編集(PR-B)。売却DM由来の行も編集可=優先規則はサーバが解決する。 */
function ReactionEditor({
  log,
  canWriteNote,
  isAdmin,
  onSave,
  onCancel,
  saving,
}: {
  log: DmLog;
  /** owner_note の edit/full を持つか(無ければメモ入力を出さない=サーバも 403 で拒否) */
  canWriteNote: boolean;
  /** 拒否からの変更は管理者のみ(サーバも 403)。施錠表示の出し分けに使う。 */
  isAdmin: boolean;
  onSave: (
    status: ReactionStatus,
    reactedAt: string,
    note: string,
    clearNote: boolean,
  ) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [status, setStatus] = useState<ReactionStatus>(
    (REACTION_STATUSES as readonly string[]).includes(log.reactionStatus)
      ? (log.reactionStatus as ReactionStatus)
      : "no_response",
  );
  const [reactedAt, setReactedAt] = useState(log.reactedAt ?? "");
  // メモは常に空で開始する: 表示用の値はマスク済みのことがあり、往復させると実メモを
  // マスク値で潰す(#366 R2)。未入力なら送らない=サーバ側は「省略=変更なし」。
  // 消したいときは「メモを消す」を明示チェック(note:null 送信=#366 R3)。
  const [note, setNote] = useState("");
  const [clearNote, setClearNote] = useState(false);
  // 「拒否」は宛名CSV・売却DMの全出口で自動除外の根拠になる重い記録なので、
  // **1回目は予告だけ**を出し、もう一度押したときだけ保存する(発注者指示 2026-08-17・
  // 物件化モーダルの2回押し(Codex R9 P2)と同じ作法)。種別を変えたら予告は解除。
  const [refusalArmed, setRefusalArmed] = useState(false);

  // 既に「拒否」の記録は、管理者以外は変更フォーム自体を出さない(サーバも 403)。
  // 押しても必ず失敗するUIを出さない方針(canWrite などと同じ)。
  if (log.reactionStatus === "refused" && !isAdmin) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <span>「拒否」の変更・取消は管理者のみです</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-200"
        >
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={status}
        onChange={(e) => {
          setStatus(e.target.value as ReactionStatus);
          setRefusalArmed(false);
        }}
        className="rounded-md border border-gray-300 px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-800"
      >
        {REACTION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {REACTION_LABELS[s]}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={reactedAt}
        max={todayJst()}
        onChange={(e) => setReactedAt(e.target.value)}
        className="rounded-md border border-gray-300 px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-800"
      />
      {canWriteNote && (
        <input
          type="text"
          value={note}
          maxLength={500}
          disabled={clearNote}
          onChange={(e) => setNote(e.target.value)}
          placeholder={log.reactionNote ? "メモあり(入力すると上書き)" : "メモ(任意)"}
          className="w-28 rounded-md border border-gray-300 px-1.5 py-1 text-xs disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800"
        />
      )}
      {canWriteNote && log.reactionNote && (
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={clearNote}
            onChange={(e) => {
              setClearNote(e.target.checked);
              if (e.target.checked) setNote("");
            }}
          />
          メモを消す
        </label>
      )}
      {refusalArmed && (
        <span className="basis-full text-xs text-red-700 dark:text-red-300">
          この方は今後、宛名CSV・売却DMの両方から自動で外れます（別の物件も含む）。
          取り消し・変更は管理者のみになります。もう一度押すと確定します。
        </span>
      )}
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          // 「拒否」への変更だけ 2 回押し(既に拒否の記録を拒否のまま保存するのは対象外)。
          if (status === "refused" && log.reactionStatus !== "refused" && !refusalArmed) {
            setRefusalArmed(true);
            return;
          }
          onSave(status, reactedAt, note, clearNote);
        }}
        className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {saving ? "保存中..." : refusalArmed ? "拒否として保存（確定）" : "保存"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-200"
      >
        やめる
      </button>
    </div>
  );
}

/**
 * 物件の DM 送付履歴（PropertyDmLog）を表示し、個別の記録・取消・反響の記録を行う(PR-A/B)。
 * 認可・PII マスク・監査は API(サーバ側)が担う。閲覧は直接 fetch(read-only 専用)、
 * 書き込み(追加/取消/反響)は api-client 経由(USE_MOCK 分岐込み)。
 */
export default function DmLogsView({ propertyId }: { propertyId: string }) {
  const [logs, setLogs] = useState<DmLog[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingReactionId, setEditingReactionId] = useState<string | null>(null);
  const [savingReaction, setSavingReaction] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // 追加/取消/反響は property:write を要求(サーバも 403)。押しても必ず失敗するUIを出さない。
  const { permissions, permissionsLoading, refetchPermissions } =
    useScreenProtection();

  // 権限鮮度(17-C F12-2 と同じ3点セット): ScreenProtectionProvider は dashboard layout に
  // 居座り client navigation で再 mount されないため、provider の mount 時 1 回 fetch だけ
  // では滞在中の権限付与・剥奪に追従できない(剥奪後もボタンが残り、押すと 403 になる)。
  // この画面への進入あたり最大1回だけ再確認する。
  //   - provider の取得が進行中なら完了を待つ(同時2本にしない)
  //   - mount 時に進行中だった取得が成功 → その結果が最新なので追加 fetch しない
  //   - mount 時点で取得完了済み(再訪=stale の可能性)/失敗(復旧)は1回だけ再取得
  //   - ref ガード+provider 側 in-flight dedupe の二重防御で多重 fetch・無限リトライなし
  const permissionsRefreshRequestedRef = useRef(false);
  const permissionsLoadingAtMountRef = useRef<boolean | null>(null);
  if (permissionsLoadingAtMountRef.current === null) {
    permissionsLoadingAtMountRef.current = permissionsLoading;
  }
  // 再確認が終わるまで stale な granted でボタンを出さない(一瞬表示の回帰防止)。
  const [permissionsRefreshPending, setPermissionsRefreshPending] = useState(
    () => !permissionsLoading,
  );
  useEffect(() => {
    if (permissionsRefreshRequestedRef.current) return;
    if (permissionsLoading) return;
    if (permissionsLoadingAtMountRef.current === true && permissions !== null) {
      permissionsRefreshRequestedRef.current = true;
      return;
    }
    permissionsRefreshRequestedRef.current = true;
    setPermissionsRefreshPending(true);
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [permissionsLoading, permissions, refetchPermissions]);

  // 再確認中(pending)・取得中(loading)は空配列へ倒す=ボタン非表示(fail-safe)。
  const effectivePermissions = useMemo(
    () =>
      permissionsRefreshPending || permissionsLoading
        ? []
        : (permissions ?? []),
    [permissions, permissionsLoading, permissionsRefreshPending],
  );

  // 拒否からの変更・取消は管理者のみ(サーバも 403)。透かし(screen-protection)と同じく
  // useSession の role を使う(F12 の permissions 配列に role は載らないため)。
  const { data: authSession } = useSession();
  const isAdmin =
    (authSession?.user as { role?: string } | undefined)?.role === "admin";

  const canWrite = useMemo(
    () =>
      effectivePermissions.some(
        (p) => p.resource === "property" && p.action === "write" && p.granted,
      ),
    [effectivePermissions],
  );

  // 反響メモの変更はフィールドレベル owner_note の edit/full(サーバも 403)。
  // 無いユーザーにはメモ入力自体を出さない(必ず失敗するUIを出さない方針)。
  const canWriteNote = useMemo(
    () =>
      effectivePermissions.some(
        (p) =>
          p.resource === "owner_note" &&
          (p.action === "edit" || p.action === "full") &&
          p.granted,
      ),
    [effectivePermissions],
  );

  // @codex #367 P2: 権限は画面に居たまま変わり得る(復帰時の再検証)。開いたままの
  // 追加フォーム・反響エディタが権限剥奪後も残ると、送信できて 403 になる。
  // **state を effect で消すのではなく描画条件を権限から導出**する(effect 内の同期
  // setState は eslint 規約で禁止・derive の方が取りこぼしが無い)。
  // 権限が戻れば開いていた状態に復帰する(state は保持したまま隠すだけ)。
  const formOpen = canWrite && showForm;
  const editingLogId = canWrite ? editingReactionId : null;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/properties/${propertyId}/dm-logs?page=${page}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(
          body?.error?.message ?? "送付履歴の取得に失敗しました",
        );
      }
      const json = (await res.json()) as DmLogsResponse;
      setLogs(json.data);
      setPagination(json.pagination);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "送付履歴の取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleSaveReaction = async (
    logId: string,
    status: ReactionStatus,
    reactedAt: string,
    note: string,
    clearNote: boolean,
  ) => {
    if (savingReaction) return;
    setSavingReaction(true);
    setError(null);
    setInfo(null);
    try {
      // note: 省略=変更なし / null=消す / 文字列=上書き(サーバ仕様と対)。
      // @codex #367 P2: 編集中にメモ権限が外れた場合(復帰時の再検証で剥奪を検知)は
      // メモを一切送らない。送るとサーバが 403 で弾き、**反響の種別・日付の保存まで
      // 巻き添えで失敗する**。権限のある部分だけ保存できるようにする。
      const noteFields = !canWriteNote
        ? {}
        : clearNote
          ? { note: null as string | null }
          : note.trim()
            ? { note: note.trim() }
            : {};
      const result = await updatePropertyDmLogReaction(propertyId, logId, {
        status,
        ...(reactedAt ? { reactedAt } : {}),
        ...noteFields,
      });
      // 宛先不明の物件連動はサーバが行う。結果を平易な日本語で伝える。
      if (result.undeliverableLinked) {
        setInfo(
          "宛先不明として記録し、この物件をDM送付の対象から外しました(DM可否=送らない)",
        );
      } else if (result.undeliverableCleared) {
        setInfo(
          "宛先不明の記録がなくなったため、物件の宛先不明フラグを解除しました(DM可否は手動で戻してください)",
        );
      } else if (result.reactionStatus !== status) {
        // 売却DM側の証拠(返戻・LPアクセス)が優先されたケース
        setInfo("売却DM側の記録があるため、反響は自動判定の値になりました");
      }
      setEditingReactionId(null);
      fetchLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "反響の保存に失敗しました");
    } finally {
      setSavingReaction(false);
    }
  };

  const handleDelete = async (logId: string) => {
    if (!window.confirm("この送付記録を取り消しますか？")) return;
    try {
      await deletePropertyDmLog(propertyId, logId);
      // ページの最後の1件を消したら前のページへ戻る(#364 R4: 範囲外ページの再取得は
      // 空配列になり「送付履歴はまだありません」に取り残される)。setPage が再取得を起こす。
      if (logs.length === 1 && page > 1) {
        setPage((p) => Math.max(1, p - 1));
      } else {
        fetchLogs();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消に失敗しました");
    }
  };

  return (
    <div data-pii-protected data-pii-surface="property">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">DM 送付履歴</h1>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            記録を追加
          </button>
        )}
      </div>

      {formOpen && (
        <CreateLogForm
          propertyId={propertyId}
          onCreated={() => {
            setShowForm(false);
            fetchLogs();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {error && (
        <div className="mb-4 rounded-md border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {info && (
        <div className="mb-4 rounded-md border border-blue-200 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/10 p-4 text-sm text-blue-700 dark:text-blue-300">
          {info}
        </div>
      )}

      {canWrite && (
        <p className="mb-4 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            返事や返送があったら「反響」に記録してください。「拒否」「宛先不明」にすると、
            その相手は宛名CSVの出力時に検出され、送付の対象から外れます
            (宛先不明は物件のDM可否も自動で「送らない」になります)。
          </span>
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400 dark:text-gray-500">
          <Mail className="h-8 w-8 mb-2" />
          <p className="text-sm">送付履歴はまだありません</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    送付日
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    何通目
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    方法
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    種別
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    反響
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    送信者
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">メモ</th>
                  {canWrite && <th className="w-10 px-2 py-2" aria-label="操作" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {/* sentAt は API が UTC 基準の YYYY-MM-DD で返す（日付のみ・TZ ずれ防止）。 */}
                      {log.sentAt}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {log.sequence > 0 ? `${log.sequence}通目` : "-"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.method ? (
                        dmMethodLabel(log.method)
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.dmType ? (
                        dmTypeLabel(log.dmType)
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingLogId === log.id ? (
                        <ReactionEditor
                          log={log}
                          canWriteNote={canWriteNote}
                          isAdmin={isAdmin}
                          saving={savingReaction}
                          onSave={(status, reactedAt, note, clearNote) =>
                            handleSaveReaction(
                              log.id,
                              status,
                              reactedAt,
                              note,
                              clearNote,
                            )
                          }
                          onCancel={() => setEditingReactionId(null)}
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              REACTION_BADGE_COLORS[log.reactionStatus] ??
                              REACTION_BADGE_COLORS.no_response
                            }`}
                            title={
                              [
                                log.reactedAt ?? "",
                                log.reactionNote ?? "",
                              ]
                                .filter(Boolean)
                                .join(" ") || undefined
                            }
                          >
                            {REACTION_LABELS[
                              log.reactionStatus as ReactionStatus
                            ] ?? log.reactionStatus}
                            {/* 売却DMの返戻・LPアクセスからの自動同期 */}
                            {log.reactionSource === "sale_dm_sync" && "(自動)"}
                          </span>
                          {canWrite && (
                            <button
                              type="button"
                              onClick={() => setEditingReactionId(log.id)}
                              className="rounded px-1 py-0.5 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
                            >
                              記録
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.sentBy?.name ?? (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                      {log.note ?? <span className="text-gray-300 dark:text-gray-600">-</span>}
                    </td>
                    {canWrite && (
                      <td className="px-2 py-2">
                        {/* 売却DM由来・一括確定由来はサーバが 409 で拒否するため、ボタン自体を出さない(#364 R6)。 */}
                        {log.deletable && (
                          <button
                            type="button"
                            onClick={() => handleDelete(log.id)}
                            className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:text-gray-500 dark:hover:bg-red-500/10"
                            title="この記録を取り消す"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">全 {pagination.total} 件</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex items-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs disabled:opacity-40"
                >
                  <ChevronLeft className="h-3 w-3" />
                  前へ
                </button>
                <span className="text-xs text-gray-600 dark:text-gray-300">
                  {page} / {pagination.totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="flex items-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs disabled:opacity-40"
                >
                  次へ
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
