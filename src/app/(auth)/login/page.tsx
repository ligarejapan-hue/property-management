"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod/v4";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Clock, Eye, EyeOff, FileText } from "lucide-react";
import { writeSharedLastActivity } from "@/lib/session-activity";
import { clearNoticeStorage } from "@/lib/notifications/notice-store";
import { cleanupNotifications } from "@/lib/notifications/sw-client";
import { IDLE_LOGGED_OUT_MESSAGE } from "@/lib/notifications/idle-warning";

/** 通知を閉じられなかったときの案内(共用 PC 対策・設計書 §4.5)。PII は出さない。 */
const CLEANUP_FAILED_MESSAGE = "通知を消せませんでした。ブラウザを閉じて開き直してからログインしてください";

const loginSchema = z.object({
  email: z.email("有効なメールアドレスを入力してください"),
  password: z.string().min(1, "パスワードを入力してください"),
});

type LoginFormData = z.infer<typeof loginSchema>;

/**
 * callbackUrl(A3の再ログイン導線)を同一オリジンの内部パスに限定する(オープンリダイレクト防止・@codex R3/R4)。
 * "/\evil.com"(バックスラッシュ→ブラウザが // に正規化)や "//"(プロトコル相対)、外部URLは、
 * origin 付きで URL を構築し同一オリジン判定することで確実に弾く。
 */
function safeInternalDest(raw: string | null): string {
  const fallback = "/home";
  if (!raw) return fallback;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin === window.location.origin) return url.pathname + url.search + url.hash;
  } catch {
    // 無効な URL は無視してフォールバック
  }
  return fallback;
}

const noopSubscribe = () => () => {};
function readIdleReason(): boolean {
  return new URLSearchParams(window.location.search).get("reason") === "idle";
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false); // C-1 UI総点検: パスワード表示切替
  // 通知 段階1: 無操作でログオフされた場合に理由を出す(/login?reason=idle)。
  const idleLoggedOut = useSyncExternalStore(noopSubscribe, readIdleReason, () => false);

  // 通知 段階1(共用 PC 対策): ログイン画面を開いた時点で、前の人のお知らせと OS の通知を片付ける。
  useEffect(() => {
    clearNoticeStorage();
    void cleanupNotifications();
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    setError(null);

    try {
      // 通知 段階1(共用 PC 対策): 前の人の通知を閉じられたと確認できるまでログインに進まない。
      clearNoticeStorage();
      if (!(await cleanupNotifications())) {
        setError(CLEANUP_FAILED_MESSAGE);
        return;
      }
      const result = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (result?.error) {
        setError("メールアドレスまたはパスワードが正しくありません");
      } else {
        // 認証成功時に「今」を最終操作として seed する。これがないと、前セッションの古い値が
        // 残っている場合にダッシュボード初回マウントで即ログアウトしてしまう(@codex #290 R7 P2)。
        writeSharedLastActivity(Date.now());
        // ログイン必須画面からの再ログイン誘導(A3)で付く callbackUrl を尊重し、元の画面へ戻す(@codex R3/R4)。
        const cb = new URLSearchParams(window.location.search).get("callbackUrl");
        router.push(safeInternalDest(cb));
      }
    } catch {
      setError("ログイン中にエラーが発生しました");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50">
            <FileText className="h-6 w-6 text-indigo-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">物件管理システム</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            アカウントにログインしてください
          </p>
        </div>

        {idleLoggedOut && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{IDLE_LOGGED_OUT_MESSAGE}</p>
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              {...register("email")}
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
              placeholder="user@example.com"
            />
            {errors.email && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {errors.email.message}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              パスワード
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                {...register("password")}
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 pr-10 text-sm text-gray-900 dark:text-gray-100 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                placeholder="パスワードを入力"
              />
              {/* C-1 UI総点検: 入力値を確認できるよう表示/非表示を切り替えられるように。 */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:hover:text-gray-300"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {errors.password && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {errors.password.message}
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3 dark:bg-red-950/40">
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "ログイン中..." : "ログイン"}
          </button>
        </form>
      </div>
    </div>
  );
}
