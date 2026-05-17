"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { OWNER_MEMO_BODY_MAX_LENGTH, formatMemoCreatorName } from "@/lib/owner-memo";

interface MemoCreator {
  id: string;
  name: string | null;
  email: string | null;
}

interface OwnerMemo {
  id: string;
  ownerId: string;
  body: string;
  createdAt: string;
  creator: MemoCreator | null;
}

interface OwnerMemoHistoryProps {
  ownerId: string;
  /** owner:write + owner_note full/edit を満たすときのみ true。入力欄を出すか判定。 */
  canCreate: boolean;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function OwnerMemoHistory({ ownerId, canCreate }: OwnerMemoHistoryProps) {
  const [memos, setMemos] = useState<OwnerMemo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fetchMemos = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/owners/${ownerId}/memos`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? "メモ取得に失敗しました");
      }
      const json = (await res.json()) as { memos: OwnerMemo[] };
      setMemos(json.memos ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "メモ取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    fetchMemos();
  }, [fetchMemos]);

  const trimmed = input.trim();
  const overLimit = trimmed.length > OWNER_MEMO_BODY_MAX_LENGTH;
  const canSubmit = canCreate && trimmed.length > 0 && !overLimit && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/owners/${ownerId}/memos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? "メモの保存に失敗しました");
      }
      setInput("");
      await fetchMemos();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "メモの保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <dt className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
        メモ履歴（所有者単位・追記のみ）
      </dt>

      {canCreate && (
        <div className="mb-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="例: 連絡時の様子、相続関係の補足、次回の確認事項など"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            disabled={submitting}
            maxLength={OWNER_MEMO_BODY_MAX_LENGTH + 100}
          />
          <div className="mt-1 flex items-center justify-between">
            <span
              className={`text-xs ${overLimit ? "text-red-600" : "text-gray-500"}`}
            >
              {trimmed.length} / {OWNER_MEMO_BODY_MAX_LENGTH}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {submitting ? "保存中..." : "メモを追加"}
            </button>
          </div>
          {submitError && (
            <p className="mt-1 text-xs text-red-600">{submitError}</p>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          読み込み中...
        </div>
      ) : loadError ? (
        <p className="py-2 text-xs text-red-600">{loadError}</p>
      ) : memos.length === 0 ? (
        <p className="py-2 text-xs text-gray-500">メモ履歴はまだありません</p>
      ) : (
        <ul className="space-y-2">
          {memos.map((m) => (
            <li
              key={m.id}
              className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
            >
              <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500">
                <span className="font-mono">{formatTimestamp(m.createdAt)}</span>
                <span className="text-gray-700">
                  {formatMemoCreatorName(m.creator)}
                </span>
              </div>
              {m.body ? (
                <p className="whitespace-pre-wrap break-words text-sm text-gray-800">
                  {m.body}
                </p>
              ) : (
                <p className="text-xs italic text-gray-400">
                  （本文の閲覧権限がありません）
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
