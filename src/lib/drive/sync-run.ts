/**
 * ドライブの見回り 全体(第2段b)。紐づけた物件を順に回り、1回の読み書きは全体で上限まで。
 * 前回の続きの物件から回る(上限で毎回同じ物件だけにならない)。
 * 結果は接続の行(最後の見回り・エラー・連続失敗)に残し、管理 › ドライブ連携に出す。
 * ⚠戻り値・エラーの文には件数とコードだけ(ファイル名・フォルダ名は入れない)。
 */
import { DriveApiError } from "./client";
import { DriveAuthError } from "./oauth";
import { emptyLinkResult, type Budget, type DriveFiles, type LinkInfo, type LinkResult, type SyncRepo } from "./sync-link";

export type RunDeps = {
  /** connected=refresh token がある / uploaderId=接続した管理者(有効な人だけ・無効なら null)。 */
  loadConnection(): Promise<{ connected: boolean; uploaderId: string | null }>;
  loadLinks(): Promise<LinkInfo[]>;
  getDrive(): Promise<DriveFiles>;
  makeRepo(uploaderId: string): SyncRepo;
  syncLink(drive: DriveFiles, repo: SyncRepo, link: LinkInfo, budget: Budget): Promise<LinkResult>;
  saveStatus(s: { ok: boolean; error: string | null }): Promise<void>;
  forgetToken?: () => void;
};

export type RunResult = {
  skipped?: "not_connected" | "not_configured";
  links: number;
  linkErrors: number;
  totals: LinkResult;
  nextStartAt: number;
};

export const RECONNECT_MESSAGE = "Google ドライブへの再接続が必要です";

function isReconnect(e: unknown): boolean {
  return (e instanceof DriveApiError || e instanceof DriveAuthError) && e.needsReconnect;
}

function add(a: LinkResult, b: LinkResult): LinkResult {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof LinkResult)[]) out[k] += b[k];
  return out;
}

export async function runDriveSync(deps: RunDeps, opts: { budget: number; startAt: number }): Promise<RunResult> {
  const result: RunResult = { links: 0, linkErrors: 0, totals: emptyLinkResult(), nextStartAt: opts.startAt };
  const conn = await deps.loadConnection();
  if (!conn.connected) return { ...result, skipped: "not_connected" };
  if (!conn.uploaderId) {
    await deps.saveStatus({ ok: false, error: "接続した管理者が無効です。管理者がつなぎ直してください" });
    return result;
  }

  let drive: DriveFiles;
  try {
    drive = await deps.getDrive();
  } catch (e) {
    if (e instanceof DriveAuthError && e.code === "not_configured") return { ...result, skipped: "not_configured" };
    if (isReconnect(e)) {
      deps.forgetToken?.();
      await deps.saveStatus({ ok: false, error: RECONNECT_MESSAGE });
      return result;
    }
    throw e;
  }

  const links = await deps.loadLinks();
  const repo = deps.makeRepo(conn.uploaderId);
  const budget: Budget = { transfers: opts.budget };
  const n = links.length;
  const start = n === 0 ? 0 : ((opts.startAt % n) + n) % n;
  let i = 0;
  for (; i < n && budget.transfers > 0; i++) {
    const link = links[(start + i) % n];
    result.links++;
    try {
      result.totals = add(result.totals, await deps.syncLink(drive, repo, link, budget));
    } catch (e) {
      if (isReconnect(e)) {
        deps.forgetToken?.();
        await deps.saveStatus({ ok: false, error: RECONNECT_MESSAGE });
        return { ...result, nextStartAt: (start + i) % Math.max(n, 1) };
      }
      result.linkErrors++;
    }
  }
  result.nextStartAt = n === 0 ? 0 : (start + i) % n;
  await deps.saveStatus(
    result.linkErrors === 0
      ? { ok: true, error: null }
      : { ok: false, error: `一部のフォルダを読めませんでした(${result.linkErrors}件)` },
  );
  return result;
}
