import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/sale-dm-letter/inquiry-record", () => ({ recordInquiry: vi.fn() }));

import { POST } from "@/app/t/[token]/inquiry/route";
import { recordInquiry } from "@/lib/sale-dm-letter/inquiry-record";
import { writeAuditLog } from "@/lib/audit";

const rec = recordInquiry as unknown as ReturnType<typeof vi.fn>;
const VALID = { name: "山田", phone: "090-1234-5678", consent: "yes" };

// ⚠レート制限はモジュール保持でテスト間リセットされない。IP と token をテストごとに変える。
let seq = 0;
function call(fields: Record<string, string>, headers: Record<string, string> = {}, token?: string) {
  seq += 1;
  const tk = token ?? `tok_${seq}`;
  const body = new URLSearchParams(fields).toString();
  const req = new Request(`http://localhost:3000/t/${tk}/inquiry`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "app.ligarejapan.com",
      "x-forwarded-for": `10.9.${Math.floor(seq / 250)}.${seq % 250}`,
      ...headers,
    },
    body,
  });
  return POST(req as never, { params: Promise.resolve({ token: tk }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  rec.mockResolvedValue({ kind: "recorded", inquiryId: "inq1", draftId: "d1", first: true });
});

describe("POST /t/[token]/inquiry", () => {
  it("送付済み・正しい入力: 記録して完了ページ(200・no-store・same-origin)。監査は draftId と非PIIのみ", async () => {
    const res = await call(VALID, { origin: "https://app.ligarejapan.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(await res.text()).toContain("受け付けました");
    expect(rec).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^tok_/), {
      name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: null,
    });
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit).toMatchObject({ action: "sale_dm_inquiry_submit", targetTable: "dm_recipient_drafts", targetId: "d1" });
    expect(Object.keys(audit.detail).sort()).toEqual(["at", "first"]);
    expect(JSON.stringify(audit)).not.toMatch(/山田|090/);
  });

  it("よそのサイトからは 403(記録しない)", async () => {
    const res = await call(VALID, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(rec).not.toHaveBeenCalled();
  });

  it("Origin: null(実ブラウザ)は通す", async () => {
    const res = await call(VALID, { origin: "null" });
    expect(res.status).toBe(200);
  });

  it("honeypot が埋まっていれば記録せず完了ページ(監査もしない)", async () => {
    const res = await call({ ...VALID, website: "http://spam" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(rec).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("入力不備は 422。文言と戻り先(#inquiry)を出し、入力値は送り返さない", async () => {
    const res = await call({ name: "山田", phone: "abc" }, {}, "tok_back");
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("電話番号は数字とハイフンで");
    expect(html).toContain("個人情報の取り扱いへの同意が必要です");
    expect(html).toContain('href="/t/tok_back#inquiry"');
    expect(html).not.toContain("山田");
    expect(rec).not.toHaveBeenCalled();
  });

  it("送付前は 409 プレビュー中ページ", async () => {
    rec.mockResolvedValueOnce({ kind: "not_sent" });
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("まだお申し込みを受け付けていません");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("未知 token は 404(記録・監査なし)", async () => {
    rec.mockResolvedValueOnce({ kind: "unknown" });
    const res = await call(VALID);
    expect(res.status).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("記録で例外が出たら 503 混雑ページ(黙って完了と言わない)", async () => {
    rec.mockRejectedValueOnce(new Error("lock timeout"));
    const res = await call(VALID);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("混み合っています");
  });

  it("同じ token は1時間に5回まで(6回目は 429・記録しない)", async () => {
    for (let i = 0; i < 5; i += 1) expect((await call(VALID, {}, "tok_limit")).status).toBe(200);
    const res = await call(VALID, {}, "tok_limit");
    expect(res.status).toBe(429);
    expect(rec).toHaveBeenCalledTimes(5);
  });

  it("同じ端末IPは1分に10回まで(11回目は 429)", async () => {
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      seq += 1;
      const res = await POST(new Request(`http://localhost:3000/t/tok_ip_${i}/inquiry`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "app.ligarejapan.com", "x-forwarded-for": "10.200.200.200" },
        body: new URLSearchParams(VALID).toString(),
      }) as never, { params: Promise.resolve({ token: `tok_ip_${i}` }) });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
