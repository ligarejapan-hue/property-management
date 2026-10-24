/**
 * アクセストークンの控え(メモリ)と、接続を切る/つなぎ直すときの競合(@codex #577 R3)。
 * 更新の途中で接続が切られた・別のアカウントでつなぎ直された場合、古い接続のトークンを控えに入れない・返さない。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const db = vi.hoisted(() => ({ row: null as null | { refreshTokenEnc: string | null } }));
vi.mock("@/lib/prisma", () => ({
  default: {
    driveConnection: {
      findUnique: vi.fn(async () => db.row),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    propertyDriveFolder: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("@/lib/sale-dm-letter/secret-crypto", () => ({
  isSecretCryptoConfigured: () => true,
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => s.replace(/^enc\((.*)\)$/, "$1"),
}));

import prisma from "@/lib/prisma";
import {
  getDriveAccessToken,
  clearDriveConnection,
  saveDriveConnection,
  __resetDriveTokenCacheForTest,
} from "../connection";

function tokenFetch(tokens: Record<string, string>, gate?: Promise<void>): Mock {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (gate) await gate;
    const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
    return Response.json({ access_token: tokens[rt] ?? "?", expires_in: 3600 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetDriveTokenCacheForTest();
  process.env.GOOGLE_DRIVE_CLIENT_ID = "cid";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "sec";
  db.row = { refreshTokenEnc: "enc(rtA)" };
});

describe("getDriveAccessToken", () => {
  it("一度もらったトークンは期限までメモリから返す(2回目は更新しない)", async () => {
    const f = tokenFetch({ rtA: "atA" });
    expect(await getDriveAccessToken(f as never, 1_000)).toBe("atA");
    expect(await getDriveAccessToken(f as never, 2_000)).toBe("atA");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("★更新の途中で接続を切られたら、古いトークンを返さず控えにも入れない", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const f = tokenFetch({ rtA: "atA" }, gate);
    const pending = getDriveAccessToken(f as never, 1_000);
    await Promise.resolve();
    db.row = { refreshTokenEnc: null };
    await clearDriveConnection();
    open();
    await expect(pending).rejects.toMatchObject({ code: "not_connected" });
    // 控えに残っていない(次も DB を見て「未接続」)
    await expect(getDriveAccessToken(tokenFetch({}) as never, 2_000)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("★更新の途中で別のアカウントにつなぎ直されたら、新しい接続のトークンを返す", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const f = tokenFetch({ rtA: "atA", rtB: "atB" }, gate);
    const pending = getDriveAccessToken(f as never, 1_000);
    await Promise.resolve();
    db.row = { refreshTokenEnc: "enc(rtB)" };
    await saveDriveConnection({ accountEmail: "b@example.com", refreshToken: "rtB", userId: "u1" });
    open();
    expect(await pending).toBe("atB");
    expect(await getDriveAccessToken(tokenFetch({}) as never, 2_000)).toBe("atB");
    expect((prisma as unknown as { driveConnection: { upsert: Mock } }).driveConnection.upsert).toHaveBeenCalled();
  });
});
