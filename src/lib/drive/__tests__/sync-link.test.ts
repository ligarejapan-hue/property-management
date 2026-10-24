/**
 * ドライブの見回り 1物件分(第2段b)。偽物のドライブと偽物の repo で、何をどこへ動かすかを確かめる。
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DriveApiError, FOLDER_MIME, type DriveItem } from "../client";
import { LinkedFolderMissingError, syncOneLink, walkLinkedFolder, type DriveFiles, type LedgerRow, type LedgerWrite, type OutCandidate, type SyncRepo } from "../sync-link";

const md5 = (s: string) => createHash("md5").update(Buffer.from(s)).digest("hex");
const folder = (id: string, name: string): DriveItem => ({ id, name, mimeType: FOLDER_MIME, md5: null, size: null, modifiedTime: null, appSource: null });
const file = (id: string, name: string, content: string, extra: Partial<DriveItem> = {}): DriveItem => ({
  id,
  name,
  mimeType: "application/pdf",
  md5: md5(content),
  size: content.length,
  modifiedTime: "2026-10-24T00:00:00.000Z",
  appSource: null,
  ...extra,
});

function fakeDrive(tree: Record<string, DriveItem[]>, contents: Record<string, string> = {}, missing = new Set<string>()) {
  const log: string[] = [];
  let n = 0;
  const drive: DriveFiles = {
    async listChildren(id) {
      return tree[id] ?? [];
    },
    async download(id) {
      log.push(`download:${id}`);
      return Buffer.from(contents[id] ?? "x");
    },
    async createFolder(parent, name) {
      log.push(`mkdir:${parent}/${name}`);
      const id = `newdir${++n}`;
      tree[parent] = [...(tree[parent] ?? []), folder(id, name)];
      return id;
    },
    async uploadFile(a) {
      log.push(`upload:${a.parentId}/${a.name}:${a.appProperties.pmSource}`);
      return { id: `up${++n}`, md5: md5(a.body.toString()) };
    },
    async getFolder(id) {
      return missing.has(id) ? null : { trashed: false };
    },
    async rename(id, name) {
      log.push(`rename:${id}:${name}`);
    },
  };
  return { drive, log };
}

function fakeRepo(init: { ledger?: LedgerRow[]; toCopy?: OutCandidate[]; copied?: OutCandidate[]; files?: Record<string, string> } = {}) {
  const writes: LedgerWrite[] = [];
  const log: string[] = [];
  const repo: SyncRepo = {
    async ledger() {
      return init.ledger ?? [];
    },
    async attachmentsForLink() {
      return { toCopy: init.toCopy ?? [], copied: init.copied ?? [] };
    },
    async readAttachment(url) {
      const c = init.files?.[url];
      return c === undefined ? null : Buffer.from(c);
    },
    async markCopied(attId, w) {
      writes.push(w);
      log.push(`mark:${attId}:${w.item.id}:${w.status}`);
      return true;
    },
    async renameLedger(id, name) {
      log.push(`renameLedger:${id}:${name}`);
    },
    async record(w) {
      writes.push(w);
    },
    async linkExisting(attId, driveId) {
      log.push(`link:${attId}:${driveId}`);
      return true;
    },
    async importAttachment(_l, item, _b, stage, w) {
      writes.push({ ...w, attachmentId: `att-${item.id}` });
      log.push(`attach:${item.id}:${stage}`);
      return `att-${item.id}`;
    },
    async importInbox(_l, item, _b, w) {
      writes.push(w);
      log.push(`inbox:${item.id}`);
    },
    async importPhoto(_l, item, _b, w) {
      writes.push(w);
      log.push(`photo:${item.id}`);
    },
  };
  return { repo, writes, log };
}

const LINK = { id: "L1", propertyId: "P1", folderId: "root1" };
const att = (id: string, extra: Partial<OutCandidate> = {}): OutCandidate => ({
  id,
  type: "general",
  docKind: "sales_contract",
  docStage: "contract",
  docTitle: `売買契約書_${id}.pdf`,
  fileName: "scan.pdf",
  fileUrl: `/uploads/${id}`,
  fileSize: 10,
  mimeType: "application/pdf",
  isDeleted: false,
  driveFileId: null,
  ...extra,
});

describe("walkLinkedFolder", () => {
  it("3階層まで・道(フォルダ名の並び)つき・直下のフォルダを返す", async () => {
    const { drive } = fakeDrive({
      root1: [folder("d1", "契約資料"), file("f0", "直下.pdf", "a")],
      d1: [folder("d2", "2024"), file("f1", "c.pdf", "b")],
      d2: [folder("d3", "x")],
      d3: [folder("d4", "y"), file("f3", "deep.pdf", "c")],
      d4: [file("f4", "too-deep.pdf", "d")],
    });
    const t = await walkLinkedFolder(drive, "root1");
    expect(t.direct.map((d) => d.id)).toEqual(["d1"]);
    expect(t.files.map((f) => [f.item.id, f.relPath])).toEqual([
      ["f0", []],
      ["f1", ["契約資料"]],
      ["f3", ["契約資料", "2024", "x"]],
    ]);
  });
});

describe("syncOneLink", () => {
  it("取り込み: 直下=受け取り箱・段階のフォルダ=添付(段階の補助)・写真=写真タブ", async () => {
    const { drive } = fakeDrive({
      root1: [folder("d1", "契約資料"), folder("d2", "写真"), file("f0", "直下.pdf", "a")],
      d1: [file("f1", "c.pdf", "b")],
      d2: [file("f2", "p.jpg", "c", { mimeType: "image/jpeg" })],
    });
    const { repo, writes, log } = fakeRepo();
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual(["inbox:f0", "attach:f1:contract", "photo:f2"]);
    expect(r).toMatchObject({ inbox: 1, imported: 1, photos: 1, failed: 0 });
    expect(writes.map((w) => [w.item.id, w.direction, w.status, w.attachmentId ?? null])).toEqual([
      ["f0", "in", "inbox", null],
      ["f1", "in", "imported", "att-f1"],
      ["f2", "in", "photo", null],
    ]);
  });

  it("台帳にあるもの・アプリが置いた写しは取り込まない(往復しない)", async () => {
    const { drive, log: dlog } = fakeDrive({
      root1: [file("f0", "a.pdf", "a"), file("f1", "b.pdf", "b", { appSource: "app" })],
    });
    const ledger: LedgerRow[] = [
      { driveFileId: "f0", md5: md5("a"), direction: "in", status: "inbox", name: "a.pdf", attachmentId: null, modifiedTime: null },
    ];
    const { repo, writes, log } = fakeRepo({ ledger });
    await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual([]);
    expect(writes).toEqual([]);
    expect(dlog).toEqual([]);
  });

  it("同じ中身(md5)・形式外は台帳に残して取り込まない", async () => {
    const { drive } = fakeDrive({
      root1: [
        file("f0", "a.pdf", "same"),
        file("f1", "a-copy.pdf", "same"),
        file("g1", "doc", "z", { mimeType: "application/vnd.google-apps.document", md5: null, size: null }),
      ],
    });
    const { repo, writes, log } = fakeRepo();
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual(["inbox:f0"]);
    expect(writes.map((w) => [w.item.id, w.status])).toEqual([
      ["f0", "inbox"],
      ["f1", "duplicate"],
      ["g1", "unsupported"],
    ]);
    expect(r.skipped).toBe(2);
  });

  it("失敗したものは、ドライブ側で更新されたときだけもう一度", async () => {
    const tree = { root1: [file("f0", "a.pdf", "a", { modifiedTime: "2026-10-24T00:00:00.000Z" })] };
    const failed: LedgerRow = { driveFileId: "f0", md5: md5("a"), direction: "in", status: "failed", name: "a.pdf", attachmentId: null, modifiedTime: new Date("2026-10-24T00:00:00.000Z") };
    const a = fakeRepo({ ledger: [failed] });
    await syncOneLink(fakeDrive(tree).drive, a.repo, LINK, { transfers: 20 });
    expect(a.log).toEqual([]);
    const b = fakeRepo({ ledger: [{ ...failed, modifiedTime: new Date("2026-10-23T00:00:00.000Z") }] });
    await syncOneLink(fakeDrive(tree).drive, b.repo, LINK, { transfers: 20 });
    expect(b.log).toEqual(["inbox:f0"]);
  });

  it("複製: 段階のフォルダ(既存の「契約資料」)へそろえた名前で・目印つき", async () => {
    const { drive, log } = fakeDrive({ root1: [folder("d1", "契約資料")] });
    const { repo, log: rlog } = fakeRepo({ toCopy: [att("a1")], files: { "/uploads/a1": "body1" } });
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual(["upload:d1/売買契約書_a1.pdf:app"]);
    expect(rlog[0]).toMatch(/^mark:a1:up\d+:copied$/);
    expect(r.copied).toBe(1);
  });

  it("複製: 段階のフォルダが無ければ「④決済関係」のように作る(2件目は作ったものを使う)", async () => {
    const { drive, log } = fakeDrive({ root1: [] });
    const s = (id: string) => att(id, { docKind: "settlement_statement", docStage: "settlement", docTitle: `精算書_${id}.pdf` });
    const { repo } = fakeRepo({ toCopy: [s("a1"), s("a2")], files: { "/uploads/a1": "1", "/uploads/a2": "2" } });
    await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log.filter((l) => l.startsWith("mkdir"))).toEqual(["mkdir:root1/④決済関係"]);
    expect(log.filter((l) => l.startsWith("upload"))).toHaveLength(2);
  });

  it("★本人確認書類・反響資料は複製しない", async () => {
    const { drive, log } = fakeDrive({ root1: [] });
    const { repo } = fakeRepo({
      toCopy: [att("a1", { docKind: "identity_document", docStage: "identity" }), att("a2", { type: "referral" })],
      files: { "/uploads/a1": "1", "/uploads/a2": "2" },
    });
    await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual([]);
  });

  it("人が同じ中身を置いてあれば複製せず、そのファイルと結ぶだけ(取り込みもしない)", async () => {
    const { drive, log } = fakeDrive({ root1: [folder("d1", "契約資料")], d1: [file("f9", "人の名前.pdf", "body1")] });
    const { repo, log: rlog } = fakeRepo({ toCopy: [att("a1")], files: { "/uploads/a1": "body1" } });
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual([]);
    expect(rlog).toEqual(["mark:a1:f9:matched"]);
    expect(r).toMatchObject({ matched: 1, imported: 0, copied: 0 });
  });

  it("写しの名前合わせ: アプリが置いた写し(copied)だけ・名前が変わったときだけ", async () => {
    const { drive, log } = fakeDrive({ root1: [] });
    const ledger: LedgerRow[] = [
      { driveFileId: "w1", md5: null, direction: "out", status: "copied", name: "旧.pdf", attachmentId: "a1", modifiedTime: null },
      { driveFileId: "w2", md5: null, direction: "out", status: "matched", name: "人の.pdf", attachmentId: "a2", modifiedTime: null },
      { driveFileId: "w3", md5: null, direction: "out", status: "copied", name: "売買契約書_a3.pdf", attachmentId: "a3", modifiedTime: null },
    ];
    const { repo, log: rlog } = fakeRepo({
      ledger,
      copied: [att("a1", { driveFileId: "w1" }), att("a2", { driveFileId: "w2" }), att("a3", { driveFileId: "w3" })],
    });
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual(["rename:w1:売買契約書_a1.pdf"]);
    expect(rlog).toEqual(["renameLedger:w1:売買契約書_a1.pdf"]);
    expect(r.renamed).toBe(1);
  });

  it("読み書きの上限で止まる(残りは次の見回り)", async () => {
    const { drive } = fakeDrive({ root1: [file("f0", "a", "a"), file("f1", "b", "b"), file("f2", "c", "c")] });
    const { repo, log } = fakeRepo();
    const budget = { transfers: 2 };
    await syncOneLink(drive, repo, LINK, budget);
    expect(log).toEqual(["inbox:f0", "inbox:f1"]);
    expect(budget.transfers).toBe(0);
  });

  it("1件の失敗は台帳に failed(コードだけ)で続ける・認可切れ(401)は見回り全体を止める", async () => {
    const { drive } = fakeDrive({ root1: [file("f0", "a", "a"), file("f1", "b", "b")] });
    const { repo, writes } = fakeRepo();
    let first = true;
    repo.importInbox = async (_l, _i, _b, w) => {
      if (first) {
        first = false;
        throw new DriveApiError(500, "x");
      }
      writes.push(w);
    };
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(writes.map((w) => [w.item.id, w.status, w.error ?? null])).toEqual([
      ["f0", "failed", "drive_500"],
      ["f1", "inbox", null],
    ]);
    expect(r.failed).toBe(1);

    const d2 = fakeDrive({ root1: [file("f0", "a", "a")] });
    d2.drive.download = async () => {
      throw new DriveApiError(401, "x");
    };
    await expect(syncOneLink(d2.drive, fakeRepo().repo, LINK, { transfers: 20 })).rejects.toMatchObject({ needsReconnect: true });
  });

  it("★取り込みの台帳は取り込みと一緒に渡す(取り込めたのに台帳が無い、を作らない)", async () => {
    const { drive } = fakeDrive({ root1: [folder("d1", "契約資料"), file("f0", "a.pdf", "a")], d1: [file("f1", "b.pdf", "b")] });
    const { repo, writes } = fakeRepo();
    let recorded = 0;
    repo.record = async () => {
      recorded++;
    };
    await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(recorded).toBe(0); // 成功の台帳は import の中で書く(別の record は呼ばない)
    expect(writes.map((w) => [w.item.id, w.status])).toEqual([
      ["f0", "inbox"],
      ["f1", "imported"],
    ]);
  });

  it("★前回置けたのに記録できなかった写し(目印=この添付)は、置き直さずに結ぶ", async () => {
    const orphan = file("w9", "売買契約書_a1.pdf", "body1", { appSource: "app", appAttachmentId: "a1" });
    const { drive, log } = fakeDrive({ root1: [folder("d1", "契約資料")], d1: [orphan] });
    const { repo, log: rlog } = fakeRepo({ toCopy: [att("a1")], files: { "/uploads/a1": "body1" } });
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual([]);
    expect(rlog).toEqual(["mark:a1:w9:copied"]);
    expect(r.copied).toBe(1);
  });

  it("★ドライブから取り込んだ書類(受け取り箱から添付した)は、ドライブへ複製し直さない", async () => {
    const { drive, log } = fakeDrive({ root1: [file("f0", "人が置いた.pdf", "body1")] });
    const ledger: LedgerRow[] = [
      { driveFileId: "f0", md5: md5("body1"), direction: "in", status: "inbox", name: "人が置いた.pdf", attachmentId: null, modifiedTime: null },
    ];
    const { repo, log: rlog } = fakeRepo({ ledger, toCopy: [att("a1")], files: { "/uploads/a1": "body1" } });
    const r = await syncOneLink(drive, repo, LINK, { transfers: 20 });
    expect(log).toEqual([]);
    expect(rlog).toEqual(["link:a1:f0"]);
    expect(r.matched).toBe(1);
  });

  it("★紐づけたフォルダが消された・ゴミ箱なら、何もせずに知らせる(空のフォルダとして扱わない)", async () => {
    const { drive, log } = fakeDrive({ root1: [] }, {}, new Set(["root1"]));
    const { repo, log: rlog } = fakeRepo({ toCopy: [att("a1")], files: { "/uploads/a1": "1" } });
    await expect(syncOneLink(drive, repo, LINK, { transfers: 20 })).rejects.toBeInstanceOf(LinkedFolderMissingError);
    expect(log).toEqual([]);
    expect(rlog).toEqual([]);
  });
});
