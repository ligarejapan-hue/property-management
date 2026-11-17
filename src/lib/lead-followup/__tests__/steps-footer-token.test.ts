import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  DEFAULT_FOLLOWUP_DELAYS,
  defaultFollowupSlots,
  followupOrderProblems,
  followupStepsEnableProblems,
  followupStepsSchema,
  followupDelayLabel,
} from "@/lib/lead-followup/steps";
import {
  FIRST_MAIL_NOTICE,
  buildFollowupFooter,
  composeFollowupText,
  followupSenderProblems,
  normalizeFollowupSender,
} from "@/lib/lead-followup/footer";
import {
  buildFollowupUnsubscribeToken,
  buildFollowupUnsubscribeUrl,
  isFollowupUnsubscribeToken,
  verifyFollowupUnsubscribeToken,
} from "@/lib/lead-followup/unsubscribe-token";
import { buildBatchItemUnsubscribeToken, verifyBatchItemUnsubscribeToken } from "@/lib/dm-batch/unsubscribe-token";
import { deriveUnsubscribeKey, parseUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/sale-dm-letter/unsubscribe-token";

const step = (delayDays: number, subject = "件名", body = "本文") => ({ delayDays, subject, body });

describe("追客の文面の決まり", () => {
  it("最初の枠は発注者のイメージの日数(件名・本文は空)", () => {
    const slots = defaultFollowupSlots();
    expect(slots.new.map((s) => s.delayDays)).toEqual([0, 3, 7, 30, 90, 180]);
    expect(slots.hold.map((s) => s.delayDays)).toEqual([7, 30, 90, 180]);
    expect([...slots.new, ...slots.hold].every((s) => s.subject === "" && s.body === "")).toBe(true);
    expect(DEFAULT_FOLLOWUP_DELAYS.new[0]).toBe(0);
  });

  it("日数は後の通ほど大きい・0日は新規の1通目だけ・各流れ10通まで", () => {
    expect(followupOrderProblems({ new: [step(0), step(3), step(7)], hold: [step(7), step(30)] })).toEqual([]);
    expect(followupOrderProblems({ new: [step(3), step(3)], hold: [] })[0]).toContain("前の通より大きく");
    expect(followupOrderProblems({ new: [step(0), step(0)], hold: [] }).join()).toContain("0日後にできるのは");
    expect(followupOrderProblems({ new: [], hold: [step(0)] }).join()).toContain("0日後にできるのは");
    const eleven = Array.from({ length: 11 }, (_, i) => step(i + 1));
    expect(followupOrderProblems({ new: eleven, hold: [] }).join()).toContain("10通まで");
  });

  it("スキーマ: 件名は1行・制御文字なし・字数・日数の範囲。本文の改行はそろえる", () => {
    const ok = followupStepsSchema.safeParse({ new: [step(0, " あいさつ ", "1行目\r\n2行目")], hold: [] });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.new[0].subject).toBe("あいさつ");
      expect(ok.data.new[0].body).toBe("1行目\n2行目");
    }
    expect(followupStepsSchema.safeParse({ new: [step(0, "a\nb")], hold: [] }).success).toBe(false);
    expect(followupStepsSchema.safeParse({ new: [step(0, "a", "b\u0000")], hold: [] }).success).toBe(false);
    expect(followupStepsSchema.safeParse({ new: [step(366)], hold: [] }).success).toBe(false);
    expect(followupStepsSchema.safeParse({ new: [step(1.5)], hold: [] }).success).toBe(false);
    expect(followupStepsSchema.safeParse({ new: [step(0, "x".repeat(121))], hold: [] }).success).toBe(false);
    expect(followupStepsSchema.safeParse({ new: [step(0, "a", "x".repeat(4001))], hold: [] }).success).toBe(false);
    expect(followupStepsSchema.safeParse({ new: [step(3), step(3)], hold: [] }).success).toBe(false);
  });

  it("ON にするには1通以上・全部の通に件名と本文が要る", () => {
    expect(followupStepsEnableProblems({ new: [], hold: [] })).toEqual(["文面が1通もありません"]);
    expect(followupStepsEnableProblems(defaultFollowupSlots()).length).toBe(10);
    expect(followupStepsEnableProblems({ new: [step(0)], hold: [step(7, " ", "本文")] })).toEqual([
      "保留の流れの1通目の件名か本文が空です",
    ]);
    expect(followupStepsEnableProblems({ new: [step(0)], hold: [step(7)] })).toEqual([]);
  });

  it("日数の見出し", () => {
    expect(followupDelayLabel("new", 0)).toBe("登録の直後");
    expect(followupDelayLabel("new", 3)).toBe("登録から3日後");
    expect(followupDelayLabel("hold", 30)).toBe("保留になった日から30日後");
  });
});

describe("末尾の法律の表示", () => {
  const sender = normalizeFollowupSender({ companyName: "見本不動産", address: "見本県見本市1-2-3", tel: "00-0000-0000", email: null });

  it("会社名・住所・問い合わせ先(電話かメール)・外向きの URL が欠けたら、それぞれ足りないと返す", () => {
    expect(followupSenderProblems(sender, "https://example.test")).toEqual([]);
    const empty = normalizeFollowupSender({ companyName: " ", address: null, tel: "", email: null });
    const problems = followupSenderProblems(empty, undefined);
    expect(problems).toHaveLength(4);
    expect(problems.join()).toContain("会社名");
    expect(problems.join()).toContain("住所");
    expect(problems.join()).toContain("電話番号もメールアドレスも");
    expect(problems.join()).toContain("外向きのURL");
    expect(followupSenderProblems({ ...sender, tel: null, email: "info@example.test" }, "https://x.test")).toEqual([]);
  });

  it("会社の設定の改行は1行にまとめる", () => {
    expect(normalizeFollowupSender({ address: "見本県\n見本市" }).address).toBe("見本県 見本市");
  });

  it("最初の1通だけ「お心当たりのない場合」を足す。配信停止の URL は必ず入る", () => {
    const first = buildFollowupFooter({ sender, unsubscribeUrl: "https://example.test/u/fx", first: true });
    const later = buildFollowupFooter({ sender, unsubscribeUrl: "https://example.test/u/fx", first: false });
    expect(first.startsWith(FIRST_MAIL_NOTICE)).toBe(true);
    expect(later).not.toContain(FIRST_MAIL_NOTICE);
    for (const text of [first, later]) {
      expect(text).toContain("送信者: 見本不動産");
      expect(text).toContain("住所: 見本県見本市1-2-3");
      expect(text).toContain("お問い合わせ: 00-0000-0000");
      expect(text.trimEnd().endsWith("https://example.test/u/fx")).toBe(true);
    }
  });

  it("本文+空行+末尾。本文の末尾の空白はまとめる", () => {
    expect(composeFollowupText("こんにちは\n\n\n", "末尾")).toBe("こんにちは\n\n末尾\n");
  });
});

describe("配信停止のリンク(f形式)", () => {
  const key = deriveUnsubscribeKey("test-secret-for-followup");
  const ID = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";

  it("作る→確かめると行の id に戻る。URL は /u/ の下", () => {
    const token = buildFollowupUnsubscribeToken(ID, key);
    expect(token).toMatch(/^f[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(isFollowupUnsubscribeToken(token)).toBe(true);
    expect(verifyFollowupUnsubscribeToken(token, key)).toBe(ID);
    expect(buildFollowupUnsubscribeUrl(ID, "https://example.test/", key)).toBe(`https://example.test/u/${token}`);
  });

  it("別の鍵・書き換えた署名・形の違うものは通らない", () => {
    const token = buildFollowupUnsubscribeToken(ID, key);
    expect(verifyFollowupUnsubscribeToken(token, crypto.randomBytes(32))).toBeNull();
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyFollowupUnsubscribeToken(flipped, key)).toBeNull();
    expect(verifyFollowupUnsubscribeToken(token.replace(/^f/, "c"), key)).toBeNull();
    expect(() => buildFollowupUnsubscribeToken("not-a-uuid", key)).toThrow();
  });

  it("用途ラベルが違う=宛名CSV・手紙の署名とは使い回せない(どちら向きも)", () => {
    const batch = buildBatchItemUnsubscribeToken(ID, key);
    const asFollowup = `f${batch.slice(1)}`;
    expect(verifyFollowupUnsubscribeToken(asFollowup, key)).toBeNull();
    const followup = buildFollowupUnsubscribeToken(ID, key);
    expect(verifyBatchItemUnsubscribeToken(`c${followup.slice(1)}`, key)).toBeNull();
    // 手紙の形式門前払いの内側に収まる(=/u/ の入口をそのまま使える)が、手紙の署名としては通らない。
    expect(parseUnsubscribeToken(followup)).not.toBeNull();
    expect(verifyUnsubscribeToken(followup, key)).toBeNull();
  });
});
