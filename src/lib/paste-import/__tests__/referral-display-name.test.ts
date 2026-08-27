/**
 * 反響資料の保存名は定型（@codex PR#414 16巡目 ①）。
 * ⚠元名「佐藤花子様査定依頼.pdf」のように、**名前自体が個人情報を含み得る**。
 *   添付一覧・検索・ゴミ箱にそのまま出るため、非PIIの材料だけで組み立てる。
 */
import { describe, it, expect } from "vitest";
import {
  referralDisplayName,
  REFERRAL_ATTACHMENT_TYPE,
  referralContentDisposition,
} from "@/lib/attachments/referral-display-name";

describe("referralDisplayName", () => {
  it("★日本時間の日付で組み立てる", () => {
    // UTC の深夜は日本時間では翌日。実行環境のローカル時刻に頼らない。
    expect(referralDisplayName(new Date("2026-08-25T16:00:00Z"))).toBe("反響資料_2026-08-26.pdf");
    expect(referralDisplayName(new Date("2026-08-26T02:00:00Z"))).toBe("反響資料_2026-08-26.pdf");
  });

  it("★元のファイル名が混ざらない（材料は種類と日付だけ）", () => {
    const name = referralDisplayName(new Date("2026-08-26T02:00:00Z"));
    expect(name).not.toContain("佐藤");
    expect(name).not.toContain("査定依頼");
    expect(name).toMatch(/^反響資料_\d{4}-\d{2}-\d{2}\.pdf$/);
  });

  it("日付が無ければ日付を付けない", () => {
    expect(referralDisplayName()).toBe("反響資料.pdf");
    expect(referralDisplayName(null)).toBe("反響資料.pdf");
  });

  it("種類の値は referral", () => {
    expect(REFERRAL_ATTACHMENT_TYPE).toBe("referral");
  });
});

describe("referralContentDisposition（24巡目）", () => {
  it("preview は inline", () => {
    expect(referralContentDisposition({ downloadIntent: false })).toBe("inline");
  });

  it("★download は定型名。元のファイル名は使わない", () => {
    const cd = referralContentDisposition({
      downloadIntent: true,
      createdAt: new Date("2026-08-25T16:00:00.000Z"),
    });
    expect(cd).toContain("attachment");
    expect(cd).toContain('filename="referral.pdf"');
    // RFC5987 で符号化された日本語名（生の文字列はヘッダに出さない）。
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).not.toContain("反響資料_2026-08-26.pdf");
    // 復号すると定型名に戻る。
    const encoded = cd.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe("反響資料_2026-08-26.pdf");
  });

  it("★registry と同じ符号化の決まりを使う（写していない）", async () => {
    const { encodeRfc5987 } = await import("@/lib/attachments/registry-display-name");
    const cd = referralContentDisposition({
      downloadIntent: true,
      createdAt: new Date("2026-08-25T16:00:00.000Z"),
    });
    expect(cd).toContain(`filename*=UTF-8''${encodeRfc5987("反響資料_2026-08-26.pdf")}`);
  });
});
