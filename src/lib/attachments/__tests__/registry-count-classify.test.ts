import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));

import {
  classifyRegistryText,
  countRegistryAttachmentGroups,
  countUntypedRegistryAttachments,
  resetRegistryCountCacheForTest,
  REGISTRY_COUNT_FAILURE_TTL_MS,
  REGISTRY_COUNT_READ_BUDGET_MS,
  type UntypedRegistryAttachment,
} from "../registry-count-classify";

// 見本は実物の並びだけを写した架空のもの(氏名・住所は実在しない)。
const OWNER_TEXT = [
  "東京都渋谷区神宮前三丁目123-4 所有者事項 （土地）",
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠────────────────────┬─────────────┨",
  "┃ 住 所 │ 氏 名 ┃",
  "┠────────────────────┼─────────────┨",
  "┃東京都渋谷区神宮前三丁目12番3号 │山田太郎 ┃",
  "┗━━━━━━━━━━━━━━━━━━┷━━━━━━━━━┛",
].join("\n");
const FULL_TEXT = "表 題 部 （ 土 地 の 表 示 ）\n所 在 架空市架空町一丁目\n権 利 部 （ 甲 区 ） （ 所 有 権 に 関 す る 事 項 ）\n1 所有権移転";
const NOT_REGISTRY_TEXT = "重要事項説明書\n本物件の概要は次のとおりです。";

const row = (id: string, over: Partial<UntypedRegistryAttachment> = {}): UntypedRegistryAttachment => ({
  id,
  fileUrl: `/uploads/registry/${id}.pdf`,
  fileSize: 1000,
  mimeType: "application/pdf",
  ...over,
});

beforeEach(() => resetRegistryCountCacheForTest());

describe("本文で見分ける(取引の画面と同じ見分け方)", () => {
  it("権利部の甲区がある=全部事項/所有者の表=所有者事項/どちらでもない=その他", () => {
    expect(classifyRegistryText(FULL_TEXT)).toBe("all");
    expect(classifyRegistryText(OWNER_TEXT)).toBe("owner");
    expect(classifyRegistryText(NOT_REGISTRY_TEXT)).toBe("other");
    expect(classifyRegistryText("")).toBe("other");
  });
});

describe("種別の列が空の謄本の数え分け", () => {
  it("★全部事項・所有者事項・画像の謄本・謄本でない書類・時間切れ・読めないを数え分ける", async () => {
    const texts: Record<string, string | null> = {
      full: FULL_TEXT,
      owner: OWNER_TEXT,
      notRegistry: NOT_REGISTRY_TEXT,
      scanned: "", // 画像だけの PDF(文字が無い)
      missing: null, // 保存場所に無い・PDF でない
    };
    const read = vi.fn(async (url: string) => {
      const id = url.split("/").pop()!.replace(".pdf", "");
      if (id === "slow") throw Object.assign(new Error("timeout"), { code: "PDF_READ_TIMEOUT" });
      return texts[id];
    });
    const rows = [
      row("full"),
      row("owner"),
      row("image", { mimeType: "image/jpeg", fileUrl: "/uploads/registry/image.jpg" }),
      row("notRegistry"),
      row("scanned"),
      row("missing"),
      row("slow"),
    ];
    expect(await countUntypedRegistryAttachments(rows, { read })).toEqual({ owner: 1, all: 1, other: 5 });
    // 画像は読まない
    expect(read.mock.calls.map((c) => c[0])).not.toContain("/uploads/registry/image.jpg");
  });

  it("★2回目に開いたときは PDF を読み直さない(時間切れ・読めなかった分も)", async () => {
    const read = vi.fn(async (url: string) => {
      if (url.includes("slow")) throw new Error("timeout");
      return url.includes("full") ? FULL_TEXT : OWNER_TEXT;
    });
    const rows = [row("full"), row("owner"), row("slow")];
    const first = await countUntypedRegistryAttachments(rows, { read });
    expect(read).toHaveBeenCalledTimes(3);
    const second = await countUntypedRegistryAttachments(rows, { read });
    expect(read).toHaveBeenCalledTimes(3);
    expect(second).toEqual(first);
    expect(second).toEqual({ owner: 1, all: 1, other: 1 });
  });

  it("ファイルが変わったら(保存先・大きさ)読み直す", async () => {
    const read = vi.fn(async () => FULL_TEXT);
    await countUntypedRegistryAttachments([row("a")], { read });
    await countUntypedRegistryAttachments([row("a", { fileSize: 2000 })], { read });
    await countUntypedRegistryAttachments([row("a", { fileUrl: "/uploads/registry/a2.pdf" })], { read });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("1回の表示で読む時間を使い切ったら、残りは読まずに「その他」(覚えない=次に開いたときに読む)", async () => {
    let t = 0;
    const now = () => t;
    const read = vi.fn(async () => {
      t += REGISTRY_COUNT_READ_BUDGET_MS; // 1件目で持ち時間を使い切る
      return FULL_TEXT;
    });
    const rows = [row("a"), row("b")];
    expect(await countUntypedRegistryAttachments(rows, { read, now })).toEqual({ owner: 0, all: 1, other: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    t = 0;
    expect(await countUntypedRegistryAttachments(rows, { read, now })).toEqual({ owner: 0, all: 2, other: 0 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("読む時間には上限を渡す(1件3秒まで・残りの持ち時間を超えない)", async () => {
    let t = 0;
    const read = vi.fn(async (_url: string, _timeoutMs: number) => {
      t += 2500;
      return FULL_TEXT;
    });
    await countUntypedRegistryAttachments([row("a"), row("b")], { read, now: () => t });
    expect(read.mock.calls.map((c) => c[1])).toEqual([3000, 1500]);
  });

  it("残りの持ち時間が1秒未満なら読みに行かない(確実に時間切れになる・覚えない)", async () => {
    let t = 0;
    const read = vi.fn(async () => {
      t += 3200;
      return OWNER_TEXT;
    });
    const rows = [row("a"), row("b")];
    expect(await countUntypedRegistryAttachments(rows, { read, now: () => t })).toEqual({ owner: 1, all: 0, other: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await countUntypedRegistryAttachments(rows, { read, now: () => t })).toEqual({ owner: 2, all: 0, other: 0 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("時間切れ・読み取りの失敗は10分だけ覚え、そのあと読み直す(見分けられた結果はずっと覚える)", async () => {
    let t = 0;
    let fail = true;
    const read = vi.fn(async (url: string) => {
      if (url.includes("x") && fail) throw new Error("timeout");
      return FULL_TEXT;
    });
    const rows = [row("x"), row("ok")];
    const now = () => t;
    expect(await countUntypedRegistryAttachments(rows, { read, now })).toEqual({ owner: 0, all: 1, other: 1 });
    t = REGISTRY_COUNT_FAILURE_TTL_MS - 1;
    expect(await countUntypedRegistryAttachments(rows, { read, now })).toEqual({ owner: 0, all: 1, other: 1 });
    expect(read).toHaveBeenCalledTimes(2);
    fail = false;
    t = REGISTRY_COUNT_FAILURE_TTL_MS + 1;
    expect(await countUntypedRegistryAttachments(rows, { read, now })).toEqual({ owner: 0, all: 2, other: 0 });
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("種別ごとの件数のまとめ(物件の画面の API が使う)", () => {
  const read = async () => FULL_TEXT;
  it("列が owner/all はそのまま・列が空だけ読み出して見分ける", async () => {
    const load = vi.fn(async () => [row("u1")]);
    const c = await countRegistryAttachmentGroups(
      [
        { registryCertificateType: "owner", _count: { _all: 2 } },
        { registryCertificateType: "all", _count: { _all: 1 } },
        { registryCertificateType: null, _count: { _all: 1 } },
      ],
      load,
      { read },
    );
    expect(c).toEqual({ owner: 2, all: 2, other: 0 });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("列が空の謄本が無ければ読み出さない", async () => {
    const load = vi.fn(async () => []);
    expect(await countRegistryAttachmentGroups([{ registryCertificateType: "owner", _count: { _all: 1 } }], load, { read })).toEqual({ owner: 1, all: 0, other: 0 });
    expect(load).not.toHaveBeenCalled();
  });
  it("読み出しが失敗しても投げず、列が空の分は「その他」", async () => {
    const load = vi.fn(async () => {
      throw new Error("db");
    });
    expect(await countRegistryAttachmentGroups([{ registryCertificateType: null, _count: { _all: 2 } }], load, { read })).toEqual({ owner: 0, all: 0, other: 2 });
  });
});

describe("守り(走査)", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/attachments/registry-count-classify.ts"), "utf8");
  it("監査ログを書かない・種別の列を書き換えない", () => {
    expect(src).not.toMatch(/writeAuditLog|auditLog/);
    expect(src).not.toMatch(/prisma/);
  });
  it("時間の上限つきで読む(worker で止まる読み方)", () => {
    expect(src).toMatch(/extractTextFromPdf\(file\.body, \{ timeoutMs: remaining \}\)/);
  });
  it("物件一覧は件数の見分けを使わない(詳しい画面だけ)", () => {
    const list = readFileSync(join(process.cwd(), "src/app/api/properties/route.ts"), "utf8");
    expect(list).not.toMatch(/registry-count-classify/);
  });
});
