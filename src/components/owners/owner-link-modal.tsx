"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  isExistingLinkedOwner,
  type OwnerCreateFormValues,
} from "@/lib/owner-link-utils";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";

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
  existingOwnerIds,
  onClose,
  onLinked,
}: {
  propertyId: string;
  /** この物件に既に紐付いている owner の id 一覧。検索結果で選択不可にし @@unique 違反(500)を防ぐ。 */
  existingOwnerIds: string[];
  onClose: () => void;
  onLinked: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("search");

  // 紐付け共通: 続柄 / 主所有者（最初の 1 人は主所有者を既定 true）
  const [relationship, setRelationship] = useState("");
  const [isPrimary, setIsPrimary] = useState(() =>
    defaultIsPrimaryForLink(existingOwnerIds.length),
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
  // 住所補完の user-edit signal（Codex P2-G）。住所 input をユーザーが直接編集した時だけ
  // true。候補 apply（onAddressChange）では立てない＝開いた/反映されただけでは検索しない。
  const [addressEdited, setAddressEdited] = useState(false);

  // 紐付け実行
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // stale な検索を全無効化する（seq 前進 + 表示状態リセット）。古い in-flight 検索の結果だけでなく
  // searchLoading / searchError も残らないようにし、「検索中...」のまま固まる/古い error が残るのを防ぐ
  //（Codex）。setState setter と ref は安定なので deps は []。
  const invalidateSearch = useCallback(() => {
    searchSeqRef.current += 1;
    setSearchHits([]);
    setSelected(null);
    setSearchLoading(false);
    setSearchError(null);
  }, []);

  // 閉じる/アンマウント時に in-flight 検索を無効化する（閉じた後に古い結果を適用しない・Codex）。
  useEffect(() => {
    return () => {
      searchSeqRef.current += 1;
    };
  }, []);

  // 検索 debounce（searchOwners 経由・300ms）
  useEffect(() => {
    // query / mode が変わったら、まず stale な検索結果・選択・loading・error を即時クリアする。
    // 非空→非空の変更でも、新しい検索結果が返るまで古い hits を表示・クリック・submit させない（Codex）。
    invalidateSearch();
    if (mode !== "search") return;
    const q = searchQ.trim();
    if (q.length < 1) return;
    // 非空クエリは debounce 中から「検索中...」を出す（古い hits も「該当なし」も出さない）。
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      // この検索リクエストの seq。解決時に最新でなければ結果を破棄する
      //（後から解決した古い検索が新しいクエリの結果/状態を上書きしない・Codex）。
      searchSeqRef.current += 1;
      const seq = searchSeqRef.current;
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
  }, [searchQ, mode, invalidateSearch]);

  // 注: query 変更時の selected クリアは上の effect 先頭の invalidateSearch() が担う
  // （searchQ / mode 変更のたびに hits/selected/loading/error を即時リセット）。

  const createReady = canSubmitOwnerCreate(form);

  const handleLinkExisting = async () => {
    if (!selected) return;
    // P2(Codex): 現在の検索結果に含まれない古い選択では紐付けない（submit 時にも再確認）。
    if (!isSelectedOwnerSubmittable(selected, searchHits, existingOwnerIds))
      return;
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
              <ul
                role="listbox"
                className="max-h-48 overflow-y-auto rounded border border-gray-200"
              >
                {searchHits.map((h) => {
                  // 既にこの物件へ紐付け済みの owner は選択不可（@@unique 違反 500 を UI で防ぐ・Codex）。
                  const linked = isExistingLinkedOwner(h.id, existingOwnerIds);
                  return (
                    <li
                      key={h.id}
                      role="option"
                      aria-selected={selected?.id === h.id}
                      onClick={linked ? undefined : () => setSelected(h)}
                      aria-disabled={linked || undefined}
                      className={`border-b border-gray-100 px-2 py-1.5 text-xs last:border-b-0 ${
                        linked
                          ? "cursor-not-allowed bg-gray-50 text-gray-400"
                          : `cursor-pointer hover:bg-indigo-50 ${
                              selected?.id === h.id ? "bg-indigo-100" : ""
                            }`
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div
                          className={`font-medium ${
                            linked ? "text-gray-400" : "text-gray-900"
                          }`}
                        >
                          {h.name}
                        </div>
                        {linked && (
                          <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            既に紐付け済み
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500">
                        {[h.nameKana, h.address].filter(Boolean).join(" ")}
                      </div>
                    </li>
                  );
                })}
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
                onChange={(e) => {
                  // ユーザーの直接編集＝user-edit signal を立てる（住所検索のトリガー）。
                  setAddressEdited(true);
                  setForm((f) => ({ ...f, address: e.target.value }));
                }}
                className={inputClass}
              />
              {/* 郵便番号⇄住所 補完（社内 route 経由）。候補確定で zip/address をペア反映。
                  onZipChange/onAddressChange は form 更新のみ＝addressEdited は立てない。 */}
              <AddressLookupControls
                zip={form.zip}
                address={form.address}
                onZipChange={(z) => setForm((f) => ({ ...f, zip: z }))}
                onAddressChange={(a) => setForm((f) => ({ ...f, address: a }))}
                addressEdited={addressEdited}
                disabled={submitting}
                mode="both"
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
              disabled={
                submitting ||
                !isSelectedOwnerSubmittable(selected, searchHits, existingOwnerIds)
              }
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
