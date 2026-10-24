/**
 * Google ドライブ連携の接続(DB の drive_connection 1行)。
 * - refresh token は暗号化して保存(secret-crypto・メール設定のパスワードと同じ守り)。
 * - access token はメモリに短時間だけ(プロセス内・期限の1分前に捨てる)。
 * ⚠トークンを API の応答・監査・ログに出さない。
 */
import prisma from "@/lib/prisma";
import { decryptSecret, encryptSecret, isSecretCryptoConfigured } from "@/lib/sale-dm-letter/secret-crypto";
import { getDriveClientConfig, getDriveRedirectUri, getOauthStateSecret } from "./config";
import { DriveAuthError, refreshAccessToken } from "./oauth";
import { DriveClient } from "./client";

export const DRIVE_CONNECTION_ID = "singleton";

export type DriveConnectionStatus = {
  connected: boolean;
  accountEmail: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** 接続に必要な設定が揃っているか(クライアント ID/シークレット・戻り先・暗号化キー・state の秘密)。 */
  clientConfigured: boolean;
  cryptoConfigured: boolean;
  redirectUri: string | null;
  linkedFolderCount: number;
};

export async function loadDriveConnectionStatus(): Promise<DriveConnectionStatus> {
  const [row, linkedFolderCount] = await Promise.all([
    prisma.driveConnection.findUnique({ where: { id: DRIVE_CONNECTION_ID } }),
    prisma.propertyDriveFolder.count(),
  ]);
  const connected = !!row?.refreshTokenEnc;
  return {
    connected,
    accountEmail: connected ? (row?.accountEmail ?? null) : null,
    connectedAt: connected && row?.connectedAt ? row.connectedAt.toISOString() : null,
    lastSyncAt: row?.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row?.lastError ?? null,
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    clientConfigured: getDriveClientConfig() !== null && getDriveRedirectUri() !== null && getOauthStateSecret() !== null,
    cryptoConfigured: isSecretCryptoConfigured(),
    redirectUri: getDriveRedirectUri(),
    linkedFolderCount,
  };
}

export async function saveDriveConnection(args: { accountEmail: string; refreshToken: string; userId: string; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const enc = encryptSecret(args.refreshToken);
  await prisma.driveConnection.upsert({
    where: { id: DRIVE_CONNECTION_ID },
    create: {
      id: DRIVE_CONNECTION_ID,
      accountEmail: args.accountEmail,
      refreshTokenEnc: enc,
      startPageToken: null,
      lastError: null,
      consecutiveFailures: 0,
      connectedById: args.userId,
      connectedAt: now,
    },
    update: {
      accountEmail: args.accountEmail,
      refreshTokenEnc: enc,
      startPageToken: null, // 接続し直し=見回りの続きの位置は取り直す
      lastError: null,
      consecutiveFailures: 0,
      connectedById: args.userId,
      connectedAt: now,
    },
  });
  cachedAccessToken = null;
}

export async function clearDriveConnection(): Promise<void> {
  await prisma.driveConnection.updateMany({
    where: { id: DRIVE_CONNECTION_ID },
    data: { refreshTokenEnc: null, startPageToken: null, lastError: null, consecutiveFailures: 0 },
  });
  cachedAccessToken = null;
}

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

/** 有効なアクセストークン(メモリの控え→無ければ refresh)。未接続は DriveAuthError(not_connected)。 */
export async function getDriveAccessToken(fetchFn: typeof fetch = fetch, nowMs: number = Date.now()): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAtMs - 60_000 > nowMs) return cachedAccessToken.token;
  const cfg = getDriveClientConfig();
  if (!cfg) throw new DriveAuthError("not_configured", "Google ドライブのクライアント設定(app.env)がありません");
  const row = await prisma.driveConnection.findUnique({ where: { id: DRIVE_CONNECTION_ID }, select: { refreshTokenEnc: true } });
  if (!row?.refreshTokenEnc) throw new DriveAuthError("not_connected", "Google ドライブに接続されていません");
  const refreshToken = decryptSecret(row.refreshTokenEnc);
  const r = await refreshAccessToken({ refreshToken, clientId: cfg.clientId, clientSecret: cfg.clientSecret }, fetchFn);
  cachedAccessToken = { token: r.accessToken, expiresAtMs: nowMs + r.expiresInSec * 1000 };
  return r.accessToken;
}

export async function getDriveClient(fetchFn: typeof fetch = fetch): Promise<DriveClient> {
  return new DriveClient(await getDriveAccessToken(fetchFn), fetchFn);
}

/** テスト用: メモリの控えを捨てる。 */
export function __resetDriveTokenCacheForTest(): void {
  cachedAccessToken = null;
}
