/**
 * 監査ログの「読めない／逆に残りすぎ」の是正（認可・PII 横断監査 2026-07-30）。
 *
 * 2方向の欠陥をまとめて固定する:
 *  (A) **読めない**: allowlist に「安全」と書いてあるのに denylist が先に当たって
 *      常に [REDACTED] になり、「誰に対する操作か」が監査から消えていた
 *      （ownerId / sourceOwnerId / targetOwnerId、調査ピンの他人閲覧監査）。
 *      #337 で field_survey の3 action を直した**同じ型の取り残し**。
 *  (B) **残りすぎ**: 所有者一覧の検索語（氏名・電話・住所そのもの）と、受付帳取込で
 *      作った所有者の氏名・住所・郵便番号が監査に平文で保存されていた。
 *
 * ⚠(A) と (B) は対になっている。**識別子は残し、PII は残さない**が方針。
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

const OWNER = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const PIN = "77777777-7777-4777-8777-777777777777";
const STAFF = "88888888-8888-4888-8888-888888888888";

describe("(A) 所有者の識別子が監査に残る（denylist に潰されない）", () => {
  it("owner_memo_create: 誰のメモを作ったかが残る", () => {
    const out = sanitizeAuditDetail("owner_memo_create", {
      ownerId: OWNER,
      memoId: "x",
    }) as Record<string, unknown>;
    expect(out.ownerId).toBe(OWNER);
  });

  it("owner_correction_merge: 統合元と統合先が残る", () => {
    const out = sanitizeAuditDetail("owner_correction_merge", {
      sourceOwnerId: OWNER,
      targetOwnerId: OTHER,
    }) as Record<string, unknown>;
    expect(out.sourceOwnerId).toBe(OWNER);
    expect(out.targetOwnerId).toBe(OTHER);
  });

  it("owner_correction_mislink: 付け替え前後の所有者が残る", () => {
    const out = sanitizeAuditDetail("owner_correction_mislink", {
      propertyOwnerId: "p-o",
      previousOwnerId: OWNER,
      newOwnerId: OTHER,
    }) as Record<string, unknown>;
    expect(out.previousOwnerId).toBe(OWNER);
    expect(out.newOwnerId).toBe(OTHER);
    expect(out.propertyOwnerId).toBe("p-o");
  });

  it("氏名・住所は同じ action でも伏せる（識別子だけを通す）", () => {
    // ⚠force-safe は**キー名を明示したものだけ**。ownerName 等は通さない。
    const out = sanitizeAuditDetail("owner_correction_merge", {
      sourceOwnerId: OWNER,
      ownerName: "山田太郎",
      ownerAddress: "東京都…",
    }) as Record<string, unknown>;
    expect(out.sourceOwnerId).toBe(OWNER);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.ownerAddress).toBe(REDACTED);
  });

  it("登録の無い action では所有者の識別子も伏せる（action 固有であること）", () => {
    const out = sanitizeAuditDetail("some_unknown_action", {
      ownerId: OWNER,
      sourceOwnerId: OWNER,
    }) as Record<string, unknown>;
    expect(out.ownerId).toBe(REDACTED);
    expect(out.sourceOwnerId).toBe(REDACTED);
  });
});

describe("(A) 調査ピンの他人閲覧監査が読める（#337 の取り残し）", () => {
  it("field_survey_pin_view: どのピンを・誰のものを見たかが残る", () => {
    const out = sanitizeAuditDetail("field_survey_pin_view", {
      pinId: PIN,
      ownerStaffUserId: STAFF,
      hasProperty: true,
    }) as Record<string, unknown>;
    expect(out.pinId).toBe(PIN);
    expect(out.ownerStaffUserId).toBe(STAFF);
    expect(out.hasProperty).toBe(true);
  });

  it("field_survey_pin_list_others: 対象スタッフと件数・絞り込みの有無が残る", () => {
    const out = sanitizeAuditDetail("field_survey_pin_list_others", {
      viewedStaffUserId: STAFF,
      pinsReturned: 12,
      hasSessionFilter: true,
      hasPropertyFilter: false,
    }) as Record<string, unknown>;
    expect(out.viewedStaffUserId).toBe(STAFF);
    expect(out.pinsReturned).toBe(12);
    expect(out.hasSessionFilter).toBe(true);
    expect(out.hasPropertyFilter).toBe(false);
  });

  it("座標・メモを混ぜても伏せる（ピンの中身は監査に出さない）", () => {
    const out = sanitizeAuditDetail("field_survey_pin_view", {
      pinId: PIN,
      lat: 35.68,
      lng: 139.76,
      memo: "私用メモ",
    }) as Record<string, unknown>;
    expect(out.pinId).toBe(PIN);
    expect(out.lat).toBe(REDACTED);
    expect(out.lng).toBe(REDACTED);
    expect(out.memo).toBe(REDACTED);
  });
});

describe("(B) PII は監査に残さない（残すのは長さ・有無だけ）", () => {
  it("owner_list: 検索語の長さは残り、語そのものは載らない", () => {
    const out = sanitizeAuditDetail("owner_list", {
      keywordLen: 5,
      page: 2,
      resultCount: 30,
    }) as Record<string, unknown>;
    expect(out.keywordLen).toBe(5);
    expect(out.page).toBe(2);
    expect(out.resultCount).toBe(30);
  });

  it("owner_list: 万一 keyword が入っても表示側で伏せられる（二重の防御）", () => {
    // route 側で保存しない形にしたが、**過去に保存された行**も監査画面で
    // 伏せられることを確認する（keyword は denylist の完全一致）。
    const out = sanitizeAuditDetail("owner_list", {
      keyword: "山田太郎",
      keywordLen: 4,
    }) as Record<string, unknown>;
    expect(out.keyword).toBe(REDACTED);
    expect(out.keywordLen).toBe(4);
  });

  it("owner_created_from_reception: 項目の有無だけが残り、氏名住所は伏せる", () => {
    const out = sanitizeAuditDetail("owner_created_from_reception", {
      hasAddress: true,
      hasZip: false,
      // 過去に保存された行の生 PII も伏せられること
      name: "山田太郎",
      address: "東京都杉並区…",
      zip: "1670042",
    }) as Record<string, unknown>;
    expect(out.hasAddress).toBe(true);
    expect(out.hasZip).toBe(false);
    expect(out.name).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
    expect(out.zip).toBe(REDACTED);
  });
});

describe("route 側が PII を書かないこと（保存側の固定）", () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("node:fs") as typeof import("node:fs"))
      .readFileSync(p, "utf8")
      .replace(/\r\n/g, "\n");

  it("所有者一覧は検索語を監査に渡さない", () => {
    const src = read("src/app/api/owners/route.ts");
    expect(src).toContain("keywordLen: keyword.length");
    expect(src).not.toMatch(/detail: \{ keyword,/);
  });

  it("受付帳取込は氏名・住所・郵便番号を監査に渡さない", () => {
    const src = read("src/app/api/import/reception-owner/route.ts");
    expect(src).toContain("hasAddress: address != null");
    expect(src).not.toMatch(/detail: \{ name, address/);
  });
});
