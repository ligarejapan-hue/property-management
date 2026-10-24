import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPasteDraft } from "../build-draft";
import {
  composePasteOwnerNote,
  goesToOwnerNote,
  MAX_PASTE_OWNER_NOTE_LENGTH,
  PASTE_IMPORT_OWNER_NOTE_PREFIX,
} from "../paste-owner-note";

const fixture = (f: string) => buildPasteDraft(readFileSync(join(__dirname, "fixtures", f), "utf8"));

describe("貼り付けのコメントを所有者の備考へ(2026-10-24 従業員の指摘)", () => {
  it("★HOME4U 空き家のコメントが所有者の備考に入る", () => {
    expect(composePasteOwnerNote(fixture("home4u-vacant-house.txt"))).toBe(
      `${PASTE_IMPORT_OWNER_NOTE_PREFIX}\nコメント: 売却を検討しているのでまずは査定をお願いしたい。`,
    );
  });

  it("★タカウルの売却する理由・ご要望は入り、お名前・フリガナ・年齢は入れない", () => {
    const note = composePasteOwnerNote(fixture("takauru-assessment.txt"));
    expect(note).toContain("売却する理由: 買い替え・住み替えのため");
    expect(note).toContain("物件のセールスポイント・ご要望等: 駅徒歩4分、東南向き");
    expect(note).not.toContain("佐藤");
    expect(note).not.toContain("サトウ");
    expect(note).not.toContain("45歳");
  });

  it("★見出しや値の形で伏せたもの(電話・住所・人名)は入れない", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■携帯電話： 090-1234-5678\n■連絡メモ： 東京都C区D4-5-6\n■担当： 山田太郎\n■コメント： よろしくお願いします。",
    );
    const note = composePasteOwnerNote(d);
    expect(note).toBe(`${PASTE_IMPORT_OWNER_NOTE_PREFIX}\nコメント: よろしくお願いします。`);
    expect(d.withheldFromNote.filter(goesToOwnerNote).map((w) => w.label)).toEqual(["コメント"]);
  });

  it("★文の中に電話番号・メールアドレスがある自由記述は入れない(人が移す)", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■コメント： 折り返しは090-1234-5678までお願いします\n■ご要望： ご連絡はfoo@example.com へ\n■売却する理由： 住み替えのため（築25年）",
    );
    expect(d.withheldFromNote.map((w) => w.reason)).toEqual(["unclassified", "unclassified", "unclassified"]);
    expect(composePasteOwnerNote(d)).toBe(`${PASTE_IMPORT_OWNER_NOTE_PREFIX}\n売却する理由: 住み替えのため（築25年）`);
  });

  it("★自由記述の欄だと分からない見出しは入れない(姓： Jonathan Smith・URL の欄など・@codex P1)", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■姓： Jonathan Smith\n■パンフレットを探す： https://example.jp/x\n■ご要望： 早めに知りたい",
    );
    expect(d.withheldFromNote.filter((w) => w.reason === "unclassified").map((w) => w.label)).toEqual(
      expect.arrayContaining(["姓", "パンフレットを探す", "ご要望"]),
    );
    expect(composePasteOwnerNote(d)).toBe(`${PASTE_IMPORT_OWNER_NOTE_PREFIX}\nご要望: 早めに知りたい`);
  });

  it("★上限を超えたら切り詰めて印を付ける(取込を止めない・@codex P2)", () => {
    const long = "あ".repeat(MAX_PASTE_OWNER_NOTE_LENGTH + 100);
    const note = composePasteOwnerNote({ withheldFromNote: [{ label: "コメント", value: long, reason: "unclassified" }] });
    expect(note!.length).toBe(MAX_PASTE_OWNER_NOTE_LENGTH);
    expect(note!.startsWith(`${PASTE_IMPORT_OWNER_NOTE_PREFIX}\nコメント: あ`)).toBe(true);
    expect(note!.endsWith("元の文面は取込元をご覧ください)")).toBe(true);
  });

  it("入れるものが無ければ null(年齢だけ=見出しで伏せたもの)", () => {
    expect(composePasteOwnerNote(fixture("home4u-assessment.txt"))).toBeNull();
    expect(composePasteOwnerNote({ withheldFromNote: [] })).toBeNull();
  });
});
