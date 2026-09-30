import { describe, it, expect } from "vitest";
import {
  AUTO_REPLY_LIMITS,
  buildInquiryAutoReplyMail,
  defaultAutoReplyBody,
  defaultAutoReplySubject,
} from "@/lib/sale-dm-letter/inquiry-auto-reply-mail";

const SENDER = { senderName: "LigareJapan", senderContact: "03-1234-5678" };
const NO_SENDER = { senderName: null, senderContact: null };

describe("申込者への受付メールの文面", () => {
  it("既定の件名は差出人名つき・差出人名が無ければ名前なし", () => {
    expect(defaultAutoReplySubject(SENDER)).toBe("【LigareJapan】査定のお申し込みを受け付けました");
    expect(defaultAutoReplySubject(NO_SENDER)).toBe("査定のお申し込みを受け付けました");
    expect(defaultAutoReplySubject({ senderName: "   ", senderContact: null })).toBe("査定のお申し込みを受け付けました");
  });

  it("既定の本文は受付の旨・心当たりのない場合の一文・差出人名と連絡先", () => {
    const body = defaultAutoReplyBody(SENDER);
    expect(body).toContain("査定のお申し込みをいただき、ありがとうございます");
    expect(body).toContain("担当者よりご連絡いたします");
    expect(body).toContain("お心当たりのない場合");
    expect(body.endsWith("LigareJapan\n03-1234-5678")).toBe(true);
  });

  it("差出人名も連絡先も無ければ署名を付けない(空行で終わらない)", () => {
    const body = defaultAutoReplyBody(NO_SENDER);
    expect(body).not.toMatch(/\n$/);
    expect(body.endsWith("このメールを破棄してください。")).toBe(true);
  });

  it("画面で入れた件名・本文があればそれを使う", () => {
    const mail = buildInquiryAutoReplyMail({ subject: "受付のお知らせ", body: "ありがとうございました。\n2行目" }, SENDER);
    expect(mail).toEqual({ subject: "受付のお知らせ", text: "ありがとうございました。\n2行目" });
  });

  it("空・空白だけ・null は既定の文面に戻る(件名と本文は別々に判定)", () => {
    expect(buildInquiryAutoReplyMail({ subject: null, body: null }, SENDER)).toEqual({
      subject: defaultAutoReplySubject(SENDER),
      text: defaultAutoReplyBody(SENDER),
    });
    const mixed = buildInquiryAutoReplyMail({ subject: "  \n ", body: "本文だけ変える" }, SENDER);
    expect(mixed.subject).toBe(defaultAutoReplySubject(SENDER));
    expect(mixed.text).toBe("本文だけ変える");
  });

  it("件名は1行にし、上限で切る(ヘッダに改行を入れない)", () => {
    const mail = buildInquiryAutoReplyMail({ subject: "1行目\r\n2行目", body: null }, SENDER);
    expect(mail.subject).toBe("1行目 2行目");
    const long = buildInquiryAutoReplyMail({ subject: "あ".repeat(AUTO_REPLY_LIMITS.subject + 30), body: null }, SENDER);
    expect([...long.subject]).toHaveLength(AUTO_REPLY_LIMITS.subject);
    const name = defaultAutoReplySubject({ senderName: "会社\n名", senderContact: null });
    expect(name).not.toMatch(/[\r\n]/);
  });

  it("本文の改行は LF にそろえる", () => {
    expect(buildInquiryAutoReplyMail({ subject: null, body: "a\r\nb\rc" }, SENDER).text).toBe("a\nb\nc");
  });

  it("⚠申込者の入力を受け取る引数が無い(お名前・電話・要望を文面に混ぜられない)", () => {
    // 引数は「画面の文面」と「差出人」の2つだけ。申込の行を渡す口を作らないことで、
    // 他人のアドレスに届いても入力内容が漏れないことを形で保証する。
    expect(buildInquiryAutoReplyMail.length).toBe(2);
  });
});
