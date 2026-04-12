"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Check,
  Loader2,
  Calendar,
  Trash2,
  ClipboardList,
} from "lucide-react";
import {
  fetchNextActions as apiFetchNextActions,
  fetchUsers as apiFetchUsers,
  createNextAction,
  updateNextAction,
  deleteNextAction,
} from "@/lib/api-client";

interface ActionData {
  id: string;
  propertyId: string;
  content: string;
  actionType: string | null;
  scheduledAt: string;
  isCompleted: boolean;
  completedAt: string | null;
  assignee: { id: string; name: string };
  creator: { id: string; name: string };
  createdAt: string;
}

export default function NextActionTab({
  propertyId,
}: {
  propertyId: string;
}) {
  const [actions, setActions] = useState<ActionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const fetchActions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await apiFetchNextActions(propertyId, showCompleted);
      setActions(json.data as ActionData[]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "アクション取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId, showCompleted]);

  useEffect(() => {
    fetchActions();
  }, [fetchActions]);

  const toggleComplete = async (action: ActionData) => {
    try {
      await updateNextAction(propertyId, action.id, { isCompleted: !action.isCompleted });
      fetchActions();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "更新に失敗しました",
      );
    }
  };

  const handleDeleteAction = async (actionId: string) => {
    try {
      await deleteNextAction(propertyId, actionId);
      fetchActions();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "削除に失敗しました",
      );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            追加
          </button>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded border-gray-300"
            />
            完了済みも表示
          </label>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {showForm && (
        <CreateActionForm
          propertyId={propertyId}
          onCreated={() => {
            setShowForm(false);
            fetchActions();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {actions.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <ClipboardList className="h-8 w-8 mb-2" />
          <p className="text-sm">アクションはまだありません</p>
        </div>
      ) : (
        <div className="space-y-2">
          {actions.map((action) => {
            const isOverdue =
              !action.isCompleted &&
              new Date(action.scheduledAt) < new Date();
            return (
              <div
                key={action.id}
                className={`flex items-start gap-3 rounded-md border p-3 ${
                  action.isCompleted
                    ? "border-gray-200 bg-gray-50 opacity-60"
                    : isOverdue
                      ? "border-red-200 bg-red-50"
                      : "border-gray-200 bg-white"
                }`}
              >
                <button
                  onClick={() => toggleComplete(action)}
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                    action.isCompleted
                      ? "border-green-500 bg-green-500 text-white"
                      : "border-gray-300 hover:border-blue-400"
                  }`}
                >
                  {action.isCompleted && <Check className="h-3 w-3" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-sm ${
                      action.isCompleted
                        ? "line-through text-gray-500"
                        : "text-gray-800"
                    }`}
                  >
                    {action.content}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    {action.actionType && (
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">
                        {action.actionType}
                      </span>
                    )}
                    <span className="flex items-center gap-0.5">
                      <Calendar className="h-3 w-3" />
                      {new Date(action.scheduledAt).toLocaleDateString("ja-JP")}
                    </span>
                    <span>担当: {action.assignee.name}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteAction(action.id)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  title="削除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Create form ----------

function CreateActionForm({
  propertyId,
  onCreated,
  onCancel,
}: {
  propertyId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState("");
  const [actionType, setActionType] = useState("");
  const [scheduledAt, setScheduledAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [assignedTo, setAssignedTo] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch users for assignee dropdown
  useEffect(() => {
    async function loadUsers() {
      try {
        const json = await apiFetchUsers();
        const list = json.data ?? [];
        setUsers(Array.isArray(list) ? list : []);
        if (list.length > 0 && !assignedTo) {
          setAssignedTo(list[0].id);
        }
      } catch {
        // ignore — user can type ID manually
      }
    }
    loadUsers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || !assignedTo) return;

    setSubmitting(true);
    setError(null);

    try {
      await createNextAction(propertyId, {
        content: content.trim(),
        actionType: actionType || null,
        scheduledAt,
        assignedTo,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "作成に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="アクション内容"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <input
            type="text"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            placeholder="種別 (任意: 電話, 訪問, 確認 等)"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <input
            type="date"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="">担当者を選択</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={submitting || !content.trim() || !assignedTo}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "作成中..." : "作成"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
