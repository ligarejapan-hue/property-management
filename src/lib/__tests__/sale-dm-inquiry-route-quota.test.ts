import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// 全体上限(120/時)を実際に埋める必要があるため、モジュール保持の回数制限を他のテストと
// 共有しないよう別ファイルに分けている(このファイルの中だけで状態が完結する)。
vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { dmRecipientDraft: { findUnique: vi.fn(async () => ({ id: "d1" })) } },
}));
vi.mock("@/lib/sale-dm-letter/inquiry-record", () => ({
  recordInquiry: vi.fn(async () => ({ kind: "recorded", inquiryId: "inq1", draftId: "d1", first: true })),
}));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({
  loadSaleDmPublicPageConfig: vi.fn(async () => ({
    senderName: null, senderContact: null, trackingBaseUrl: undefined, lpPublicEnabled: true, privacyText: null,
  })),
}));

import { POST } from "@/app/t/[token]/inquiry/route";

const VALID = { name: "山田", phone: "090-1234-5678", consent: "yes" };
const HOUR = 3_600_000;
const T0 = new Date("2026-09-17T00:00:00Z").getTime();

let seq = 0;
function call(token: string) {
  seq += 1;
  const req = new Request(`http://localhost:3000/t/${token}/inquiry`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "app.ligarejapan.com",
      // 端末IPの制限(10/分)に掛からないよう要求ごとに変える
      "x-forwarded-for": `10.77.${Math.floor(seq / 250)}.${seq % 250}`,
    },
    body: new URLSearchParams(VALID).toString(),
  });
  return POST(req as never, { params: Promise.resolve({ token }) });
}

describe("POST /t/[token]/inquiry 全体上限で断った要求は token の枠を消費しない", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("全体上限の間に断られた宛先も、全体の枠が空いた後は5回申し込める", async () => {
    // 全体の枠(120/時)を別々の宛先で埋める
    for (let i = 0; i < 120; i += 1) {
      expect((await call(`fill_${i}`)).status).toBe(200);
    }
    // 30分後、宛先 T が再試行を繰り返す → 全体上限で 429
    vi.setSystemTime(T0 + HOUR / 2);
    for (let i = 0; i < 3; i += 1) {
      expect((await call("tok_retry")).status).toBe(429);
    }
    // 全体の枠が空いた(最初の埋め分が窓の外)。T の token 枠(1時間)は、断られた分を数えていなければ満杯のまま
    vi.setSystemTime(T0 + HOUR + 1);
    for (let i = 0; i < 5; i += 1) {
      expect((await call("tok_retry")).status).toBe(200);
    }
    expect((await call("tok_retry")).status).toBe(429);
  });
});
