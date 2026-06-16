/**
 * GET /api/health — 公開・read-only の死活確認エンドポイント。
 *
 *  - DB へ軽量疎通（SELECT 1）し、成功で 200 / ok:true、失敗・timeout で 503 / ok:false。
 *  - 応答は { ok, buildId } のみ（PII・secret・接続文字列を一切返さない）。
 *  - buildId は env BUILD_ID（未設定時 "unknown"）。
 *  - DB プローブは Prisma トランザクションの maxWait/timeout で有界化する。
 *
 * prisma はモックして実 DB 非依存でテストする（既存 lib テストの mock 規約に準拠）。
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: { $transaction: vi.fn() },
}));

import prisma from "@/lib/prisma";
import { GET } from "../route";

const pm = prisma as unknown as { $transaction: Mock };

describe("GET /api/health", () => {
  const ORIGINAL_BUILD_ID = process.env.BUILD_ID;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.BUILD_ID;
  });

  afterEach(() => {
    if (ORIGINAL_BUILD_ID === undefined) {
      delete process.env.BUILD_ID;
    } else {
      process.env.BUILD_ID = ORIGINAL_BUILD_ID;
    }
  });

  it("DB 疎通成功で 200 / ok:true / buildId(string) を返す", async () => {
    pm.$transaction.mockResolvedValueOnce(undefined);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.buildId).toBe("string");
  });

  it("DB 例外・timeout 時は 503 / ok:false を返す", async () => {
    pm.$transaction.mockRejectedValueOnce(new Error("connection refused"));

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("DB プローブを transaction の maxWait/timeout で有界化する（stall 時に接続を解放）", async () => {
    pm.$transaction.mockResolvedValueOnce(undefined);

    await GET();

    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    const options = pm.$transaction.mock.calls[0]?.[1] as
      | { maxWait?: number; timeout?: number }
      | undefined;
    expect(typeof options?.maxWait).toBe("number");
    expect(options?.maxWait).toBeGreaterThan(0);
    expect(typeof options?.timeout).toBe("number");
    expect(options?.timeout).toBeGreaterThan(0);
  });

  it("応答は { ok, buildId } の 2 キーのみ（余計な情報を漏らさない）", async () => {
    pm.$transaction.mockResolvedValueOnce(undefined);

    const res = await GET();

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["buildId", "ok"]);
  });

  it("buildId は env BUILD_ID を反映し、未設定時は 'unknown'", async () => {
    pm.$transaction.mockResolvedValue(undefined);

    const resUnset = await GET();
    expect((await resUnset.json()).buildId).toBe("unknown");

    process.env.BUILD_ID = "deadbeef";
    const resSet = await GET();
    expect((await resSet.json()).buildId).toBe("deadbeef");
  });

  it("Cache-Control: no-store を付与する", async () => {
    pm.$transaction.mockResolvedValueOnce(undefined);

    const res = await GET();

    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
