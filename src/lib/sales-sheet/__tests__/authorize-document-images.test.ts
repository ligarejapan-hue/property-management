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
}));

import {
  authorizeAndInlineDocumentImages,
  assertDocumentImagesAuthorized,
} from "../authorize-document-images";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";

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
});

describe("assertDocumentImagesAuthorized（保存境界の認可ガード）", () => {
  it("認可済み /uploads 画像のみなら解決する（throwしない）", async () => {
    keyFromUrl.mockReturnValue("properties/p1/photo.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/p1/photo.jpg"), {
        session: SESSION,
        permissions: PERMS,
      }),
    ).resolves.toBeUndefined();
  });

  it("未認可(forbidden) /uploads を含むと throw（保存拒否）", async () => {
    keyFromUrl.mockReturnValue("properties/other/secret.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/other/secret.jpg"), {
        session: SESSION,
        permissions: PERMS,
      }),
    ).rejects.toThrow();
  });

  it("存在しない(not_found) /uploads を含むと throw", async () => {
    keyFromUrl.mockReturnValue("properties/p1/deleted.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("not_found");
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/properties/p1/deleted.jpg"), {
        session: SESSION,
        permissions: PERMS,
      }),
    ).rejects.toThrow();
  });

  it("解決不能な /uploads key は throw（authorizeUploadAccess を呼ばない）", async () => {
    keyFromUrl.mockReturnValue(null);
    await expect(
      assertDocumentImagesAuthorized(docWith("/uploads/bad/path"), { session: SESSION, permissions: PERMS }),
    ).rejects.toThrow();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
  });

  it("data: 画像は認可不要でスキップ（throwしない・storage/authzを呼ばない）", async () => {
    await expect(
      assertDocumentImagesAuthorized(docWith("data:image/png;base64,AAAA"), {
        session: SESSION,
        permissions: PERMS,
      }),
    ).resolves.toBeUndefined();
    expect(keyFromUrl).not.toHaveBeenCalled();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
  });

  it("エラーに storage key/URL を含めない（漏洩防止）", async () => {
    keyFromUrl.mockReturnValue("properties/other/secret.jpg");
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    let caught: unknown;
    try {
      await assertDocumentImagesAuthorized(docWith("/uploads/properties/other/secret.jpg"), {
        session: SESSION,
        permissions: PERMS,
      });
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
    await expect(
      assertDocumentImagesAuthorized(doc, { session: SESSION, permissions: PERMS }),
    ).rejects.toThrow();
  });
});
