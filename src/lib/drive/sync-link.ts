/**
 * ドライブの見回り(第2段b)の1物件分。紐づけたフォルダの中だけを見て、
 * ①写しの名前合わせ ②アプリ→ドライブの複製 ③ドライブ→アプリの取り込み、の順に行う。
 * DB と保存場所の読み書きは `SyncRepo` に任せる(ここは手順だけ=偽物の repo でテストする)。
 * ⚠ファイル名・フォルダ名は所有者名を含み得る=戻り値・例外にはコードと件数だけを入れる。
 * ⚠削除・移動は同期しない。人が置いたファイル・フォルダの名前は変えない。
 */
import { createHash } from "node:crypto";
import { docStageOfKind, type DocStageCode } from "@/lib/doc-classify/classify";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { DriveApiError, FOLDER_MIME, type DriveItem } from "./client";
import {
  outFileName,
  pickStageFolder,
  placementForRelPath,
  shouldCopyOut,
  skipReasonForDriveFile,
  stageFolderNameForCreate,
  type Placement,
} from "./sync-plan";

export type DriveFiles = {
  listChildren(folderId: string): Promise<DriveItem[]>;
  download(fileId: string): Promise<Buffer>;
  createFolder(parentId: string, name: string): Promise<string>;
  uploadFile(args: {
    parentId: string;
    name: string;
    mimeType: string;
    body: Buffer;
    appProperties: Record<string, string>;
  }): Promise<{ id: string; md5: string | null }>;
  rename(fileId: string, name: string): Promise<void>;
  /** 紐づけたフォルダがまだあるか(消された・ゴミ箱なら null か trashed)。 */
  getFolder(id: string): Promise<{ trashed: boolean } | null>;
};

/** 紐づけたフォルダが消された・ゴミ箱に入った(見回り全体の「一部のフォルダを読めませんでした」に数える)。 */
export class LinkedFolderMissingError extends Error {
  constructor() {
    super("linked_folder_missing");
    this.name = "LinkedFolderMissingError";
  }
}

export type LinkInfo = { id: string; propertyId: string; folderId: string };

export type LedgerRow = {
  driveFileId: string;
  md5: string | null;
  direction: string;
  status: string;
  name: string;
  attachmentId: string | null;
  modifiedTime: Date | null;
};

export type OutCandidate = {
  id: string;
  type: string;
  docKind: string | null;
  docStage: string | null;
  docTitle: string | null;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
  isDeleted: boolean;
  driveFileId: string | null;
};

export type LedgerWrite = {
  linkId: string;
  item: Pick<DriveItem, "id" | "name" | "mimeType" | "md5" | "size" | "modifiedTime">;
  direction: "in" | "out";
  status: "imported" | "inbox" | "photo" | "duplicate" | "unsupported" | "failed" | "copied" | "matched";
  attachmentId?: string | null;
  error?: string | null;
};

export interface SyncRepo {
  ledger(linkId: string): Promise<LedgerRow[]>;
  /** 複製の候補(型 general・未削除・まだ写しが無い)と、写し済みの添付(名前合わせ用)。 */
  attachmentsForLink(propertyId: string): Promise<{ toCopy: OutCandidate[]; copied: OutCandidate[] }>;
  readAttachment(fileUrl: string): Promise<Buffer | null>;
  /** 添付に写しの id を付け、台帳に out を書く(同じ添付に既に付いていれば何もしない=false)。 */
  markCopied(attachmentId: string, write: LedgerWrite): Promise<boolean>;
  /** 添付に、台帳に既にあるドライブのファイルの id を付けるだけ(台帳は変えない)。 */
  linkExisting(attachmentId: string, driveFileId: string): Promise<boolean>;
  renameLedger(driveFileId: string, name: string): Promise<void>;
  record(write: LedgerWrite): Promise<void>;
  /**
   * 取り込み3種。⚠台帳の行(`ledger`)は**取り込みと同じ tx で**書く=取り込めたのに台帳が無い
   * (次の見回りでもう一度取り込む)状態を作らない。添付の行の id は台帳の attachmentId に入れる。
   */
  importAttachment(link: LinkInfo, item: DriveItem, body: Buffer, stageHint: DocStageCode | null, ledger: LedgerWrite): Promise<string>;
  importInbox(link: LinkInfo, item: DriveItem, body: Buffer, ledger: LedgerWrite): Promise<void>;
  importPhoto(link: LinkInfo, item: DriveItem, body: Buffer, ledger: LedgerWrite): Promise<void>;
}

export type LinkResult = {
  renamed: number;
  copied: number;
  matched: number;
  imported: number;
  inbox: number;
  photos: number;
  skipped: number;
  failed: number;
};

export const emptyLinkResult = (): LinkResult => ({
  renamed: 0,
  copied: 0,
  matched: 0,
  imported: 0,
  inbox: 0,
  photos: 0,
  skipped: 0,
  failed: 0,
});

/** 読み書きの回数の上限(1回の見回りで全物件合わせて)。 */
export type Budget = { transfers: number };

export type TreeFile = { item: DriveItem; relPath: string[] };

/** 紐づけたフォルダの中を最大3階層まで見る(フォルダは最大 50 個まで開く)。 */
export async function walkLinkedFolder(
  drive: Pick<DriveFiles, "listChildren">,
  folderId: string,
  opts: { maxDepth?: number; maxFolders?: number } = {},
): Promise<{ direct: DriveItem[]; files: TreeFile[] }> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxFolders = opts.maxFolders ?? 50;
  const files: TreeFile[] = [];
  let direct: DriveItem[] = [];
  const queue: { id: string; relPath: string[] }[] = [{ id: folderId, relPath: [] }];
  let opened = 0;
  while (queue.length > 0 && opened < maxFolders) {
    const cur = queue.shift()!;
    opened++;
    const children = await drive.listChildren(cur.id);
    if (cur.relPath.length === 0) direct = children.filter((c) => c.mimeType === FOLDER_MIME);
    for (const c of children) {
      if (c.mimeType === FOLDER_MIME) {
        if (cur.relPath.length < maxDepth) queue.push({ id: c.id, relPath: [...cur.relPath, c.name] });
      } else {
        files.push({ item: c, relPath: cur.relPath });
      }
    }
  }
  return { direct, files };
}

function isAuthError(e: unknown): boolean {
  return e instanceof DriveApiError && e.needsReconnect;
}

function errorCode(e: unknown): string {
  if (e instanceof DriveApiError) return `drive_${e.status}`;
  return "error";
}

function md5Of(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

function parseTime(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 台帳にあるファイルは見ない。ただし失敗したものは、ドライブ側で更新されていればもう一度。 */
function alreadyHandled(row: LedgerRow | undefined, item: DriveItem): boolean {
  if (!row) return false;
  if (row.status !== "failed") return true;
  const m = parseTime(item.modifiedTime);
  return !(m && row.modifiedTime && m.getTime() > row.modifiedTime.getTime());
}

/**
 * 1物件分の見回り。認可切れ(401)は投げ直す(見回り全体を止めて「再接続が必要です」にする)。
 * それ以外の1件ごとの失敗は台帳に failed として残し、続ける。
 */
export async function syncOneLink(
  drive: DriveFiles,
  repo: SyncRepo,
  link: LinkInfo,
  budget: Budget,
): Promise<LinkResult> {
  const r = emptyLinkResult();
  // 一覧の問い合わせは、消されたフォルダでも「空」を返す=先に在るかを確かめる(消えたら知らせる)
  const root = await drive.getFolder(link.folderId);
  if (!root || root.trashed) throw new LinkedFolderMissingError();
  const tree = await walkLinkedFolder(drive, link.folderId);
  const ledger = await repo.ledger(link.id);
  const ledgerById = new Map(ledger.map((l) => [l.driveFileId, l]));
  // 中身がアプリにあるもの(失敗・形式外の行は数えない=失敗したファイルを「重複」にしない)
  const knownMd5 = new Set(
    ledger.filter((l) => l.status !== "failed" && l.status !== "unsupported").map((l) => l.md5).filter((m): m is string => !!m),
  );
  const subfolders = [...tree.direct];
  const { toCopy, copied } = await repo.attachmentsForLink(link.propertyId);

  // ① 写しの名前合わせ(種類を直して名前が変わったもの・アプリが置いた写しだけ)
  for (const a of copied) {
    if (!a.driveFileId) continue;
    const row = ledgerById.get(a.driveFileId);
    if (!row || row.direction !== "out" || row.status !== "copied") continue;
    const want = outFileName(a);
    if (row.name === want) continue;
    try {
      await drive.rename(a.driveFileId, want);
      await repo.renameLedger(a.driveFileId, want);
      r.renamed++;
    } catch (e) {
      if (isAuthError(e)) throw e;
      r.failed++;
    }
  }

  // ② アプリ → ドライブ(複製)
  const driveByMd5 = new Map<string, DriveItem>();
  for (const f of tree.files) if (f.item.md5 && f.item.appSource !== "app") driveByMd5.set(f.item.md5, f.item);
  for (const a of toCopy) {
    if (!shouldCopyOut(a)) continue;
    // 前の見回りで置けたのに記録できなかった写し(目印にこの添付の id)があれば、置き直さずに結ぶ
    const orphan = tree.files.find(
      (f) => f.item.appSource === "app" && f.item.appAttachmentId === a.id && !ledgerById.has(f.item.id),
    )?.item;
    if (orphan) {
      try {
        if (await repo.markCopied(a.id, { linkId: link.id, item: orphan, direction: "out", status: "copied", attachmentId: a.id })) {
          ledgerById.set(orphan.id, { driveFileId: orphan.id, md5: orphan.md5, direction: "out", status: "copied", name: orphan.name, attachmentId: a.id, modifiedTime: null });
          if (orphan.md5) knownMd5.add(orphan.md5);
          r.copied++;
        }
      } catch {
        r.failed++;
      }
      continue;
    }
    if (budget.transfers <= 0) break;
    budget.transfers--;
    try {
      const body = await repo.readAttachment(a.fileUrl);
      if (!body) {
        r.failed++;
        continue;
      }
      const md5 = md5Of(body);
      const same = driveByMd5.get(md5);
      if (same && !ledgerById.has(same.id)) {
        // 人が同じ中身をドライブに置いてある=複製しない(その人のファイルを写しとして結ぶだけ・名前は変えない)
        if (await repo.markCopied(a.id, { linkId: link.id, item: same, direction: "out", status: "matched", attachmentId: a.id })) {
          ledgerById.set(same.id, { driveFileId: same.id, md5, direction: "out", status: "matched", name: same.name, attachmentId: a.id, modifiedTime: null });
          knownMd5.add(md5);
          r.matched++;
        }
        continue;
      }
      if (same) {
        // ドライブから取り込んだもの(受け取り箱から添付した など)=原本がドライブにある。複製し直さない
        if (await repo.linkExisting(a.id, same.id)) r.matched++;
        continue;
      }
      const stage = (docStageOfKind(a.docKind) ?? (a.docStage as DocStageCode | null)) || null;
      let folder = pickStageFolder(subfolders, stage);
      if (!folder) {
        const id = await drive.createFolder(link.folderId, stageFolderNameForCreate(stage));
        folder = { id, name: stageFolderNameForCreate(stage), mimeType: FOLDER_MIME, md5: null, size: null, modifiedTime: null, appSource: null };
        subfolders.push(folder);
      }
      const name = outFileName(a);
      const up = await drive.uploadFile({
        parentId: folder.id,
        name,
        mimeType: a.mimeType,
        body,
        appProperties: { pmSource: "app", pmAttachmentId: a.id },
      });
      const item = { id: up.id, name, mimeType: a.mimeType, md5: up.md5 ?? md5, size: body.length, modifiedTime: null };
      if (await repo.markCopied(a.id, { linkId: link.id, item, direction: "out", status: "copied", attachmentId: a.id })) {
        ledgerById.set(up.id, { driveFileId: up.id, md5: item.md5, direction: "out", status: "copied", name, attachmentId: a.id, modifiedTime: null });
        if (item.md5) knownMd5.add(item.md5);
        r.copied++;
      }
    } catch (e) {
      if (isAuthError(e)) throw e;
      r.failed++;
    }
  }

  // ③ ドライブ → アプリ(取り込み)
  for (const { item, relPath } of tree.files) {
    if (alreadyHandled(ledgerById.get(item.id), item)) continue;
    const skip = skipReasonForDriveFile(item, { knownMd5 });
    if (skip === "app_copy") continue;
    if (skip) {
      await repo.record({ linkId: link.id, item, direction: "in", status: skip });
      ledgerById.set(item.id, { driveFileId: item.id, md5: item.md5, direction: "in", status: skip, name: item.name, attachmentId: null, modifiedTime: parseTime(item.modifiedTime) });
      r.skipped++;
      continue;
    }
    if (budget.transfers <= 0) break;
    budget.transfers--;
    let placement: Placement = placementForRelPath(relPath, item.mimeType);
    if (placement.kind === "photo" && (item.size ?? 0) > MAX_FILE_SIZE) placement = { kind: "attach", stageHint: null };
    try {
      const body = await drive.download(item.id);
      if (placement.kind === "inbox") {
        await repo.importInbox(link, item, body, { linkId: link.id, item, direction: "in", status: "inbox" });
        r.inbox++;
      } else if (placement.kind === "photo") {
        await repo.importPhoto(link, item, body, { linkId: link.id, item, direction: "in", status: "photo" });
        r.photos++;
      } else {
        await repo.importAttachment(link, item, body, placement.stageHint, { linkId: link.id, item, direction: "in", status: "imported" });
        r.imported++;
      }
      if (item.md5) knownMd5.add(item.md5);
    } catch (e) {
      if (isAuthError(e)) throw e;
      await repo.record({ linkId: link.id, item, direction: "in", status: "failed", error: errorCode(e) });
      r.failed++;
    }
  }
  return r;
}
