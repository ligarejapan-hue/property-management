import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaleDmStepGuide } from "../../components/sale-dm/step-guide";
import { AiTextSteps } from "../../components/sale-dm/ai-text-steps";
import { SALE_DM_GUIDE_STEPS, guideTargetCandidates } from "../sale-dm-letter/step-guide";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n");
const PAGE = read("../../app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx");
const DM = read("../../components/sale-dm/variant-manager.tsx");
const LP = read("../../components/sale-dm/lp-variant-manager.tsx");
const GUIDE = read("../../components/sale-dm/step-guide.tsx");

describe("手順の案内の帯(サーバー描画=案内は既定で出る)", () => {
  it("いまの段を「次にやること」として出し、手順の並びと「案内を消す」がある", () => {
    const html = renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "assign" }));
    expect(html).toContain("次にやること");
    expect(html).toContain("均等に割り当て");
    expect(html).toContain("案内を消す");
    expect(html).toContain("光っているボタンへ移動");
    // 済んだ段は ✓、いまの段は aria-current
    expect(html).toContain("✓ LP型を作る");
    expect(html).toMatch(/aria-current="step"[^>]*>4\. 均等に割り当て/);
  });

  it("LP型を使わずに進む(@codex #449 R4): LP型を作る段で、渡されたときだけ出す", () => {
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "add_lp", onSkipLp: () => {} }))).toContain("LP型を使わずに進む");
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "add_lp" }))).not.toContain("LP型を使わずに進む");
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "dm_body", onSkipLp: () => {} }))).not.toContain("LP型を使わずに進む");
    expect(PAGE).toContain("skipLp,");
    expect(PAGE).toContain("(campaign?.lpVariants.length ?? 0) === 0");
  });
  it("残りが拒否・宛先不明だけのときは「すべて送付済み」と言わない(@codex #449 R4)", () => {
    const html = renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "done_excluded" }));
    expect(html).toContain("拒否・宛先不明");
    expect(html).toContain("送れる宛先は");
    expect(html).not.toContain("申込は「査定の申込」に届きます");
  });
  it("宛先0件・全部送付済みは、手順の並びの代わりに一文", () => {
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "no_recipients" }))).toContain("宛先がありません");
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "done" }))).toContain("すべて送付済みです");
  });

  it("「案内を消す」はこの端末に覚える(localStorage・読み書きの失敗は握って画面を止めない)", () => {
    expect(GUIDE).toContain('localStorage.setItem(STORAGE_KEY, "1")');
    expect(GUIDE).toMatch(/try \{\s*return window\.localStorage\.getItem/);
  });

  it("順番の違うボタンは止めずに(preventDefault しない)、先にやることを一言出す", () => {
    expect(GUIDE).toContain("isAheadOfGuide(key, state)");
    expect(GUIDE).toContain("先に「");
    expect(GUIDE).not.toContain("preventDefault");
  });
});

describe("光らせるボタンの目印(data-guide)が画面にそろっている", () => {
  const all = PAGE + DM + LP;
  it.each(SALE_DM_GUIDE_STEPS.flatMap((s) => guideTargetCandidates(s.key)))("%s", (key) => {
    expect(all).toMatch(new RegExp(`data-guide(=\\{[^}]*)?[="]+${key}"`));
  });
  it("案内をページに組み込み、段は画面のデータから決める", () => {
    expect(PAGE).toContain("<SaleDmStepGuide");
    expect(PAGE).toContain("state={guideState}");
    expect(PAGE).toContain("computeSaleDmGuideStep(");
  });
  it("印刷を押しただけでは進めず、「印刷できた」を押したときの確定済みの顔ぶれを覚える(@codex #449 R1 P1)", () => {
    // 印刷ボタンは「押した」を覚えるだけ(printedFor は書かない)。
    expect(PAGE).toContain("setPrintClickedFor(confirmedSig)");
    expect(PAGE).toContain("() => setPrintedFor(confirmedSig)");
    expect(PAGE).toContain("printedFor === confirmedSig");
    const printHandler = PAGE.slice(PAGE.indexOf("setPrintClickedFor(confirmedSig)") - 200, PAGE.indexOf("saleDmPrintUrl(campaignId)"));
    expect(printHandler).not.toContain("setPrintedFor(");
  });
  it("「印刷できた」は印刷の段で、印刷を押したあとだけ出る", () => {
    const withBtn = renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "print", onPrintConfirmed: () => {} }));
    expect(withBtn).toContain("印刷できた");
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "print" }))).not.toContain("印刷できた");
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "confirm", onPrintConfirmed: () => {} }))).not.toContain("印刷できた");
  });
  it("印刷済みの顔ぶれは印刷に出る確定済み(拒否・宛先不明を除く)で作る(@codex #449 R6)", () => {
    expect(PAGE).toContain('.filter((r) => r.status === "confirmed" && !r.terminalExcluded)');
  });
  it("目印(data-guide)が別のボタンへ移っても光りを付け直す(属性の変化も見る・@codex #449 R6)", () => {
    expect(GUIDE).toContain('attributeFilter: ["data-guide"]');
  });
  it("「確定」に拒否・宛先不明の宛先を入れない(1件でも含むとまとめて断られる・@codex #449 R5)", () => {
    expect(PAGE).toContain('.filter((r) => r.status === "draft" && r.body !== "" && !r.terminalExcluded)');
  });
  it("光らせる型・LP型は guideTargetIds で決める(先頭固定にしない・@codex #449 R1)", () => {
    expect(DM).toContain('data-guide={v.id === guideIds.dmVariantId ? "dm_body" : undefined}');
    expect(LP).toContain('data-guide={v.id === lpGuideId ? "lp_text" : undefined}');
  });
  it("開いている枠の保存・適用の目印は、その枠がいま要る型のときだけ(別の型の枠を光らせない・@codex #449 R2)", () => {
    expect(DM).toContain('data-guide={letterFor?.id === guideIds.dmVariantId ? "dm_body_save" : undefined}');
    expect(DM).toContain('data-guide={letterFor?.id === guideIds.dmVariantId ? "apply" : undefined}');
    expect(LP).toContain('data-guide={letterFor?.id === lpGuideId ? "lp_text_save" : undefined}');
    expect(DM).not.toContain('data-guide="dm_body_save"');
    expect(DM).not.toContain('data-guide="apply"');
  });
});

describe("AIで文章を作る手順(発注者決定: 案内に入れる)", () => {
  it("3つの手順を、保存ボタンの名前つきで出す", () => {
    const html = renderToStaticMarkup(createElement(AiTextSteps, { saveLabel: "本文を保存" }));
    expect(html).toContain("① 下の指示文を「コピー」");
    expect(html).toContain("② お手元のAI");
    expect(html).toContain("「本文を保存」");
  });
  it("お手紙の本文とLP型の文章の両方の枠に出す", () => {
    expect(DM).toContain('<AiTextSteps saveLabel="本文を保存" />');
    expect(LP).toContain('<AiTextSteps saveLabel="文章を保存" />');
  });
});
