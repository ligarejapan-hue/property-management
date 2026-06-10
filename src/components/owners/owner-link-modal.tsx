"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import {
  searchOwners,
  createAndLinkOwnerToProperty,
  linkOwnerToProperty,
} from "@/lib/api-client";
import {
  buildCreateAndLinkPayload,
  buildLinkOwnerPayload,
  canSubmitOwnerCreate,
  defaultIsPrimaryForLink,
  isSelectedOwnerSubmittable,
  isLatestSearch,
  type OwnerCreateFormValues,
} from "@/lib/owner-link-utils";

/** 検索 API（GET /api/owners/search）が返す 1 件。owner:read のマスク済み値が来る。 */
interface OwnerSearchHit {
  id: string;
  name: string;
  nameKana: string | null;
  phone: string | null;
  address: string | null;
  externalLinkKey: string | null;
}

type Mode = "search" | "create";

const EMPTY_FORM: OwnerCreateFormValues = {
  name: "",
  nameKana: "",
  phone: "",
  zip: "",
  address: "",
  email: "",
};

/**
 * 物件詳細「所有者を追加」モーダル（owner:write 前提・呼び出し側でゲート）。
 *  - 既存の所有者を紐付け（検索 → 選択 → linkOwnerToProperty）
 *  - 新規作成して紐付け（createAndLinkOwnerToProperty = サーバ側 1 transaction で atomic）
 * 重複作成を避けるため既定は検索モード。氏名のみ必須（他は任意）。
 */
export function OwnerLinkModal({
  propertyId,
  existingOwnerCount,
  onClose,
  onLinked,
}: {
  propertyId: string;
  existingOwnerCount: number;
  onClose: () => void;
  onLinked: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("search");

  // 紐付け共通: 続柄 / 主所有者（最初の 1 人は主所有者を既定 true）
  const [relationship, setRelationship] = useState("");
  const [isPrimary, setIsPrimary] = useState(() =>
    defaultIsPrimaryForLink(existingOwnerCount),
  );

  // 既存検索
  const [searchQ, setSearchQ] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHits, setSearchHits] = useState<OwnerSearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OwnerSearchHit | null>(null);
  // 検索リクエストのシーケンス番号（stale レスポンス破棄用・Codex）
  const searchSeqRef = useRef(0);

  // 新規作成フォーム
  const [form, setForm] = useState<OwnerCreateFormValues>(EMPTY_FORM);

  // 紐付け実行
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 閉じる/アンマウント時に in-flight 検索を無効化する（閉じた後に古い結果を適用しない・Codex）。
  useEffect(() => {
    return () => {
      searchSeqRef.current += 1;
    };
  }, []);

  // 検索 debounce（searchOwners 経由・300ms）
  useEffect(() => {
    // 非検索モードでは in-flight 検索を無効化（seq を進める）して結果を出さない（Codex）。
    if (mode !== "search") {
      searchSeqRef.current += 1;
      return;
    }
    const q = searchQ.trim();
    // 空クエリでも seq を進め、進行中だった古い検索の結果が復活しないようにする（Codex）。
    if (q.length < 1) {
      searchSeqRef.current += 1;
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      // この検索リクエストの seq。解決時に最新でなければ結果を破棄する
      //（後から解決した古い検索が新しいクエリの結果/状態を上書きしない・Codex）。
      searchSeqRef.current += 1;
      const seq = searchSeqRef.current;
      setSearchLoading(true);
      setSearchError(null);
      try {
        const res = await searchOwners(q);
        if (!isLatestSearch(seq, searchSeqRef.current)) return;
        setSearchHits((res?.data ?? []) as OwnerSearchHit[]);
      } catch (e) {
        if (!isLatestSearch(seq, searchSeqRef.current)) return;
        setSearchError(e instanceof Error ? e.message : "検索に失敗しました");
        setSearchHits([]);
      } finally {
        if (isLatestSearch(seq, searchSeqRef.current)) setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQ, mode]);

  // P2(Codex): 検索クエリが変わったら古い選択をクリアする。
  // 別クエリの表示状態で旧 owner を誤って紐付けないため（submit ゲートと二重防御）。
  useEffect(() => {
    setSelected(null);
  }, [searchQ]);

  const createReady = canSubmitOwnerCreate(form);

  const handleLinkExisting = async () => {
    if (!selected) return;
    // P2(Codex): 現在の検索結果に含まれない古い選択では紐付けない（submit 時にも再確認）。
    if (!isSelectedOwnerSubmittable(selected, searchHits)) return;
    setSubmitting(true);
    setError(null);
    try {
      await linkOwnerToProperty(
        propertyId,
        buildLinkOwnerPayload(selected.id, relationship, isPrimary),
      );
      await onLinked();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "紐付けに失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateAndLink = async () => {
    if (!createReady) return;
    setSubmitting(true);
    setError(null);
    try {
      // P1(Codex): owner 作成 + 紐付けをサーバ側 1 transaction で atomic に実行（orphan 防止）。
      await createAndLinkOwnerToProperty(
        propertyId,
        buildCreateAndLinkPayload(form, relationship, isPrimary),
      );
      await onLinked();
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "所有者の作成・紐付けに失敗しました",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    "w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <UserPlus className="h-4 w-4" />
            所有者を追加
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* モード切替 */}
        <div className="mb-3 flex gap-1 rounded-md border border-gray-200 p-1 text-xs">
          <button
            type="button"
            onClick={() => setMode("search")}
            className={`flex-1 rounded px-2 py-1 font-medium ${
              mode === "search"
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            既存の所有者を紐付け
          </button>
          <button
            type="button"
            onClick={() => setMode("create")}
            className={`flex-1 rounded px-2 py-1 font-medium ${
              mode === "create"
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            新規作成して紐付け
          </button>
        </div>

        {mode === "search" ? (
          <div className="space-y-2">
            <label className="block text-xs text-gray-600">所有者を検索</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="氏名 / 電話 / 住所 で検索"
                className={`${inputClass} pl-7`}
              />
            </div>
            {searchLoading && (
              <p className="flex items-center gap-1 text-xs text-gray-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                検索中...
              </p>
            )}
            {searchError && <p className="text-xs text-red-600">{searchError}</p>}
            {!searchLoading && searchHits.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded border border-gray-200">
                {searchHits.map((h) => (
                  <li
                    key={h.id}
                    onClick={() => setSelected(h)}
                    className={`cursor-pointer border-b border-gray-100 px-2 py-1.5 text-xs last:border-b-0 hover:bg-indigo-50 ${
                      selected?.id === h.id ? "bg-indigo-100" : ""
                    }`}
                  >
                    <div className="font-medium text-gray-900">{h.name}</div>
                    <div className="text-[11px] text-gray-500">
                      {[h.nameKana, h.address].filter(Boolean).join(" ")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!searchLoading &&
              searchQ.trim() !== "" &&
              searchHits.length === 0 &&
              !searchError && (
                <p className="text-xs text-gray-500">
                  該当する所有者が見つかりません。「新規作成して紐付け」もご利用ください。
                </p>
              )}
            {selected && (
              <div className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">
                選択中: {selected.name}
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="space-y-1 md:col-span-2">
              <label className="text-xs font-medium text-gray-700">
                氏名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">氏名カナ</label>
              <input
                type="text"
                value={form.nameKana}
                onChange={(e) =>
                  setForm((f) => ({ ...f, nameKana: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">電話番号</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">郵便番号</label>
              <input
                type="text"
                value={form.zip}
                onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className="text-xs font-medium text-gray-700">現住所</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) =>
                  setForm((f) => ({ ...f, address: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className="text-xs font-medium text-gray-700">
                メールアドレス
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className={inputClass}
              />
            </div>
          </div>
        )}

        {/* 共通: 続柄 / 主所有者 */}
        <div className="mt-3 grid grid-cols-1 gap-2 border-t border-gray-100 pt-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">
              続柄・関係（任意）
            </label>
            <input
              type="text"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="例: 本人 / 相続人 / 配偶者"
              className={inputClass}
            />
          </div>
          <label className="flex items-center gap-1.5 self-end pb-1.5 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            主所有者にする
          </label>
        </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          {mode === "search" ? (
            <button
              type="button"
              onClick={handleLinkExisting}
              disabled={submitting || !isSelectedOwnerSubmittable(selected, searchHits)}
              className="rounded bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {submitting ? "紐付け中..." : "この所有者を紐付け"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreateAndLink}
              disabled={submitting || !createReady}
              className="rounded bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {submitting ? "作成中..." : "作成して紐付け"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
