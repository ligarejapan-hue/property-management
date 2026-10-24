/**
 * ドライブの見回り(第2段b)の本番の部品をつなぐ。timer の実行口(/api/drive/sync-run)から呼ぶ。
 */
import prisma from "@/lib/prisma";
import { DRIVE_CONNECTION_ID, getDriveClient, invalidateTokenCache } from "./connection";
import { syncOneLink } from "./sync-link";
import { createSyncRepo } from "./sync-repo";
import type { RunDeps } from "./sync-run";

export function liveRunDeps(now: () => Date = () => new Date()): RunDeps {
  return {
    async loadConnection() {
      const row = await prisma.driveConnection.findUnique({
        where: { id: DRIVE_CONNECTION_ID },
        select: { refreshTokenEnc: true, connectedById: true },
      });
      if (!row?.refreshTokenEnc) return { connected: false, uploaderId: null };
      const user = row.connectedById
        ? await prisma.user.findFirst({ where: { id: row.connectedById, isActive: true }, select: { id: true } })
        : null;
      return { connected: true, uploaderId: user?.id ?? null };
    },
    async loadLinks() {
      return prisma.propertyDriveFolder.findMany({
        select: { id: true, propertyId: true, folderId: true },
        orderBy: { createdAt: "asc" },
      });
    },
    getDrive: () => getDriveClient(),
    makeRepo: (uploaderId) => createSyncRepo(uploaderId),
    syncLink: syncOneLink,
    async saveStatus(s) {
      // ⚠見回りの途中で接続が切られていたら書かない(切ったあとに古い結果を残さない)
      await prisma.driveConnection.updateMany({
        where: { id: DRIVE_CONNECTION_ID, refreshTokenEnc: { not: null } },
        data: s.ok
          ? { lastSyncAt: now(), lastError: null, consecutiveFailures: 0 }
          : { lastError: s.error, consecutiveFailures: { increment: 1 } },
      });
    },
    forgetToken: invalidateTokenCache,
  };
}
