import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 見た目の設定: ルートの layout から呼ぶ読み込み。画面を落とさない・待たせない・公開ページで DB に触らない。
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { user: { findUnique: vi.fn() }, systemSetting: { findMany: vi.fn(async () => []) } },
}));

import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { loadAppearanceForRequest } from "../server";

const db = prisma as unknown as { user: { findUnique: Mock }; systemSetting: { findMany: Mock } };
const jar = (names: string[]) => ({ get: (n: string) => (names.includes(n) ? { value: "x" } : undefined) });

beforeEach(() => {
  vi.clearAllMocks();
  (cookies as Mock).mockResolvedValue(jar(["authjs.session-token"]));
  (auth as Mock).mockResolvedValue({ user: { id: "u1" } });
  db.user.findUnique.mockResolvedValue({ theme: "navy", density: "large", layout: null });
  db.systemSetting.findMany.mockResolvedValue([]);
});

describe("loadAppearanceForRequest", () => {
  it("ログイン中は DB の設定(個人→会社→既定)", async () => {
    expect(await loadAppearanceForRequest()).toEqual({ userId: "u1", appearance: { theme: "navy", density: "large", layout: "side" } });
  });
  it("本番の名前(__Secure-)の cookie でも読む", async () => {
    (cookies as Mock).mockResolvedValue(jar(["__Secure-authjs.session-token"]));
    expect(await loadAppearanceForRequest()).not.toBeNull();
  });
  it("ログインの cookie が無ければ DB にも auth にも触らず null(公開ページ・ログイン前)", async () => {
    (cookies as Mock).mockResolvedValue(jar([]));
    expect(await loadAppearanceForRequest()).toBeNull();
    expect(auth).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
  it("DB が失敗しても null(画面は端末に覚えた値で描く)", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    expect(await loadAppearanceForRequest()).toBeNull();
  });
  it("DB が固まっても打ち切って null(画面を待たせない)", async () => {
    db.user.findUnique.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    expect(await loadAppearanceForRequest(30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("セッションが切れていれば null", async () => {
    (auth as Mock).mockResolvedValue(null);
    expect(await loadAppearanceForRequest()).toBeNull();
  });
});
