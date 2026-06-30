import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { SalesSheetDocument } from "../document-schema";
import { A4_LANDSCAPE } from "../document-schema";

// getStorage returns an object with lazy fns — the inner closure avoids TDZ
const read = vi.fn();
const keyFromUrl = vi.fn();
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ read, keyFromUrl }),
}));

// authorizeUploadAccess must be defined inside the factory (vi.fn() directly)
// to avoid Temporal Dead Zone when vi.mock is hoisted before const declarations.
vi.mock("@/lib/uploads-authorization", () => ({
  authorizeUploadAccess: vi.fn(),
  isUploadKeyOwnedByProperty: vi.fn(),
}));

import {
  authorizeAndInlineDocumentImages,
  assertDocumentImagesAuthorized,
  isImageKeyAuthorizedForProperty,
} from "../authorize-document-images";
import { authorizeUploadAccess, isUploadKeyOwnedByProperty } from "@/lib/uploads-authorization";

const SESSION = { id: "u1", email: "u@x.com", name: "U", role: "admin" };
const PERMS = [{ resource: "property", action: "read", granted: true }];

const docWith = (src: string): SalesSheetDocument => ({
  page: A4_LANDSCAPE,
  theme: { fontFamily: "sans-serif", accentColor: "#000" },
  elements: [
    { id: "img", type: "image", x: 0, y: 0, w: 10, h: 10, z: 1, src, fit: "cover" },
    { id: "txt", type: "text", x: 0, y: 20, w: 10, h: 5, z: 2, content: "hello", style: {} },
  ],
});

beforeEach(() => {
  read.mockReset();
  keyFromUrl.mockReset();
  (authorizeUploadAccess as unknown as Mock).mockReset();
  (isUploadKeyOwnedByProperty as unknown as Mock).mockReset();
  (isUploadKeyOwnedByProperty as unknown as Mock).mockResolvedValue(true);
});

describe("authorizeAndInlineDocumentImages", () => {
  it("data: src はそのまま保持し、storage も authz も呼ばない", async () => {
    const src = "data:image/png;base64,AAAA";
    const out = await authorizeAndInlineDocumentImages(docWith(src), { session: SESSION, permissions: PERMS });
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).toBe(src);
    expect(read).not.toHaveBeenCalled();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
  });

  it("authz=ok の画像は data: URL にインラインされる", async () => {
    keyFromUrl.mockReturnValue("properties/p1/photo.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "image/jpeg", size: 3 });

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/p1/photo.jpg"), {
      session: SESSION,
      permissions: PERMS,
    });

    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("非画像 MIME（octet-stream 等）は data: 化せずプレースホルダ化（出力全体の 422 を防ぐ）", async () => {
    keyFromUrl.mockReturnValue("properties/p1/photo.jfif");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "application/octet-stream", size: 3 });

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/p1/photo.jfif"), {
      session: SESSION,
      permissions: PERMS,
    });

    const img = out.elements.find((e) => e.type === "image");
    // data:application/octet-stream にならず、安全な data:image/ プレースホルダに差し替え
    expect(img && img.type === "image" && img.src.startsWith("data:image/")).toBe(true);
    expect(img && img.type === "image" && img.src.includes("octet-stream")).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("[セキュリティ] authz=forbidden → プレースホルダ化し、storage.read を呼ばない", async () => {
    keyFromUrl.mockReturnValue("properties/other/secret.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/other/secret.jpg"), {
      session: SESSION,
      permissions: PERMS,
    });

    // storage.read は一切呼ばれていない（バイト未読込）
    expect(read).not.toHaveBeenCalled();
    // 画像要素の src に元の key/URL が含まれていない
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).not.toContain("secret");
    // 要素はレイアウト保持のため残る
    expect(img).toBeDefined();
    // テキスト要素は保持
    expect(out.elements.some((e) => e.type === "text")).toBe(true);
  });

  it("[セキュリティ] authz=not_found → プレースホルダ化し、storage.read を呼ばない", async () => {
    keyFromUrl.mockReturnValue("properties/p1/deleted.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("not_found");

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/p1/deleted.jpg"), {
      session: SESSION,
      permissions: PERMS,
    });

    expect(read).not.toHaveBeenCalled();
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).not.toContain("deleted");
    expect(img).toBeDefined();
    expect(out.elements.some((e) => e.type === "text")).toBe(true);
  });

  it("keyFromUrl が null → authz も read も呼ばず、プレースホルダ化", async () => {
    keyFromUrl.mockReturnValue(null);

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/bad/path"), {
      session: SESSION,
      permissions: PERMS,
    });

    expect(authorizeUploadAccess).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const img = out.elements.find((e) => e.type === "image");
    expect(img).toBeDefined(); // element is kept (z-order preserved)
  });

  it("read が null を返す（ファイルなし）→ プレースホルダ化、テキスト保持", async () => {
    keyFromUrl.mockReturnValue("properties/p1/missing.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    read.mockResolvedValue(null);

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/p1/missing.jpg"), {
      session: SESSION,
      permissions: PERMS,
    });

    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).not.toContain("properties/p1/missing");
    expect(out.elements.some((e) => e.type === "text")).toBe(true);
  });

  it("read が例外を throw → プレースホルダ化、他要素は保持", async () => {
    keyFromUrl.mockReturnValue("properties/p1/broken.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    read.mockRejectedValue(new Error("I/O error"));

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/p1/broken.jpg"), {
      session: SESSION,
      permissions: PERMS,
    });

    const img = out.elements.find((e) => e.type === "image");
    expect(img).toBeDefined(); // element kept (z-order preserved)
    expect(out.elements.some((e) => e.type === "text")).toBe(true);
  });

  it("入力 document は変更されない（不変性）", async () => {
    keyFromUrl.mockReturnValue("properties/p1/photo.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "image/jpeg", size: 3 });

    const original = docWith("/uploads/properties/p1/photo.jpg");
    const originalSrc = "/uploads/properties/p1/photo.jpg";
    await authorizeAndInlineDocumentImages(original, { session: SESSION, permissions: PERMS });

    const img = original.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).toBe(originalSrc);
  });

  it("storage key・URL が返り値に含まれない（PII 漏洩なし）", async () => {
    keyFromUrl.mockReturnValue("properties/p1/photo.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");

    const out = await authorizeAndInlineDocumentImages(docWith("/uploads/properties/p1/photo.jpg"), {
      session: SESSION,
      permissions: PERMS,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("properties/p1/photo.jpg");
  });

  it("非 image 要素は変更なしで通過する", async () => {
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#f00" },
      elements: [
        { id: "t", type: "text", x: 0, y: 0, w: 10, h: 5, z: 1, content: "abc", style: { bold: true } },
        { id: "b", type: "badge", x: 0, y: 10, w: 20, h: 5, z: 2, label: "売出中", shape: "pill", bg: "#000", fg: "#fff" },
      ],
    };
    const out = await authorizeAndInlineDocumentImages(doc, { session: SESSION, permissions: PERMS });
    expect(out.elements).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
  });

  it("[DoS] /uploads 画像が上限を超える document は出力拒否（read 前に throw）", async () => {
    const images = Array.from({ length: 51 }, (_, i) => ({
      id: `i${i}`, type: "image" as const, x: 0, y: 0, w: 5, h: 5, z: 1,
      src: `/uploads/properties/p1/${i}.jpg`, fit: "cover" as const,
    }));
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: images,
    };
    await expect(
      authorizeAndInlineDocumentImages(doc, { session: SESSION, permissions: PERMS }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); // fail-fast: 1 件も read しない
  });

  it("[DoS] data URL 直列化後の合計が上限超で以降 drop（raw bytes ではなく serialized size で計上）", async () => {
    keyFromUrl.mockImplementation((url: string) => url.replace("/uploads/", ""));
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    // raw 15MB ×2 = 30MB は raw 上限(32MB)以下だが、base64 化で各 ≈20MB → 計 ≈40MB が上限超。
    // raw bytes で数えれば 2枚とも通るが、実際に Chromium へ渡る serialized data URL サイズで
    // 数えるので 2枚目が drop される（base64 膨張を勘定に入れる）。
    const body = Buffer.alloc(15 * 1024 * 1024);
    read.mockResolvedValue({ body, contentType: "image/jpeg", size: body.length });
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        { id: "i1", type: "image", x: 0, y: 0, w: 5, h: 5, z: 1, src: "/uploads/properties/p1/a.jpg", fit: "cover" },
        { id: "i2", type: "image", x: 0, y: 10, w: 5, h: 5, z: 2, src: "/uploads/properties/p1/b.jpg", fit: "cover" },
      ],
    };
    const out = await authorizeAndInlineDocumentImages(doc, { session: SESSION, permissions: PERMS });
    const imgs = out.elements.filter((e) => e.type === "image");
    expect(imgs[0].type === "image" && imgs[0].src.startsWith("data:image/jpeg")).toBe(true); // 1枚目 inline
    expect(imgs[1].type === "image" && imgs[1].src.startsWith("data:image/gif")).toBe(true); // 2枚目 placeholder（serialized 超過）
  });

  it("[dedup] 同一 key を参照する複数画像は read を1回だけ行う", async () => {
    keyFromUrl.mockReturnValue("properties/p1/same.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    read.mockResolvedValue({ body: Buffer.from([1, 2]), contentType: "image/png", size: 2 });
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        { id: "i1", type: "image", x: 0, y: 0, w: 5, h: 5, z: 1, src: "/uploads/properties/p1/same.jpg", fit: "cover" },
        { id: "i2", type: "image", x: 0, y: 10, w: 5, h: 5, z: 2, src: "/uploads/properties/p1/same.jpg", fit: "cover" },
      ],
    };
    const out = await authorizeAndInlineDocumentImages(doc, { session: SESSION, permissions: PERMS });
    expect(read).toHaveBeenCalledTimes(1); // 重複 read なし
    const imgs = out.elements.filter((e) => e.type === "image");
    expect(imgs[0].type === "image" && imgs[0].src.startsWith("data:image/png")).toBe(true);
    expect(imgs[1].type === "image" && imgs[1].src.startsWith("data:image/png")).toBe(true);
  });

  it("[DoS] 同一画像の繰り返し参照は read 1回だが、初回も cache 再利用も serialized size を budget 加算し超過分 drop", async () => {
    // 同じ /uploads 画像を複数回参照する document。data URL は HTML に出現回数分直列化されるため、
    // 初回画像も cache 再利用も同じ「serialized data URL サイズ」で budget を消費し、上限超過分は drop。
    keyFromUrl.mockReturnValue("properties/p1/same.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    // body 9MB → data URL(base64) ≈ 12MB。1枚目+2枚目 ≈24MB は上限内、3枚目で ≈36MB>32MB 超過。
    const body = Buffer.alloc(9 * 1024 * 1024);
    read.mockResolvedValue({ body, contentType: "image/jpeg", size: body.length });
    const ref = "/uploads/properties/p1/same.jpg";
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        { id: "i1", type: "image", x: 0, y: 0, w: 5, h: 5, z: 1, src: ref, fit: "cover" },
        { id: "i2", type: "image", x: 0, y: 10, w: 5, h: 5, z: 2, src: ref, fit: "cover" },
        { id: "i3", type: "image", x: 0, y: 20, w: 5, h: 5, z: 3, src: ref, fit: "cover" },
      ],
    };
    const out = await authorizeAndInlineDocumentImages(doc, { session: SESSION, permissions: PERMS });
    expect(read).toHaveBeenCalledTimes(1); // dedup: read は1回だけ
    const imgs = out.elements.filter((e) => e.type === "image");
    expect(imgs[0].type === "image" && imgs[0].src.startsWith("data:image/jpeg")).toBe(true); // 1枚目 inline（read・serialized 計上）
    expect(imgs[1].type === "image" && imgs[1].src.startsWith("data:image/jpeg")).toBe(true); // 2枚目 cache 再利用（budget内）
    expect(imgs[2].type === "image" && imgs[2].src.startsWith("data:image/gif")).toBe(true); // 3枚目 budget 超過で placeholder
  });
});

describe("assertDocumentImagesAuthorized（保存境界の認可ガード）", () => {
  const CTX = { session: SESSION, permissions: PERMS, propertyId: "p1" };

  it("認可済み かつ 自物件の /uploads 画像なら解決する（throwしない）", async () => {
    keyFromUrl.mockReturnValue("properties/p1/photo.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    (isUploadKeyOwnedByProperty as unknown as Mock).mockResolvedValue(true);
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/p1/photo.jpg"), CTX),
    ).resolves.toBeUndefined();
  });

  it("未認可(forbidden) /uploads を含むと throw（保存拒否）", async () => {
    keyFromUrl.mockReturnValue("properties/other/secret.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/other/secret.jpg"), CTX),
    ).rejects.toThrow();
  });

  it("存在しない(not_found) /uploads を含むと throw", async () => {
    keyFromUrl.mockReturnValue("properties/p1/deleted.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("not_found");
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/p1/deleted.jpg"), CTX),
    ).rejects.toThrow();
  });

  it("別物件の /uploads key（caller は読めるが図面の物件スコープ外）は throw", async () => {
    // 複数物件を読める管理者が物件Bのkeyを物件Aの図面に保存しようとするケース
    keyFromUrl.mockReturnValue("properties/B/photo.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok"); // caller は読める
    (isUploadKeyOwnedByProperty as unknown as Mock).mockResolvedValue(false); // だが物件p1のものではない
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/B/photo.jpg"), CTX),
    ).rejects.toThrow();
  });

  it("解決不能な /uploads key は throw（authz/所属判定を呼ばない）", async () => {
    keyFromUrl.mockReturnValue(null);
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/bad/path"), CTX),
    ).rejects.toThrow();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
    expect(isUploadKeyOwnedByProperty).not.toHaveBeenCalled();
  });

  it("data: 画像は認可不要でスキップ（throwしない・storage/authz/所属判定を呼ばない）", async () => {
    await expect(
      assertDocumentImagesAuthorized(docWith("data:image/png;base64,AAAA"), CTX),
    ).resolves.toBeUndefined();
    expect(keyFromUrl).not.toHaveBeenCalled();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
    expect(isUploadKeyOwnedByProperty).not.toHaveBeenCalled();
  });

  it("エラーに storage key/URL を含めない（漏洩防止）", async () => {
    keyFromUrl.mockReturnValue("properties/other/secret.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    let caught: unknown;
    try {
      await assertDocumentImagesAuthorized(docWith("/uploads/properties/other/secret.jpg"), CTX);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught)).not.toContain("secret");
    expect(JSON.stringify(caught)).not.toContain("properties/other");
  });

  it("複数画像で1つでも未認可なら throw", async () => {
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        { id: "i1", type: "image", x: 0, y: 0, w: 10, h: 10, z: 1, src: "/uploads/properties/p1/a.jpg", fit: "cover" },
        { id: "i2", type: "image", x: 0, y: 20, w: 10, h: 10, z: 2, src: "/uploads/properties/other/b.jpg", fit: "cover" },
      ],
    };
    keyFromUrl.mockImplementation((url: string) => url.replace("/uploads/", ""));
    (authorizeUploadAccess as unknown as Mock).mockImplementation(
      async ({ key }: { key: string }) => (key.startsWith("properties/p1/") ? "ok" : "forbidden"),
    );
    (isUploadKeyOwnedByProperty as unknown as Mock).mockImplementation(
      async (key: string) => key.startsWith("properties/p1/"),
    );
    await expect(assertDocumentImagesAuthorized(doc, CTX)).rejects.toThrow();
  });

  it("[DoS] /uploads 画像が上限超の document は保存拒否（認可ループ前に fail-fast）", async () => {
    // export は >50 を 422 で弾くため、保存できても出力不能になる。保存境界でも同じ上限を課し
    // 「保存できたのに export 不能」を防ぐ。認可（authorizeUploadAccess）を回す前に拒否する。
    // key 解決・認可は通る前提（=上限チェックが無ければ全件 authorize されて成功してしまう）にする。
    keyFromUrl.mockImplementation((url: string) => url.replace("/uploads/", ""));
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    (isUploadKeyOwnedByProperty as unknown as Mock).mockResolvedValue(true);
    const images = Array.from({ length: 51 }, (_, i) => ({
      id: `i${i}`, type: "image" as const, x: 0, y: 0, w: 5, h: 5, z: 1,
      src: `/uploads/properties/p1/${i}.jpg`, fit: "cover" as const,
    }));
    const doc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: images,
    };
    await expect(assertDocumentImagesAuthorized(doc, CTX)).rejects.toThrow();
    expect(authorizeUploadAccess).not.toHaveBeenCalled(); // fail-fast: 認可前に拒否
  });
});

describe("isImageKeyAuthorizedForProperty（保存境界・サーバ生成共用の認可ヘルパ）", () => {
  const CTX = { session: SESSION, permissions: PERMS, propertyId: "p1" };

  it("caller 認可（ok）かつ物件所属（true）なら true", async () => {
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    (isUploadKeyOwnedByProperty as unknown as Mock).mockResolvedValue(true);
    expect(await isImageKeyAuthorizedForProperty("properties/p1/a.jpg", CTX)).toBe(true);
  });

  it("caller 未認可（forbidden）なら false（所属判定を呼ばない）", async () => {
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    expect(await isImageKeyAuthorizedForProperty("properties/other/a.jpg", CTX)).toBe(false);
    expect(isUploadKeyOwnedByProperty).not.toHaveBeenCalled();
  });

  it("別物件（所属 false）なら false", async () => {
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    (isUploadKeyOwnedByProperty as unknown as Mock).mockResolvedValue(false);
    expect(await isImageKeyAuthorizedForProperty("properties/B/a.jpg", CTX)).toBe(false);
  });
});
