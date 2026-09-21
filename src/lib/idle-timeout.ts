/**
 * 無操作アイドルタイムアウトの上限(ミリ秒)。
 *
 * ⚠元は `src/components/auth/idle-session-guard.tsx`("use client")にあったが、
 * `src/lib/edit-lock/rules.ts`(→ `service.ts` → Task 5-6 のサーバ route handler)が
 * この値を必要とする。クライアント専用モジュール(react・next-auth/react を引き込む)を
 * サーバ側バンドルへ引きずり込まないよう、依存の無いプレーンなモジュールへ抜き出した。
 * `idle-session-guard.tsx` は同名で re-export するので、既存の import 経路
 * (`@/components/auth/idle-session-guard`)からの利用は変わらない。
 */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 無操作 1 時間でログアウト
