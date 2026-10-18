import { z } from "zod";
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { isOwnerPiiDocumentType } from "@/lib/uploads-authorization";

/** 資料送付の上限(spec §2.2・§6)。相手のメールの受け取りが多くは 20〜25MB で止まるため合計 20MB。 */
export const MATERIAL_SEND_LIMITS = { maxTotalBytes: 20 * 1024 * 1024, maxFiles: 20, subject: 200, body: 10_000 } as const;

export const REGISTRY_WARNING = "所有者の名前・住所が載っています。送ってよい相手か確かめてください";

export type MaterialAttachmentRow = {
  id: string;
  targetType: string;
  targetId: string;
  type: string;
  isDeleted: boolean;
  fileName: string;
  fileSize: number;
  fileUrl: string;
  mimeType: string;
  createdAt: Date;
};

/** 送ってよい種類(許可リスト)。⚠所有者の個人情報が載った書類は種類が増えても isOwnerPiiDocumentType で外す。 */
const SENDABLE_TYPES: ReadonlySet<string> = new Set(["general", "registry"]);

/** その物件の、送ってよい添付か(spec §3)。画面の一覧と送信の両方がこれを通す。 */
export function selectableForMaterialSend(a: MaterialAttachmentRow, propertyId: string, perms: PermissionEntry[]): boolean {
  if (a.isDeleted || a.targetType !== "property" || a.targetId !== propertyId) return false;
  if (isOwnerPiiDocumentType(a.type) || !SENDABLE_TYPES.has(a.type)) return false;
  // 謄本を送る=写しを渡す=ダウンロードと同じ扱い(uploads-authorization の preview+download と同じ線)。
  if (a.type === "registry") {
    return hasPermission(perms, "registry_pdf", "preview") && hasPermission(perms, "registry_pdf", "download");
  }
  return true;
}

export type MaterialSelectionResult =
  | { ok: true; rows: MaterialAttachmentRow[]; totalSize: number }
  | { ok: false; code: "NOT_SELECTABLE" | "TOO_LARGE" | "NO_FILES" | "TOO_MANY" };

/** 送信の直前に、DB から読み直した行で頼まれた ID を確かめる(1つでもだめなら何も送らない)。 */
export function checkMaterialSelection(
  rows: MaterialAttachmentRow[],
  requestedIds: string[],
  propertyId: string,
  perms: PermissionEntry[],
): MaterialSelectionResult {
  if (requestedIds.length === 0) return { ok: false, code: "NO_FILES" };
  if (requestedIds.length > MATERIAL_SEND_LIMITS.maxFiles) return { ok: false, code: "TOO_MANY" };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked: MaterialAttachmentRow[] = [];
  for (const id of requestedIds) {
    const r = byId.get(id);
    if (!r || !selectableForMaterialSend(r, propertyId, perms)) return { ok: false, code: "NOT_SELECTABLE" };
    picked.push(r);
  }
  const totalSize = picked.reduce((s, r) => s + r.fileSize, 0);
  if (totalSize > MATERIAL_SEND_LIMITS.maxTotalBytes) return { ok: false, code: "TOO_LARGE" };
  return { ok: true, rows: picked, totalSize };
}

export const DEFAULT_MATERIAL_SUBJECT = "【資料送付】{物件名}";
export const DEFAULT_MATERIAL_BODY = [
  "{会社名}",
  "{担当者名} 様",
  "",
  "お世話になっております。",
  "お問い合わせいただきました「{物件名}」の資料をお送りいたします。",
  "ご確認のほど、よろしくお願いいたします。",
  "",
  "{自分の名前}",
].join("\n");

/** 差し込みは決まった4つだけ。知らない {…} はそのまま残す。 */
export function fillMaterialTemplate(
  tpl: string,
  v: { propertyName: string; companyName: string; contactName: string | null; senderName: string },
): string {
  const map: Record<string, string> = {
    "{物件名}": v.propertyName,
    "{会社名}": v.companyName,
    "{担当者名}": v.contactName?.trim() || "ご担当者",
    "{自分の名前}": v.senderName,
  };
  return tpl.replace(/\{(物件名|会社名|担当者名|自分の名前)\}/g, (m) => map[m]);
}

export function propertyDisplayName(p: { name: string | null; roomNo: string | null; town: string | null }): string {
  const name = p.name?.trim();
  if (name) return p.roomNo ? `${name} ${p.roomNo}` : name;
  return p.town?.trim() || "物件";
}

/** 宛先は正しい形式のアドレス1件だけ(カンマ・セミコロン・改行・表示名つきは受けない=ヘッダ注入の多層防御)。 */
export function isSingleAddress(to: string): boolean {
  if (/[\r\n,;<>\s]/.test(to)) return false;
  return z.string().email().max(254).safeParse(to).success;
}

/** 改行・タブ以外の制御文字を含まない(メールに目に見えない文字を混ぜない・メール設定のひな形と同じ決まり)。 */
export function isPlainMailText(v: string): boolean {
  return [...v].every((c) => {
    const n = c.charCodeAt(0);
    return n >= 0x20 ? n !== 0x7f : n === 0x0a || n === 0x0d || n === 0x09;
  });
}

export const SENDING_STALE_MS = 10 * 60 * 1000;

export function sendStateLabel(
  row: { result: "sending" | "sent" | "failed"; createdAt: Date | string },
  now: Date,
): "送信中" | "結果不明" | "送信済み" | "送れなかった" {
  if (row.result === "sent") return "送信済み";
  if (row.result === "failed") return "送れなかった";
  return now.getTime() - new Date(row.createdAt).getTime() > SENDING_STALE_MS ? "結果不明" : "送信中";
}
