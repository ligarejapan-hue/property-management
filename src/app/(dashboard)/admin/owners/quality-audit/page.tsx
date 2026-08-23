"use client";

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import { Loader2, AlertTriangle, ExternalLink, Wand2 } from "lucide-react";
import type {
  OwnerNameIssueCode,
  OwnerNameKanaIssueCode,
  OwnerNameQualitySummary,
} from "@/lib/owner-name-quality";
import type {
  OwnerContactIssueCode,
  OwnerContactSummary,
} from "@/lib/owner-contact-format";
import {
  NAME_TYPE_OPTIONS,
  CONTACT_TYPE_OPTIONS,
  NAME_ISSUE_LABEL,
  CONTACT_ISSUE_LABEL,
  formatFixableFields,
  escapeControlForAudit,
  effectiveRecommendedAction,
  type NameFilterType,
  type ContactFilterType,
  type ContactField,
} from "@/lib/owner-quality-audit-ui";

// ---- route 応答に対応するクライアント型 ----
type NameRec = "hold" | "review" | "sanitize_candidate";
type ContactRec = "hold" | "review" | "format_candidate";
type NameSeverity = "error" | "warning" | "info";
type ContactSeverity = "warning" | "info";

interface NameRow {
  ownerId: string;
  ownerNameMasked: string | null;
  nameKanaMasked: string | null;
  issues: OwnerNameIssueCode[];
  kanaIssues: OwnerNameKanaIssueCode[];
  severity: NameSeverity | null;
  blockReasons: string[];
  recommendedAction: NameRec;
  version: number;
  detailUrl: string;
}
interface ContactRow {
  ownerId: string;
  zipMasked: string | null;
  currentZipMasked: string | null;
  currentZipIssues: OwnerContactIssueCode[];
  phoneMasked: string | null;
  issues: OwnerContactIssueCode[];
  severity: ContactSeverity | null;
  blockReasons: string[];
  recommendedAction: ContactRec;
  version: number;
  detailUrl: string;
}
interface NameApiResponse {
  type: string;
  candidates: NameRow[];
  summary: OwnerNameQualitySummary;
  hasNextPage: boolean;
  nextCursor: string | null;
  truncated: boolean;
}
interface ContactApiResponse {
  type: string;
  candidates: ContactRow[];
  summary: OwnerContactSummary;
  hasNextPage: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

type Tab = "name" | "contact";
type ViewData =
  | { tab: "name"; candidates: NameRow[]; summary: OwnerNameQualitySummary }
  | { tab: "contact"; candidates: ContactRow[]; summary: OwnerContactSummary };

// 自動補正（preview→apply）の対象。name=サニタイズ / contact=フィールド整形。
type PendingFix =
  | { kind: "name"; ownerId: string; version: number }
  | { kind: "contact"; ownerId: string; version: number; field: ContactField };

function fixKey(f: PendingFix): string {
  return f.kind === "contact" ? `${f.ownerId}:contact:${f.field}` : `${f.ownerId}:name`;
}

const SEVERITY_CLASS: Record<NameSeverity, string> = {
  error: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

const REC_BADGE: Record<NameRec | ContactRec, { label: string; cls: string }> = {
  sanitize_candidate: { label: "自動補正可", cls: "bg-emerald-100 text-emerald-700" },
  format_candidate: { label: "整形可", cls: "bg-emerald-100 text-emerald-700" },
  review: { label: "要確認", cls: "bg-amber-100 text-amber-700" },
  hold: { label: "保留", cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
};

export default function QualityAuditPage() {
  const [tab, setTab] = useState<Tab>("name");
  const [type, setType] = useState<NameFilterType | ContactFilterType>("all");
  const [view, setView] = useState<ViewData | null>(null);
  const [meta, setMeta] = useState<{
    hasNextPage: boolean;
    nextCursor: string | null;
    truncated: boolean;
  }>({ hasNextPage: false, nextCursor: null, truncated: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 1 行ぶんの preview（dryRun 結果）。fixKey で対象行を識別する。
  const [preview, setPreview] = useState<{
    fix: PendingFix;
    eligible: boolean;
    blockReasons: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // 競合 load の stale 応答ガード（tab/type 切替が重なっても最新の応答のみ反映）。
  const loadIdRef = useRef(0);
  // apply 後の reload が「現在の」tab/type を参照するための ref。handleApply のクロージャは
  // click 時点の tab/type を捕捉するため、apply 実行中にタブ/フィルタが切り替わると古いタブを
  // reload してしまい、それが reqId 競争に勝って view.tab 不一致（空表・誤ページング）を起こす
  // （Codex P2）。最新値を ref に保持し reload は常に現タブ/現フィルタを対象にする。
  const tabRef = useRef(tab);
  const typeRef = useRef(type);
  tabRef.current = tab;
  typeRef.current = type;

  const load = useCallback(
    async (
      targetTab: Tab,
      targetType: string,
      cursor: string | null,
      append: boolean,
    ) => {
      const reqId = ++loadIdRef.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadingMore(false);
        setError(null);
      }
      try {
        const endpoint =
          targetTab === "name"
            ? "name-quality-candidates"
            : "contact-quality-candidates";
        const qs = new URLSearchParams({ type: targetType, limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/admin/owners/${endpoint}?${qs.toString()}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.error?.message ?? `取得に失敗しました (${res.status})`,
          );
        }
        if (targetTab === "name") {
          const json: NameApiResponse = await res.json();
          if (reqId !== loadIdRef.current) return; // stale 応答は破棄
          setView((prev) =>
            append && prev?.tab === "name"
              ? {
                  tab: "name",
                  candidates: [...prev.candidates, ...json.candidates],
                  summary: prev.summary,
                }
              : { tab: "name", candidates: json.candidates, summary: json.summary },
          );
          setMeta({
            hasNextPage: json.hasNextPage,
            nextCursor: json.nextCursor,
            truncated: json.truncated,
          });
        } else {
          const json: ContactApiResponse = await res.json();
          if (reqId !== loadIdRef.current) return;
          setView((prev) =>
            append && prev?.tab === "contact"
              ? {
                  tab: "contact",
                  candidates: [...prev.candidates, ...json.candidates],
                  summary: prev.summary,
                }
              : {
                  tab: "contact",
                  candidates: json.candidates,
                  summary: json.summary,
                },
          );
          setMeta({
            hasNextPage: json.hasNextPage,
            nextCursor: json.nextCursor,
            truncated: json.truncated,
          });
        }
      } catch (err) {
        if (reqId !== loadIdRef.current) return;
        setError(err instanceof Error ? err.message : "取得に失敗しました");
        if (!append) {
          // 全リロード（type/tab 切替）失敗時は古い view/meta を残さない。残すと新フィルタ下に
          // 旧候補と旧 cursor が再表示され、stale な結果から preview/apply できてしまう（Codex P2）。
          // append（もっと読み込む）失敗時は既存行が有効なので view は保持する。
          setView(null);
          setMeta({ hasNextPage: false, nextCursor: null, truncated: false });
        }
      } finally {
        if (reqId === loadIdRef.current) {
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    setPreview(null);
    load(tab, type, null, false);
  }, [tab, type, load]);

  function switchTab(t: Tab) {
    if (t === tab) return;
    setView(null);
    setActionError(null);
    setType("all"); // type は tab 依存ゆえリセット
    setTab(t);
  }

  // dryRun preview（name=sanitize / contact=format）。
  async function handlePreview(fix: PendingFix) {
    setBusy(true);
    setActionError(null);
    try {
      const url =
        fix.kind === "name"
          ? `/api/admin/owners/${fix.ownerId}/correction/name-fix`
          : `/api/admin/owners/${fix.ownerId}/correction/contact-fix`;
      const body =
        fix.kind === "name"
          ? { version: fix.version, mode: "sanitize", dryRun: true }
          : { version: fix.version, field: fix.field, mode: "format", dryRun: true };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error?.message ?? `プレビューに失敗しました (${res.status})`);
      }
      setPreview({
        fix,
        eligible: json?.eligible === true,
        blockReasons: Array.isArray(json?.blockReasons) ? json.blockReasons : [],
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "プレビューに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  // apply（dryRun=false）。409 等の編集衝突は actionError にそのまま表示し、最新を再取得。
  async function handleApply() {
    if (!preview) return;
    const { fix } = preview;
    setBusy(true);
    setActionError(null);
    try {
      const url =
        fix.kind === "name"
          ? `/api/admin/owners/${fix.ownerId}/correction/name-fix`
          : `/api/admin/owners/${fix.ownerId}/correction/contact-fix`;
      const body =
        fix.kind === "name"
          ? { version: fix.version, mode: "sanitize", dryRun: false }
          : { version: fix.version, field: fix.field, mode: "format", dryRun: false };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        const reasons = Array.isArray(json?.error?.blockReasons)
          ? json.error.blockReasons.join(", ")
          : "";
        throw new Error(
          (json?.error?.message ?? `適用に失敗しました (${res.status})`) +
            (reasons ? `（${reasons}）` : ""),
        );
      }
      setPreview(null);
      await load(tabRef.current, typeRef.current, null, false); // 現タブを再取得（version 変化・行消失反映）
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "適用に失敗しました");
      setPreview(null);
      await load(tabRef.current, typeRef.current, null, false); // 現タブを再取得（409 後の version ズレ対応）
    } finally {
      setBusy(false);
    }
  }

  const typeOptions = tab === "name" ? NAME_TYPE_OPTIONS : CONTACT_TYPE_OPTIONS;

  function summaryCount(summaryKey: string): number | null {
    if (!view || view.tab !== tab) return null;
    const s = view.summary as unknown as Record<string, number>;
    return typeof s[summaryKey] === "number" ? s[summaryKey] : null;
  }

  function renderRecBadge(rec: NameRec | ContactRec) {
    const b = REC_BADGE[rec];
    return (
      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${b.cls}`}>
        {b.label}
      </span>
    );
  }

  function renderIssueBadge(label: string, severity: NameSeverity | null) {
    return (
      <span
        key={label}
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
          severity ? SEVERITY_CLASS[severity] : SEVERITY_CLASS.info
        }`}
      >
        {label}
      </span>
    );
  }

  // 1 つの自動補正アクション（preview→apply）のセル。
  function renderFixCell(fix: PendingFix, label: string) {
    const key = fixKey(fix);
    if (preview && fixKey(preview.fix) === key) {
      if (preview.eligible) {
        return (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleApply}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              適用
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPreview(null)}
              className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              取消
            </button>
          </span>
        );
      }
      return (
        <span className="flex items-center gap-2 text-xs text-amber-700">
          適用不可{preview.blockReasons.length > 0 ? `: ${preview.blockReasons.join(", ")}` : ""}
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            取消
          </button>
        </span>
      );
    }
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => handlePreview(fix)}
        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <Wand2 className="h-3 w-3" />
        {label}
      </button>
    );
  }

  function detailLink(href: string) {
    return (
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
      >
        <ExternalLink className="h-3 w-3" />
        詳細
      </Link>
    );
  }

  const nameRows = view?.tab === "name" ? view.candidates : [];
  const contactRows = view?.tab === "contact" ? view.candidates : [];
  const viewMatches = view?.tab === tab;
  const currentRowCount = tab === "name" ? nameRows.length : contactRows.length;
  // 空表示は「全件確認済みで該当ゼロ」のときだけ。truncated 窓で候補ゼロ + hasNextPage の
  // ときは「該当なし」ではなく continue-scanning（Codex P2: 後続窓を見落とさせない）。
  const showContinue =
    !loading && viewMatches && currentRowCount === 0 && meta.hasNextPage;
  const isEmpty =
    !loading && viewMatches && currentRowCount === 0 && !meta.hasNextPage;

  return (
    <div className="min-h-screen bg-gray-50 p-6 dark:bg-gray-900">
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin/users" className="hover:text-gray-700 dark:hover:text-gray-200">
          管理
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">氏名・連絡先チェック</span>
      </nav>

      <PageHeader
        title="氏名・連絡先チェック"
        description="所有者の氏名・氏名カナ（DQ-01）と郵便番号・電話（DQ-02）について、品質に問題がある値を一覧します。サーバ側でマスクされた値のみ表示します。各行はプレビュー→適用で補正できます（自動補正できないものは「詳細」から手当てしてください）。"
      />

      {/* タブ */}
      <div className="mb-4 flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {(["name", "contact"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            {t === "name" ? "氏名品質（DQ-01）" : "連絡先（DQ-02）"}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {actionError}
        </div>
      )}

      {/* 種別フィルタ（件数は最新スキャン窓の集計） */}
      <div className="mb-4 flex flex-wrap gap-1">
        {typeOptions.map((opt) => {
          const count =
            opt.summaryKey != null ? summaryCount(opt.summaryKey) : null;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setType(opt.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                type === opt.value
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {opt.label}
              {count != null ? `（${count}）` : ""}
            </button>
          );
        })}
      </div>

      {meta.truncated && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            走査が上限に達したため、全件は確認できていません（「もっと読み込む」で続きを取得できます）。
          </span>
        </div>
      )}

      <div
        className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900"
        data-pii-protected
        data-pii-surface="owner"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-gray-500" />
          </div>
        ) : showContinue ? (
          <div className="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            この走査窓には該当がありませんでした。後続の走査窓が残っています。下の「もっと読み込む」で続きを確認してください。
          </div>
        ) : isEmpty ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            品質に問題のある値は見つかりませんでした（権限により一部フィールドは監査対象外の場合があります）。
          </div>
        ) : tab === "name" ? (
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {["所有者", "氏名", "氏名カナ", "検出", "推奨", "操作"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-800 dark:bg-gray-900">
              {nameRows.map((row) => (
                <tr key={row.ownerId} className="align-top hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-3 text-sm">
                    <Link
                      href={row.detailUrl}
                      className="font-mono text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      {row.ownerId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-900 break-all dark:text-gray-100">
                    {row.ownerNameMasked == null ? (
                      <span className="text-gray-400 dark:text-gray-500">（非表示）</span>
                    ) : (
                      escapeControlForAudit(row.ownerNameMasked)
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-700 break-all dark:text-gray-200">
                    {row.nameKanaMasked == null ? (
                      <span className="text-gray-300 dark:text-gray-600">—</span>
                    ) : (
                      escapeControlForAudit(row.nameKanaMasked)
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap gap-1">
                      {row.issues.map((c) =>
                        renderIssueBadge(NAME_ISSUE_LABEL[c], row.severity),
                      )}
                      {row.kanaIssues.map((c) =>
                        renderIssueBadge(NAME_ISSUE_LABEL[c], row.severity),
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {renderRecBadge(
                      effectiveRecommendedAction(
                        row.recommendedAction,
                        row.blockReasons,
                      ),
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-3">
                      {effectiveRecommendedAction(
                        row.recommendedAction,
                        row.blockReasons,
                      ) === "sanitize_candidate" &&
                        renderFixCell(
                          { kind: "name", ownerId: row.ownerId, version: row.version },
                          "サニタイズ",
                        )}
                      {detailLink(row.detailUrl)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {[
                  "所有者",
                  "郵便番号（登記上）",
                  "郵便番号（現住所）",
                  "電話",
                  "検出",
                  "推奨",
                  "操作",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-800 dark:bg-gray-900">
              {contactRows.map((row) => {
                const fixableFields = formatFixableFields(row.issues);
                return (
                  <tr key={row.ownerId} className="align-top hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-3 text-sm">
                      <Link
                        href={row.detailUrl}
                        className="font-mono text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                      >
                        {row.ownerId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-900 break-all dark:text-gray-100">
                      {row.zipMasked == null ? (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      ) : (
                        escapeControlForAudit(row.zipMasked)
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-900 break-all dark:text-gray-100">
                      {row.currentZipMasked == null ? (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      ) : (
                        escapeControlForAudit(row.currentZipMasked)
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-900 break-all dark:text-gray-100">
                      {row.phoneMasked == null ? (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      ) : (
                        escapeControlForAudit(row.phoneMasked)
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex flex-wrap gap-1">
                        {row.issues.map((c) =>
                          renderIssueBadge(CONTACT_ISSUE_LABEL[c], row.severity),
                        )}
                        {row.currentZipIssues.map((c) =>
                          renderIssueBadge(
                            `現住所: ${CONTACT_ISSUE_LABEL[c]}`,
                            row.severity,
                          ),
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                    {renderRecBadge(
                      effectiveRecommendedAction(
                        row.recommendedAction,
                        row.blockReasons,
                      ),
                    )}
                  </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-3">
                        {effectiveRecommendedAction(
                          row.recommendedAction,
                          row.blockReasons,
                        ) === "format_candidate" &&
                          fixableFields.map((field) => (
                            <Fragment key={field}>
                              {renderFixCell(
                                {
                                  kind: "contact",
                                  ownerId: row.ownerId,
                                  version: row.version,
                                  field,
                                },
                                field === "zip" ? "郵便番号を整形" : "電話を整形",
                              )}
                            </Fragment>
                          ))}
                        {detailLink(row.detailUrl)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {meta.hasNextPage && !loading && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => load(tab, type, meta.nextCursor, true)}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            もっと読み込む
          </button>
        </div>
      )}
    </div>
  );
}
