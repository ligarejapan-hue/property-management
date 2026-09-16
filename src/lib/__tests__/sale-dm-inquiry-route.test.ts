import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { dmRecipientDraft: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/sale-dm-letter/inquiry-record", () => ({ recordInquiry: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmPublicPageConfig: vi.fn() }));

import { POST } from "@/app/t/[token]/inquiry/route";
import { recordInquiry } from "@/lib/sale-dm-letter/inquiry-record";
import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { HONEYPOT_FIELD } from "@/lib/sale-dm-letter/inquiry-input";

const rec = recordInquiry as unknown as ReturnType<typeof vi.fn>;
const findUnique = (
  prisma as unknown as {
    dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> };
  }
).dmRecipientDraft.findUnique;
const loadCfg = loadSaleDmPublicPageConfig as unknown as ReturnType<typeof vi.fn>;
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
  loadCfg.mockResolvedValue({
    senderName: null, senderContact: null, trackingBaseUrl: undefined, lpPublicEnabled: true, privacyText: null,
  });
  rec.mockResolvedValue({ kind: "recorded", inquiryId: "inq1", draftId: "d1", first: true });
  findUnique.mockImplementation(
    async ({ where }: { where: { trackingToken: string } }) =>
      where.trackingToken.startsWith("junk")
        ? null
        : { id: "d1", lpVariant: { headline: "見出し", bodyText: "本文" } },
  );
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
    const res = await call({ ...VALID, [HONEYPOT_FIELD]: "http://spam" });
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

  it("記録がロック下の再読取で no_form(LP型が描画不能)を返したら 404(監査なし)", async () => {
    rec.mockResolvedValueOnce({ kind: "no_form" });
    const res = await call(VALID);
    expect(res.status).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("記録で例外が出たら 503 混雑ページ(黙って完了と言わない)。ログは許可リスト(name/code)だけ", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      rec.mockRejectedValueOnce(Object.assign(new Error("lock timeout 山田"), { code: "P2034" }));
      const res = await call(VALID);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("混み合っています");
      expect(spy).toHaveBeenCalledWith("[sale_dm_inquiry] record failed", expect.any(Object));
      const logged = spy.mock.calls.find((c) => c[0] === "[sale_dm_inquiry] record failed")!;
      expect(Object.keys(logged[1] as object).sort()).toEqual(["code", "name"]);
      expect(logged[1]).toEqual({ name: "Error", code: "P2034" });
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/lock timeout|山田|090/);
    } finally {
      spy.mockRestore();
    }
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

  it("形式外の token は DB に触らず 404", async () => {
    const dotRes = await call(VALID, {}, "bad.token");
    expect(dotRes.status).toBe(404);
    const longRes = await call(VALID, {}, "a".repeat(65));
    expect(longRes.status).toBe(404);
    expect(findUnique).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });

  it("存在しない token は 404 で、token/全体の枠を消費しない", async () => {
    for (let i = 0; i < 130; i += 1) {
      const res = await call(VALID, {}, `junk_${i}`);
      expect(res.status).toBe(404);
    }
    expect(rec).not.toHaveBeenCalled();
    const res = await call(VALID, {}, `tok_exists_${seq}`);
    expect(res.status).toBe(200);
    expect(rec).toHaveBeenCalledTimes(1);
  });

  it("存在確認で LP型が描画不能(headline/bodyText とも空)な token は 404 で記録・回数制限の枠を消費しない", async () => {
    findUnique.mockImplementation(async () => ({ id: "d1", lpVariant: null }));
    for (let i = 0; i < 6; i += 1) {
      const res = await call(VALID, {}, "tok_no_form");
      expect(res.status).toBe(404);
    }
    expect(rec).not.toHaveBeenCalled();
    // token 枠(5/時)を消費していない: 描画可能な別 token(同じ関数呼び出し内で切替)ならまだ通る
    findUnique.mockImplementation(
      async ({ where }: { where: { trackingToken: string } }) =>
        where.trackingToken === "tok_no_form"
          ? { id: "d1", lpVariant: null }
          : { id: "d1", lpVariant: { headline: "見出し", bodyText: "本文" } },
    );
    expect((await call(VALID, {}, "tok_no_form")).status).toBe(404);
  });

  it("存在確認で例外なら 503。ログは許可リスト(name/code)だけ", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      findUnique.mockRejectedValueOnce(new Error("db down"));
      const res = await call(VALID);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("混み合っています");
      expect(rec).not.toHaveBeenCalled();
      const logged = spy.mock.calls.find((c) => c[0] === "[sale_dm_inquiry] existence lookup failed");
      expect(logged).toBeDefined();
      expect(Object.keys(logged![1] as object).sort()).toEqual(["code", "name"]);
      expect(logged![1]).toEqual({ name: "Error", code: null });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("db down");
    } finally {
      spy.mockRestore();
    }
  });

  it("公開ロールアウトゲートが無効なら 404(DB・回数制限・記録に触らない)", async () => {
    loadCfg.mockResolvedValue({
      senderName: null, senderContact: null, trackingBaseUrl: undefined, lpPublicEnabled: false, privacyText: null,
    });
    for (let i = 0; i < 7; i += 1) {
      const res = await call(VALID, {}, "tok_gate");
      expect(res.status).toBe(404);
    }
    expect(findUnique).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
    // token 枠(5/時)を消費していない
    loadCfg.mockResolvedValue({
      senderName: null, senderContact: null, trackingBaseUrl: undefined, lpPublicEnabled: true, privacyText: null,
    });
    expect((await call(VALID, {}, "tok_gate")).status).toBe(200);
  });

  it("設定の読み込みで例外なら無効扱いで 404", async () => {
    loadCfg.mockRejectedValueOnce(new Error("config down"));
    const res = await call(VALID);
    expect(res.status).toBe(404);
    expect(findUnique).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });
});

describe("POST /t/[token]/inquiry 本文の大きさと形式(読む前に絞る)", () => {
  it("フォーム形式以外(JSON・multipart)は 415。存在確認も記録もしない", async () => {
    for (const ct of ["application/json", "multipart/form-data; boundary=x"]) {
      const res = await call(VALID, { "content-type": ct });
      expect(res.status).toBe(415);
      expect(await res.text()).toContain("受け付けられませんでした");
    }
    expect(findUnique).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });

  it("charset 付きの urlencoded は従来どおり受け付ける(200)", async () => {
    const res = await call(VALID, { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" });
    expect(res.status).toBe(200);
    expect(rec).toHaveBeenCalledTimes(1);
  });

  it("content-length が上限(32KB)超なら本文を読まずに 413", async () => {
    const res = await call(VALID, { "content-length": "40000" });
    expect(res.status).toBe(413);
    expect(findUnique).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });

  it("content-length が数字でなければ 413", async () => {
    const res = await call(VALID, { "content-length": "12abc" });
    expect(res.status).toBe(413);
    expect(rec).not.toHaveBeenCalled();
  });

  it("content-length なし(分割送信)でも 32KB を超えた時点で 413", async () => {
    seq += 1;
    const tk = `tok_chunk_${seq}`;
    const chunk = new TextEncoder().encode("message=" + "a".repeat(9_992));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new Request(`http://localhost:3000/t/${tk}/inquiry`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        host: "app.ligarejapan.com",
        "x-forwarded-for": `10.7.0.${seq % 250}`,
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await POST(req as never, { params: Promise.resolve({ token: tk }) });
    expect(res.status).toBe(413);
    expect(findUnique).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });
});

describe("POST /t/[token]/inquiry accept: application/json(画面を離れずに結果を返す)", () => {
  const JSON_ACCEPT = { accept: "application/json" };

  async function expectJson(res: Response, status: number, body: unknown) {
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(body);
    return text;
  }

  it("完了は {result:done}(200)。honeypot でも同じ", async () => {
    await expectJson(await call(VALID, JSON_ACCEPT), 200, { result: "done" });
    await expectJson(await call({ ...VALID, [HONEYPOT_FIELD]: "http://spam" }, JSON_ACCEPT), 200, { result: "done" });
    expect(rec).toHaveBeenCalledTimes(1);
  });

  it("入力不備は {result:invalid, messages}(422)。入力値は含めない", async () => {
    const text = await expectJson(
      await call({ name: "山田", phone: "(03)1234", email: "yamada@example" }, JSON_ACCEPT),
      422,
      {
        result: "invalid",
        messages: expect.arrayContaining([
          expect.stringContaining("電話番号は数字とハイフンで"),
          "個人情報の取り扱いへの同意が必要です。",
        ]),
      },
    );
    expect(text).not.toMatch(/山田|\(03\)|yamada/);
    expect(rec).not.toHaveBeenCalled();
  });

  it("送付前は {result:preview}(409)", async () => {
    rec.mockResolvedValueOnce({ kind: "not_sent" });
    await expectJson(await call(VALID, JSON_ACCEPT), 409, { result: "preview" });
  });

  it("受け付けられない要求は {result:unavailable} で状態コードは保つ(415・404)", async () => {
    await expectJson(
      await call(VALID, { ...JSON_ACCEPT, "content-type": "application/json" }),
      415,
      { result: "unavailable" },
    );
    await expectJson(await call(VALID, JSON_ACCEPT, "junk_json"), 404, { result: "unavailable" });
  });

  it("回数制限は {result:throttled}(429)", async () => {
    for (let i = 0; i < 5; i += 1) expect((await call(VALID, JSON_ACCEPT, "tok_json_limit")).status).toBe(200);
    await expectJson(await call(VALID, JSON_ACCEPT, "tok_json_limit"), 429, { result: "throttled" });
  });

  it("記録の例外は {result:busy}(503)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      rec.mockRejectedValueOnce(new Error("lock timeout"));
      await expectJson(await call(VALID, JSON_ACCEPT), 503, { result: "busy" });
    } finally {
      spy.mockRestore();
    }
  });

  it("accept が HTML なら従来どおり HTML ページ", async () => {
    const res = await call({ name: "山田", phone: "abc" }, { accept: "text/html,application/xhtml+xml" });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(await res.text()).toContain("入力内容をご確認ください");
  });
});
