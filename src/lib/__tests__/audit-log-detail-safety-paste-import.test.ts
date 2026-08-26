import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

/**
 * 「貼り付けて物件化」の登録監査（@codex PR#414 4巡目 ⑥）。
 *
 * ⚠監査に残すには2段そろっている必要がある:
 *   ① route が detail に書く ② allowlist に載っている
 * ①だけだと記録はされるのに監査画面では [REDACTED] になり、
 * **所有者・紐付け・添付が実際に作られたのかが管理者に一切分からない**。
 */
const ACTION = "paste_import_property_create";

describe("paste_import_property_create の detail は表示でも消えない", () => {
  it("★記録している真偽値4つが全て見える", () => {
    const detail = {
      ownerCreated: true,
      ownerLinked: true,
      attachmentCreated: false,
      hasExternalKey: true,
    };
    const out = sanitizeAuditDetail(ACTION, detail) as Record<string, unknown>;
    expect(out).toEqual(detail);
    const redacted = Object.keys(detail).filter((k) => out[k] === REDACTED);
    expect(redacted, `伏せ字になったキー: ${redacted.join(", ")}`).toEqual([]);
  });

  it("★false も false のまま見える（伏せ字と区別できる）", () => {
    const out = sanitizeAuditDetail(ACTION, {
      ownerCreated: false,
      ownerLinked: false,
      attachmentCreated: false,
      hasExternalKey: false,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      ownerCreated: false,
      ownerLinked: false,
      attachmentCreated: false,
      hasExternalKey: false,
    });
  });

  it("★許可したのはこの4つだけ。氏名・住所・原文が紛れ込んでも伏せ字になる", () => {
    // 許可リストは「安全なものだけを並べる」方式。将来 route 側が誤って
    // PII を載せても、ここで止まることを固定する。
    const out = sanitizeAuditDetail(ACTION, {
      ownerCreated: true,
      ownerName: "山田太郎",
      ownerAddress: "東京都A区B1-2-3",
      phone: "09012345678",
      email: "a@example.jp",
      rawText: "■お名前： 山田太郎",
    }) as Record<string, unknown>;
    expect(out.ownerCreated).toBe(true);
    for (const k of ["ownerName", "ownerAddress", "phone", "email", "rawText"]) {
      expect(out[k], `${k} が漏れている`).toBe(REDACTED);
    }
  });

  it("★他の action では、この4つは許可されない（action 固有の許可であること）", () => {
    const out = sanitizeAuditDetail("some_other_action", {
      ownerCreated: true,
      attachmentCreated: true,
      hasExternalKey: true,
    }) as Record<string, unknown>;
    expect(out.ownerCreated).toBe(REDACTED);
    expect(out.attachmentCreated).toBe(REDACTED);
    expect(out.hasExternalKey).toBe(REDACTED);
  });
});
