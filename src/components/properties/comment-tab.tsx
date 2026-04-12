"use client";

import { useState, useEffect, useCallback } from "react";
import { Send, Loader2, MessageCircle, CornerDownRight } from "lucide-react";
import { fetchComments as apiFetchComments, postComment } from "@/lib/api-client";

interface Author {
  id: string;
  name: string;
}

interface CommentData {
  id: string;
  body: string;
  authorId: string;
  createdAt: string;
  author: Author;
  replies: CommentData[];
}

export default function CommentTab({ propertyId }: { propertyId: string }) {
  const [comments, setComments] = useState<CommentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCommentsData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await apiFetchComments(propertyId);
      setComments(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "コメント取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchCommentsData();
  }, [fetchCommentsData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      <CommentForm propertyId={propertyId} onPosted={fetchCommentsData} />

      {comments.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <MessageCircle className="h-8 w-8 mb-2" />
          <p className="text-sm">コメントはまだありません</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              propertyId={propertyId}
              onReplyPosted={fetchCommentsData}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Comment form ----------

function CommentForm({
  propertyId,
  parentId,
  onPosted,
  onCancel,
  placeholder = "コメントを入力...",
}: {
  propertyId: string;
  parentId?: string;
  onPosted: () => void;
  onCancel?: () => void;
  placeholder?: string;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      await postComment(propertyId, body.trim(), parentId);
      setBody("");
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "投稿に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-none"
        />
        <div className="flex flex-col gap-1">
          <button
            type="submit"
            disabled={submitting || !body.trim()}
            className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              取消
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      )}
    </form>
  );
}

// ---------- Comment item ----------

function CommentItem({
  comment,
  propertyId,
  onReplyPosted,
}: {
  comment: CommentData;
  propertyId: string;
  onReplyPosted: () => void;
}) {
  const [showReplyForm, setShowReplyForm] = useState(false);

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-gray-800">
          {comment.author.name}
        </span>
        <span className="text-xs text-gray-400">
          {new Date(comment.createdAt).toLocaleString("ja-JP")}
        </span>
      </div>
      <p className="text-sm text-gray-700 whitespace-pre-wrap">
        {comment.body}
      </p>
      <button
        onClick={() => setShowReplyForm(!showReplyForm)}
        className="mt-2 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
      >
        <CornerDownRight className="h-3 w-3" />
        返信
      </button>

      {/* Replies */}
      {comment.replies?.length > 0 && (
        <div className="mt-3 ml-4 space-y-3 border-l-2 border-gray-100 pl-4">
          {comment.replies.map((reply) => (
            <div key={reply.id}>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-medium text-gray-700">
                  {reply.author.name}
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(reply.createdAt).toLocaleString("ja-JP")}
                </span>
              </div>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">
                {reply.body}
              </p>
            </div>
          ))}
        </div>
      )}

      {showReplyForm && (
        <div className="mt-3 ml-4">
          <CommentForm
            propertyId={propertyId}
            parentId={comment.id}
            onPosted={() => {
              setShowReplyForm(false);
              onReplyPosted();
            }}
            onCancel={() => setShowReplyForm(false)}
            placeholder="返信を入力..."
          />
        </div>
      )}
    </div>
  );
}
