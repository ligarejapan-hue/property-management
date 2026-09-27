import { describe, it, expect } from "vitest";
import { computeSaleDmGuideStep, SALE_DM_GUIDE_STEPS, guideStepIndex, guideTargetCandidates, isAheadOfGuide, guideTargetIds, type SaleDmGuideInput } from "../sale-dm-letter/step-guide";

// 2026-09-27 発注者決定(おすすめで): 売却DMの画面で次に押すボタンを光らせ、一言のアドバイスを出す。
// 手順は画面のデータ(宛先・型・LP型)から決める=どの端末で開いても同じ段にいる。印刷だけはデータに
// 残らないので、画面で「印刷」を押したかを別に渡す。
const base = (over: Partial<SaleDmGuideInput> = {}): SaleDmGuideInput => ({
  recipients: [{ status: "draft", body: "", lpVariantId: null, variantId: "v1" }],
  variants: [{ id: "v1", bodyTemplate: null }],
  lpVariants: [],
  printed: false,
  ...over,
});
const withLp = { lpVariants: [{ id: "l1", headline: "見出し" }] };
const withDm = { variants: [{ id: "v1", bodyTemplate: "本文" }] };

describe("computeSaleDmGuideStep", () => {
  it("宛先が0件なら no_recipients", () => {
    expect(computeSaleDmGuideStep(base({ recipients: [] }))).toBe("no_recipients");
  });
  it("LP型が無ければ add_lp", () => {
    expect(computeSaleDmGuideStep(base())).toBe("add_lp");
  });
  it("LP型はあるが文章が無ければ lp_text", () => {
    expect(computeSaleDmGuideStep(base({ lpVariants: [{ id: "l1", headline: null }] }))).toBe("lp_text");
  });
  it("お手紙の本文(型の原本)が無ければ dm_body", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp }))).toBe("dm_body");
  });
  it("未送付の宛先にLP型が割り当たっていなければ assign", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm }))).toBe("assign");
  });
  it("割り当て済みで、本文がまだ宛先に入っていなければ apply", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, recipients: [{ status: "draft", body: "", lpVariantId: "l1", variantId: "v1" }] }))).toBe("apply");
  });
  it("本文の入った下書きがあれば confirm", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, recipients: [{ status: "draft", body: "x", lpVariantId: "l1", variantId: "v1" }] }))).toBe("confirm");
  });
  it("確定済みがあり、まだ印刷していなければ print", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, recipients: [{ status: "confirmed", body: "x", lpVariantId: "l1", variantId: "v1" }] }))).toBe("print");
  });
  it("確定済みがあり、印刷したら sent", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, printed: true, recipients: [{ status: "confirmed", body: "x", lpVariantId: "l1", variantId: "v1" }] }))).toBe("sent");
  });
  it("全部送付済みなら done", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, recipients: [{ status: "sent", body: "x", lpVariantId: "l1", variantId: "v1" }] }))).toBe("done");
  });
  it("拒否・宛先不明の宛先は判定に入れない(印刷・送付を回り続けない・@codex #449 R3)", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, printed: true, recipients: [
      { status: "sent", body: "x", lpVariantId: "l1", variantId: "v1" },
      { status: "confirmed", body: "x", lpVariantId: "l1", variantId: "v1", terminalExcluded: true },
    ] }))).toBe("done_excluded");
  });
  it("送付済みの宛先は割当・適用の判定に入れない(送った後に型を足しても前の段へ戻さない)", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, recipients: [
      { status: "sent", body: "x", lpVariantId: null, variantId: "v1" },
    ] }))).toBe("done");
  });
  it("本文の原本がある型の宛先だけを「適用待ち」と数える(原本の無い型Bの空の宛先で止まらない)", () => {
    expect(computeSaleDmGuideStep(base({
      ...withLp,
      variants: [{ id: "v1", bodyTemplate: "本文" }, { id: "v2", bodyTemplate: null }],
      recipients: [
        { status: "draft", body: "x", lpVariantId: "l1", variantId: "v1" },
        { status: "draft", body: "", lpVariantId: "l1", variantId: "v2" },
      ],
    }))).toBe("confirm");
  });
});

describe("LP型が2つ以上(A/B)で、片方に文章が無いとき", () => {
  // 割り当てた先のLP型に文章が無いと、その宛先のQRはアプリ内のご案内ページにならない。
  // お手紙の本文と同じく、宛先ごとに「割り当てたLP型に文章があるか」で見る(事前レビューの指摘)。
  const lp2 = { lpVariants: [{ id: "l1", headline: "見出し" }, { id: "l2", headline: null }] };
  it("文章の無いLP型を割り当てた下書きがあれば、割当の後でも lp_text に戻す", () => {
    expect(computeSaleDmGuideStep(base({ ...lp2, ...withDm, recipients: [
      { status: "draft", body: "x", lpVariantId: "l1", variantId: "v1" },
      { status: "draft", body: "x", lpVariantId: "l2", variantId: "v1" },
    ] }))).toBe("lp_text");
  });
  it("文章の無いLP型に誰も割り当たっていなければ止めない", () => {
    expect(computeSaleDmGuideStep(base({ ...lp2, ...withDm, recipients: [
      { status: "draft", body: "x", lpVariantId: "l1", variantId: "v1" },
    ] }))).toBe("confirm");
  });
});

describe("LP型を使わずに進む(@codex #449 R4: LP型なし=外部LPへ転送も正式な使い方)", () => {
  it("skipLp なら LP型の2段を飛ばし、割当も要らない(LP型が無ければ lpVariantId=null のままでよい)", () => {
    expect(computeSaleDmGuideStep(base({ skipLp: true }))).toBe("dm_body");
    expect(computeSaleDmGuideStep(base({ skipLp: true, ...withDm }))).toBe("apply");
  });
  it("LP型を作ってあれば skipLp は効かない(作ったLP型は使う)", () => {
    expect(computeSaleDmGuideStep(base({ skipLp: true, lpVariants: [{ id: "l1", headline: null }] }))).toBe("lp_text");
  });
});

describe("残りが拒否・宛先不明だけのとき(@codex #449 R4)", () => {
  it("「すべて送付済み」と言わず、done_excluded", () => {
    expect(computeSaleDmGuideStep(base({ ...withLp, ...withDm, recipients: [
      { status: "sent", body: "x", lpVariantId: "l1", variantId: "v1" },
      { status: "confirmed", body: "x", lpVariantId: "l1", variantId: "v1", terminalExcluded: true },
    ] }))).toBe("done_excluded");
  });
});

describe("SALE_DM_GUIDE_STEPS", () => {
  it("手順の並び(画面の帯に出す順)", () => {
    expect(SALE_DM_GUIDE_STEPS.map((s) => s.key)).toEqual(["add_lp", "lp_text", "dm_body", "assign", "apply", "confirm", "print", "sent"]);
  });
  it("どの手順にも、帯の名前と一言のアドバイスがある", () => {
    for (const s of SALE_DM_GUIDE_STEPS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.tip.length).toBeGreaterThan(0);
    }
  });
  it("印刷は送付済みより前(送付済みの手紙は印刷に出ない)", () => {
    expect(guideStepIndex("print")).toBeLessThan(guideStepIndex("sent"));
  });
  it("帯に無い状態(no_recipients / done)は -1", () => {
    expect(guideStepIndex("done")).toBe(-1);
    expect(guideStepIndex("no_recipients")).toBe(-1);
  });
});


describe("guideTargetCandidates", () => {
  it("枠が開いていれば枠の中の保存を先に光らせる", () => {
    expect(guideTargetCandidates("add_lp")).toEqual(["add_lp_save", "add_lp"]);
    expect(guideTargetCandidates("lp_text")).toEqual(["lp_text_save", "lp_text"]);
    expect(guideTargetCandidates("dm_body")).toEqual(["dm_body_save", "dm_body"]);
  });
  it("本文を宛先へ: 適用ボタンが無ければ(枠が閉じていれば)型の書類のアイコン", () => {
    expect(guideTargetCandidates("apply")).toEqual(["apply", "dm_body"]);
  });
  it("ほかはその段のボタンだけ", () => {
    expect(guideTargetCandidates("print")).toEqual(["print"]);
  });
});

describe("isAheadOfGuide(順番の違うボタンを押したとき)", () => {
  it("先の段のボタンなら true(=先にやることを一言出す)", () => {
    expect(isAheadOfGuide("print", "confirm")).toBe(true);
    expect(isAheadOfGuide("apply", "assign")).toBe(true);
  });
  it("いまの段・済んだ段のボタンは false(黙って通す)", () => {
    expect(isAheadOfGuide("confirm", "confirm")).toBe(false);
    expect(isAheadOfGuide("dm_body_save", "print")).toBe(false);
    expect(isAheadOfGuide("assign", "sent")).toBe(false);
  });
  it("保存ボタン(_save)はその段として扱う", () => {
    expect(isAheadOfGuide("lp_text_save", "add_lp")).toBe(true);
  });
  it("宛先0件・全部送付済みでは出さない", () => {
    expect(isAheadOfGuide("print", "done")).toBe(false);
    expect(isAheadOfGuide("print", "no_recipients")).toBe(false);
  });
});

describe("guideTargetIds(光らせる型・LP型=先頭固定にしない・@codex #449 R1)", () => {
  const lp = { lpVariants: [{ id: "l1", headline: "見出し" }] };
  it("お手紙の本文: 原本の無い型Bの宛先が残っていれば型Bを光らせる(原本のある型Aではない)", () => {
    const r = guideTargetIds({ ...lp, variants: [{ id: "vA", bodyTemplate: "本文" }, { id: "vB", bodyTemplate: null }],
      recipients: [{ status: "draft", body: "", lpVariantId: "l1", variantId: "vB" }] });
    expect(computeSaleDmGuideStep({ ...lp, variants: [{ id: "vA", bodyTemplate: "本文" }, { id: "vB", bodyTemplate: null }], recipients: [{ status: "draft", body: "", lpVariantId: "l1", variantId: "vB" }], printed: false })).toBe("dm_body");
    expect(r.dmVariantId).toBe("vB");
  });
  it("本文を宛先へ: 原本があって本文の空いた宛先がいる型", () => {
    const r = guideTargetIds({ ...lp, variants: [{ id: "vA", bodyTemplate: "本文" }, { id: "vB", bodyTemplate: "本文B" }],
      recipients: [
        { status: "draft", body: "x", lpVariantId: "l1", variantId: "vA" },
        { status: "draft", body: "", lpVariantId: "l1", variantId: "vB" },
      ] });
    expect(r.dmVariantId).toBe("vB");
  });
  it("本文を宛先へ: 原本の無い型Aが先にあっても、適用できる型Bを指す(段の決め方と揃える・@codex #449 R5)", () => {
    const input = { ...lp, variants: [{ id: "vA", bodyTemplate: null }, { id: "vB", bodyTemplate: "本文B" }],
      recipients: [
        { status: "draft", body: "", lpVariantId: "l1", variantId: "vA" },
        { status: "draft", body: "", lpVariantId: "l1", variantId: "vB" },
      ] };
    expect(computeSaleDmGuideStep({ ...input, printed: false })).toBe("apply");
    expect(guideTargetIds(input).dmVariantId).toBe("vB");
  });
  it("LP型の文章: 宛先に割り当たっている文章なしのLP型を優先(使われていない空のLP型ではない)", () => {
    const r = guideTargetIds({
      variants: [{ id: "v1", bodyTemplate: "本文" }],
      lpVariants: [{ id: "l1", headline: "見出し" }, { id: "l2", headline: null }, { id: "l3", headline: null }],
      recipients: [{ status: "draft", body: "x", lpVariantId: "l3", variantId: "v1" }],
    });
    expect(r.lpVariantId).toBe("l3");
  });
  it("割り当て前は、文章の無いLP型の先頭", () => {
    const r = guideTargetIds({ variants: [{ id: "v1", bodyTemplate: null }], lpVariants: [{ id: "l1", headline: "x" }, { id: "l2", headline: null }],
      recipients: [{ status: "draft", body: "", lpVariantId: null, variantId: "v1" }] });
    expect(r.lpVariantId).toBe("l2");
  });
});
