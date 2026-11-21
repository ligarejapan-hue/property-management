/**
 * Google ドライブの物件フォルダを物件へ自動で紐づける(2026-11-21 発注者の依頼・決定)。
 * - 自動にするのは「フォルダ名の建物名+号室が物件1件とぴったり合い、その物件に合うフォルダが1つだけ」のときだけ。
 *   足りないもの(建物名だけ・町名だけ・候補が2つ以上)は今までどおり候補に出して人が紐づける。
 * - 紐づけ済みの物件・フォルダ、一度でも紐づけを外した物件は自動にしない(外した=人が「違う」と決めた)。
 * - 会社のアカウントが持ち主のフォルダだけ(共有されただけのフォルダ・共有ドライブは人が紐づける)。
 * - 「仕入/販売」「〜契約」など中のフォルダは物件フォルダとして扱わない=物件フォルダそのものにつなぐ。
 * - 自動の印=linked_by_id が null(人が紐づけたものは人の id)。
 * ⚠フォルダ名は所有者名を含むことがある=監査ログ・journal・戻り値には件数と id だけ。
 */
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { loadNamedProperties } from "./candidates";
import type { DriveClient } from "./client";
import { matchFolderToProperties, parseFolderName, type MatchableProperty } from "./folder-match";
import { sideOfDriveFolderName, stageOfDriveFolderName } from "./sync-plan";

export type FolderEntry = { id: string; name: string };
export type AutoLinkPlan = { folderId: string; propertyId: string };

/** 1回に作る自動の紐づけの上限(残りは次の回)。 */
export const AUTO_LINK_MAX_PER_RUN = 20;
/** 自動の紐づけの間隔(ドライブ全体のフォルダを読むので、5分ごとの見回りのたびにはしない)。 */
export const AUTO_LINK_INTERVAL_MS = 60 * 60_000;

export function autoLinkDue(lastMs: number, nowMs: number): boolean {
  return nowMs - lastMs >= AUTO_LINK_INTERVAL_MS;
}

/** 自動で紐づける組を決める(純関数)。順番はフォルダの id 順(毎回同じ)。 */
export function planAutoLinks(args: {
  folders: readonly FolderEntry[];
  properties: readonly MatchableProperty[];
  linkedPropertyIds: ReadonlySet<string>;
  linkedFolderIds: ReadonlySet<string>;
  excludedPropertyIds: ReadonlySet<string>;
}): AutoLinkPlan[] {
  const props = [...args.properties];
  const byProperty = new Map<string, string[]>();
  for (const f of args.folders) {
    // 中のフォルダ(仕入/販売・〜契約・写真など)は物件フォルダではない
    if (sideOfDriveFolderName(f.name) !== null || stageOfDriveFolderName(f.name) !== null) continue;
    const parsed = parseFolderName(f.name);
    if (parsed.roomNo === null) continue;
    const exact = matchFolderToProperties(parsed, props).filter((c) => c.reason === "name_room");
    if (exact.length !== 1) continue; // 同じ建物名+号室の物件が2つ以上=人が決める
    const pid = exact[0].propertyId;
    byProperty.set(pid, [...(byProperty.get(pid) ?? []), f.id]);
  }
  const out: AutoLinkPlan[] = [];
  for (const [propertyId, folderIds] of byProperty) {
    if (folderIds.length !== 1) continue; // 同じ物件に合うフォルダが2つ以上=人が決める
    const folderId = folderIds[0];
    if (args.linkedPropertyIds.has(propertyId) || args.excludedPropertyIds.has(propertyId)) continue;
    if (args.linkedFolderIds.has(folderId)) continue;
    out.push({ folderId, propertyId });
  }
  return out.sort((a, b) => (a.folderId < b.folderId ? -1 : a.folderId > b.folderId ? 1 : 0));
}

/** 監査ログの detail から、紐づけを外したことのある物件の id を集める。 */
export function unlinkedPropertyIds(details: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const d of details) {
    if (d && typeof d === "object" && "propertyId" in d) {
      const v = (d as { propertyId: unknown }).propertyId;
      if (typeof v === "string") out.add(v);
    }
  }
  return out;
}

export type AutoLinkResult = { linked: number; planned: number; truncated: boolean };

type Client = Pick<DriveClient, "listAllFolders" | "getFolder" | "folderPath">;

/**
 * 見回りと同じ止め方をしてから自動の紐づけをする: 未接続・接続した管理者が無効(消された・止められた)なら
 * 何もしない(見回り本体も、その間は書類を動かさない・@codex #770)。
 */
export async function autoLinkIfConnected(deps: {
  loadConnection(): Promise<{ connected: boolean; uploaderId: string | null }>;
  getClient(): Promise<Client>;
}): Promise<AutoLinkResult | { skipped: "not_connected" | "inactive_connector" }> {
  const conn = await deps.loadConnection();
  if (!conn.connected) return { skipped: "not_connected" };
  if (!conn.uploaderId) return { skipped: "inactive_connector" };
  return runAutoLink(await deps.getClient());
}

/** 本番: ドライブのフォルダを見て、自動で紐づける。 */
export async function runAutoLink(client: Client): Promise<AutoLinkResult> {
  const listed = await client.listAllFolders();
  const truncated = listed.truncated;
  // ★全部を読み切れなかった回は紐づけない(読めなかったページに同じ物件のフォルダがあると「1つだけ」が崩れる)
  if (truncated) return { linked: 0, planned: 0, truncated: true };
  // ★自動にするのは会社のアカウントが持ち主のフォルダだけ(社外の人が共有してきた同じ名前のフォルダを
  //   勝手につながない=中の書類を物件に取り込まない)。共有されたフォルダは今までどおり人が紐づける
  const folders = listed.folders.filter((f) => f.ownedByMe);
  const [properties, links, unlinkLogs] = await Promise.all([
    loadNamedProperties(),
    prisma.propertyDriveFolder.findMany({ select: { propertyId: true, folderId: true } }),
    prisma.auditLog.findMany({ where: { action: "drive_folder_unlink" }, select: { detail: true } }),
  ]);
  const plan = planAutoLinks({
    folders,
    properties,
    linkedPropertyIds: new Set(links.map((l) => l.propertyId)),
    linkedFolderIds: new Set(links.map((l) => l.folderId)),
    excludedPropertyIds: unlinkedPropertyIds(unlinkLogs.map((l) => l.detail)),
  });
  let linked = 0;
  for (const p of plan.slice(0, AUTO_LINK_MAX_PER_RUN)) {
    const folder = await client.getFolder(p.folderId);
    if (!folder || folder.trashed || !folder.ownedByMe) continue;
    const folderPath = (await client.folderPath(folder.id)) || folder.name;
    try {
      const row = await prisma.propertyDriveFolder.create({
        data: {
          propertyId: p.propertyId,
          folderId: folder.id,
          folderName: folder.name,
          folderPath,
          webViewLink: folder.webViewLink,
          linkedById: null, // 自動の印
        },
        select: { id: true },
      });
      await writeAuditLog({
        userId: null,
        action: "drive_folder_auto_link",
        targetTable: "property_drive_folders",
        targetId: row.id,
        detail: { propertyId: p.propertyId },
      });
      linked++;
    } catch (e) {
      // その間に人が紐づけた(物件・フォルダの一意の鍵)=飛ばす
      if ((e as { code?: string })?.code === "P2002") continue;
      throw e;
    }
  }
  return { linked, planned: plan.length, truncated };
}
