/**
 * /uploads/[...path] Phase B: entity-level 権限判定。
 *
 * 要求 key を fileUrl の正規化結果と完全一致で DB 逆引きし、
 * Photo / Attachment / Property のスコープに基づいて 200 / 403 / 404 のいずれを
 * 返すべきかを決定する。
 *
 * 重要:
 *  - key 形式から propertyId / buildingId を推定しない。逆引き結果のみを使う。
 *  - 既存データに残る legacy 絶対 URL や query 付きを取りこぼさないため、
 *    DB 検索は `contains: key` で候補を絞り、JS 側で fileUrl を正規化して
 *    storage key を抽出し直してから完全一致を判定する。
 *  - duplicate fileUrl collision (caller-supplied fileUrl で同じ key が
 *    別物件にも登録されたケース) を bypass にしないため、findFirst を使わず
 *    全候補を評価する: forbidden > ok > not_found の優先順で決着する。
 *  - 既存 Property API のスコープ (field_staff = createdBy or assignedTo) に揃える。
 *  - isDeleted の Attachment は not_found 扱い（active 候補があれば active 側で決まる）。
 */

import prismaDefault from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { isValidStorageKey } from "@/lib/storage/key-validation";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

type PrismaLike = typeof prismaDefault;

export type UploadAuthDecision = "ok" | "forbidden" | "not_found";

export interface AuthorizeUploadAccessArgs {
  key: string;
  session: ApiSession;
  permissions: PermissionEntry[];
  prisma?: PrismaLike;
  /**
   * S1b-4: download intent（/uploads?download=1）。registry PDF(type="registry") の
   * 場合に registry_pdf:download も要求するかどうかの gate に使う。既定 false（preview 扱い）。
   */
  downloadIntent?: boolean;
}

const UPLOADS_PREFIX = "/uploads/";

/**
 * Prisma `contains` は SQL LIKE / ILIKE に変換される。`%` / `_` が wildcard
 * として解釈されると、authenticated user が `key` に `%` / `_` を仕込んで
 * 広範囲スキャンを誘発し DoS / latency 悪化を引き起こせる。
 *
 * 既存 `isValidStorageKey` は `%` / `_` を許可（traversal / `\` のみ拒否）
 * しているため、DB 側に渡す値は escape して LIKE-literal にする。
 *
 * PostgreSQL の LIKE のデフォルト escape は `\`。順序重要:
 *   1. `\`  → `\\`   （後段の `\%` / `\_` を二重 escape しないため最初に処理）
 *   2. `%`  → `\%`
 *   3. `_`  → `\_`
 */
export function escapePrismaLikePattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * DB 保存された fileUrl から storage key を取り出す。
 *
 * 受理する例:
 *   "/uploads/foo/bar.jpg"                          → "foo/bar.jpg"
 *   "/uploads/foo/bar.jpg?v=1"                      → "foo/bar.jpg"
 *   "/uploads/foo/bar.jpg#hash"                     → "foo/bar.jpg"
 *   "http://host/uploads/foo/bar.jpg"               → "foo/bar.jpg"
 *   "https://host/uploads/foo/bar.jpg?v=1"          → "foo/bar.jpg"
 *
 * 拒否 (null) する例:
 *   data: / blob: / file: スキーマ
 *   /api/... など /uploads/ 以外のパス
 *   traversal を含むなど isValidStorageKey 不合格
 */
export function extractStorageKeyFromFileUrl(
  fileUrl: string | null | undefined,
): string | null {
  if (typeof fileUrl !== "string") return null;
  const s = fileUrl.trim();
  if (s === "") return null;

  // data: / blob: / file: は対象外（自前 storage に存在しない参照）
  if (/^(data|blob|file):/i.test(s)) return null;

  let pathPart: string;
  if (s.startsWith("/")) {
    pathPart = s.split(/[?#]/)[0];
  } else {
    try {
      const u = new URL(s);
      pathPart = u.pathname;
    } catch {
      return null;
    }
  }

  if (!pathPart.startsWith(UPLOADS_PREFIX)) return null;

  const key = pathPart.slice(UPLOADS_PREFIX.length);
  if (key === "") return null;
  if (!isValidStorageKey(key)) return null;
  return key;
}

export async function authorizeUploadAccess(
  args: AuthorizeUploadAccessArgs,
): Promise<UploadAuthDecision> {
  const { key, session, permissions, downloadIntent = false } = args;
  const db: PrismaLike = args.prisma ?? prismaDefault;

  if (!isValidStorageKey(key)) return "forbidden";

  // DB 候補絞り込みは LIKE-literal で。最終判定は下の JS 側で正規化 key の
  // 完全一致を要求するため、escape 漏れがあっても認可 bypass にはならないが、
  // wildcard を含む key で広範囲スキャンが起きる経路自体を塞ぐ。
  const escapedKey = escapePrismaLikePattern(key);
  const decisions: UploadAuthDecision[] = [];

  const photos = await db.propertyPhoto.findMany({
    where: { fileUrl: { contains: escapedKey } },
    select: { propertyId: true, fileUrl: true },
  });
  for (const p of photos) {
    if (extractStorageKeyFromFileUrl(p.fileUrl) !== key) continue;
    decisions.push(
      await authorizePropertyAccess(p.propertyId, session, permissions, db),
    );
  }

  const buildingPhotos = await db.buildingPhoto.findMany({
    where: { fileUrl: { contains: escapedKey } },
    select: { buildingId: true, fileUrl: true },
  });
  for (const b of buildingPhotos) {
    if (extractStorageKeyFromFileUrl(b.fileUrl) !== key) continue;
    decisions.push(
      hasPermission(permissions, "property", "read") ? "ok" : "forbidden",
    );
  }

  // 現地調査ピン写真 (Phase 1-H)。property / attachment 認可とは独立に判定する。
  // own pin = field_survey:read で閲覧可。他人 pin = read_all または manage で閲覧可。
  // fileUrl / thumbnailUrl のどちらの /uploads key でも認可する。
  const pinPhotos = await db.fieldSurveyPinPhoto.findMany({
    where: {
      OR: [
        { fileUrl: { contains: escapedKey } },
        { thumbnailUrl: { contains: escapedKey } },
      ],
    },
    select: {
      fileUrl: true,
      thumbnailUrl: true,
      pin: { select: { staffUserId: true } },
    },
  });
  for (const pp of pinPhotos) {
    const matches =
      extractStorageKeyFromFileUrl(pp.fileUrl) === key ||
      extractStorageKeyFromFileUrl(pp.thumbnailUrl) === key;
    if (!matches) continue;
    decisions.push(authorizeFieldSurveyPinPhoto(pp.pin, session, permissions));
  }

  const attachments = await db.attachment.findMany({
    where: { fileUrl: { contains: escapedKey } },
    select: {
      isDeleted: true,
      targetType: true,
      targetId: true,
      propertyId: true,
      fileUrl: true,
      type: true,
    },
  });
  for (const a of attachments) {
    if (extractStorageKeyFromFileUrl(a.fileUrl) !== key) continue;
    if (a.isDeleted) {
      decisions.push("not_found");
      continue;
    }
    // S1b-4: 謄本PDF(type="registry") は registry_pdf 権限で gate する。
    //  - registry_pdf:preview が無ければバイトを一切返さない（hard boundary）。
    //  - download intent(?download=1) の場合は registry_pdf:download も要求する。
    // これは下の property/owner scope とは独立に AND で課す（OK の場合は
    // 続けて従来の targetType scope 判定も適用される）。
    if (a.type === "registry") {
      if (!hasPermission(permissions, "registry_pdf", "preview")) {
        decisions.push("forbidden");
        continue;
      }
      if (downloadIntent && !hasPermission(permissions, "registry_pdf", "download")) {
        decisions.push("forbidden");
        continue;
      }
    }
    if (a.targetType === "property") {
      const propertyId = a.propertyId ?? a.targetId;
      decisions.push(
        await authorizePropertyAccess(propertyId, session, permissions, db),
      );
      continue;
    }
    if (a.targetType === "owner") {
      decisions.push(
        hasPermission(permissions, "owner", "read") ? "ok" : "forbidden",
      );
      continue;
    }
    // 未知 targetType は安全側で forbidden（bypass 防止）
    decisions.push("forbidden");
  }

  // 優先順: forbidden > ok > not_found
  if (decisions.some((d) => d === "forbidden")) return "forbidden";
  if (decisions.some((d) => d === "ok")) return "ok";
  return "not_found";
}

function authorizeFieldSurveyPinPhoto(
  pin: { staffUserId: string } | null,
  session: ApiSession,
  permissions: PermissionEntry[],
): UploadAuthDecision {
  // pin 行が消えている (cascade 前の orphan 等) は not_found 扱い。
  if (!pin) return "not_found";
  if (!hasPermission(permissions, "field_survey", "read")) return "forbidden";
  if (pin.staffUserId === session.id) return "ok";
  if (
    hasPermission(permissions, "field_survey", "read_all") ||
    hasPermission(permissions, "field_survey", "manage")
  ) {
    return "ok";
  }
  return "forbidden";
}

async function authorizePropertyAccess(
  propertyId: string,
  session: ApiSession,
  permissions: PermissionEntry[],
  db: PrismaLike,
): Promise<UploadAuthDecision> {
  if (!hasPermission(permissions, "property", "read")) return "forbidden";

  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: { createdBy: true, assignedTo: true },
  });
  if (!property) return "not_found";

  if (
    session.role === "field_staff" &&
    property.createdBy !== session.id &&
    property.assignedTo !== session.id
  ) {
    return "forbidden";
  }
  return "ok";
}

/**
 * S1b-4: serve 用メタ。/uploads が 200 配信する直前に「この key が registry PDF か」を
 * 判定し、Content-Disposition / Cache-Control / 監査に必要な最小情報を返す。
 *
 * 重要: これは **access 判定をしない**。authorizeUploadAccess が既に許可した前提で、
 * 表示用ヘッダと監査のためだけに使う（registry の hard boundary は authorizeUploadAccess 側）。
 * active な registry 添付が key に一致しなければ null（= 非 registry として従来挙動）。
 */
export interface RegistryServeMeta {
  isRegistry: true;
  attachmentId: string;
  propertyId: string | null;
}

export async function resolveRegistryServeMeta(
  key: string,
  prisma?: PrismaLike,
): Promise<RegistryServeMeta | null> {
  const db: PrismaLike = prisma ?? prismaDefault;
  if (!isValidStorageKey(key)) return null;

  const escapedKey = escapePrismaLikePattern(key);
  const attachments = await db.attachment.findMany({
    where: { fileUrl: { contains: escapedKey } },
    select: {
      id: true,
      type: true,
      propertyId: true,
      targetId: true,
      fileUrl: true,
      isDeleted: true,
    },
  });
  for (const a of attachments) {
    if (a.isDeleted) continue;
    if (extractStorageKeyFromFileUrl(a.fileUrl) !== key) continue;
    if (a.type === "registry") {
      return {
        isRegistry: true,
        attachmentId: a.id,
        propertyId: a.propertyId ?? a.targetId ?? null,
      };
    }
  }
  return null;
}
