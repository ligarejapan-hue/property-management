import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  pickDefaultScenario,
  scenarioCampaignNotices,
  scenarioFixLinkFor,
  scenarioChangeConfirmText,
  isScenarioCampaignView,
} from "@/lib/sale-dm-letter/scenario-campaign-ui";
import { buildSaleDmPartialNotice } from "@/lib/sale-dm-letter/list-ui";
import { computeSaleDmGuideStep, visibleGuideSteps, SALE_DM_GUIDE_STEPS } from "@/lib/sale-dm-letter/step-guide";

/**
 * 売却DM「DMの種類」PR-S2 Task 6: 作成画面と、種類つきの発送の画面。
 * 純関数(初期選択・案内の文言・手順の案内の分岐)+ 走査(種類なしの発送の画面を変えない)。
 */
const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const DIALOG = "src/components/sale-dm/create-campaign-dialog.tsx";
const VARIANT_MANAGER = "src/components/sale-dm/variant-manager.tsx";
const LP_MANAGER = "src/components/sale-dm/lp-variant-manager.tsx";
const ADJUST = "src/components/sale-dm/adjust-panel.tsx";
const RECIPIENTS = "src/components/sale-dm/recipient-list.tsx";
const AGGREGATE = "src/components/sale-dm/aggregate-view.tsx";
const PROPERTIES_PAGE = "src/app/(dashboard)/properties/page.tsx";
const CAMPAIGN_PAGE = "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx";

const opt = (id: string, name: string, sortOrder: number, ready: boolean) => ({ id, name, sortOrder, autoKey: null, ready });

describe("pickDefaultScenario(作成画面の初期選択)", () => {
  it("手紙が登録済み(ready)の最初の種類(並び順)", () => {
    expect(pickDefaultScenario([opt("b", "空き家", 2, true), opt("a", "相続", 1, true)])).toBe("a");
  });
  it("未登録の種類は飛ばす", () => {
    expect(pickDefaultScenario([opt("a", "相続", 1, false), opt("b", "空き家", 2, true)])).toBe("b");
  });
  it("ready が1つも無ければ null(=種類を使わない)", () => {
    expect(pickDefaultScenario([opt("a", "相続", 1, false)])).toBeNull();
    expect(pickDefaultScenario([])).toBeNull();
  });
});

describe("isScenarioCampaignView", () => {
  it("defaultScenarioId があるときだけ種類つき(未定義は種類なし)", () => {
    expect(isScenarioCampaignView({ defaultScenarioId: "s1" })).toBe(true);
    expect(isScenarioCampaignView({ defaultScenarioId: null })).toBe(false);
    expect(isScenarioCampaignView({} as { defaultScenarioId?: string | null })).toBe(false);
  });
});

describe("buildSaleDmPartialNotice(作成後の案内)", () => {
  it("本文を差し込めなかった宛先の件数", () => {
    const n = buildSaleDmPartialNotice({ generated: 3, failed: 0, blankBodyCount: 2 });
    expect(n).toContain("本文を差し込めなかった宛先 2件(物件の住所・種別を補ってから『差し込み』で入れ直してください)");
  });
  it("LPが未登録の種類", () => {
    const n = buildSaleDmPartialNotice({ generated: 3, failed: 0, lpMissingScenarios: ["空き家", "賃貸中"] });
    expect(n).toContain("LPが未登録の種類: 空き家、賃貸中(QRは会社のホームページへ転送されます)");
  });
  it("0件・空配列なら今までどおり null", () => {
    expect(buildSaleDmPartialNotice({ generated: 3, failed: 0, blankBodyCount: 0, lpMissingScenarios: [] })).toBeNull();
  });
});

describe("scenarioCampaignNotices(発送の画面上部の注意)", () => {
  const campaign = {
    variants: [
      { id: "v1", label: "相続", scenarioId: "s1" },
      { id: "v2", label: "空き家", scenarioId: "s2" },
      { id: "v3", label: "賃貸中", scenarioId: "s3" },
    ],
    lpVariants: [{ id: "l1", scenarioId: "s1" }],
    recipients: [
      { variantId: "v1", status: "draft", body: "" },
      { variantId: "v1", status: "draft", body: "本文" },
      { variantId: "v2", status: "confirmed", body: "本文" },
      { variantId: "v2", status: "draft", body: "" },
    ],
  };
  it("本文が空の下書きの数と、宛先のいる種類のうちLPの無いもの", () => {
    const r = scenarioCampaignNotices(campaign);
    expect(r.blankDrafts).toBe(2);
    // v3 は宛先がいないので出さない
    expect(r.lpMissingNames).toEqual(["空き家"]);
  });
  it("0件なら何も出さない", () => {
    const r = scenarioCampaignNotices({ ...campaign, recipients: [{ variantId: "v1", status: "draft", body: "本文" }] });
    expect(r.blankDrafts).toBe(0);
    expect(r.lpMissingNames).toEqual([]);
  });
});

describe("scenarioFixLinkFor / scenarioChangeConfirmText", () => {
  it("種類の登録が足りない理由のときだけ「DMの種類を開く」", () => {
    for (const c of ["SCENARIO_NOT_READY", "SCENARIO_UNAVAILABLE", "PROPERTY_SCENARIO_MISSING"]) {
      expect(scenarioFixLinkFor(c)).toEqual({ href: "/admin/dm-scenarios", label: "DMの種類を開く" });
    }
    expect(scenarioFixLinkFor("RECIPIENTS_CHANGED")).toBeNull();
    expect(scenarioFixLinkFor(null)).toBeNull();
  });
  it("確認文", () => {
    expect(scenarioChangeConfirmText(3)).toBe(
      "この物件の宛先(3人)の手紙とLPを切り替えます。確定済みの宛先は下書きに戻ります。物件の『DMの種類』欄も変わります。",
    );
  });
});

describe("手順の案内: 種類つきの発送", () => {
  const base = {
    variants: [{ id: "v1", bodyTemplate: "本文" }],
    printed: false,
  };
  it("LP が1つも無くても「LP型を作る」を出さない", () => {
    expect(
      computeSaleDmGuideStep({ ...base, lpVariants: [], recipients: [{ status: "draft", body: "x", lpVariantId: null, variantId: "v1" }], scenarioCampaign: true }),
    ).toBe("confirm");
  });
  it("LP の無い種類の宛先がいても「均等に割り当て」を出さない", () => {
    expect(
      computeSaleDmGuideStep({
        ...base,
        lpVariants: [{ id: "l1", headline: "見出し" }],
        recipients: [
          { status: "draft", body: "x", lpVariantId: "l1", variantId: "v1" },
          { status: "draft", body: "x", lpVariantId: null, variantId: "v1" },
        ],
        scenarioCampaign: true,
      }),
    ).toBe("confirm");
  });
  it("本文の空いた下書きは「本文を宛先へ」", () => {
    expect(
      computeSaleDmGuideStep({ ...base, lpVariants: [], recipients: [{ status: "draft", body: "", lpVariantId: null, variantId: "v1" }], scenarioCampaign: true }),
    ).toBe("apply");
  });
  it("帯に並べる段: 種類つきは「LP型を作る」「均等に割り当て」を外す・種類なしは全部", () => {
    expect(visibleGuideSteps(true).map((s) => s.key)).toEqual(["lp_text", "dm_body", "apply", "confirm", "print", "sent"]);
    expect(visibleGuideSteps(false)).toBe(SALE_DM_GUIDE_STEPS);
  });
  it("種類なしの発送は今までどおり", () => {
    expect(
      computeSaleDmGuideStep({ ...base, lpVariants: [], recipients: [{ status: "draft", body: "x", lpVariantId: null, variantId: "v1" }] }),
    ).toBe("add_lp");
  });
});

describe("走査: 作成画面", () => {
  it("選択肢は選択肢の口(fetchSaleDmScenarioOptions)だけから取る", () => {
    const src = read(DIALOG);
    expect(src).toContain("fetchSaleDmScenarioOptions()");
    expect(src).not.toMatch(/fetchSaleDmScenarioOptionsAll|fetchSaleDmScenarios\b|fetchSaleDmScenario\(/);
    expect(src).toContain("pickDefaultScenario(");
    expect(src).toContain("種類を使わない(今までどおり)");
    expect(src).toContain("(手紙が未登録)");
    expect(src).toContain(
      "受付帳取込の物件は相続、現地調査の物件は空き家、それ以外はここで選んだ種類になります。物件の『DMの種類』欄で直した物件はそちらが優先です。",
    );
    expect(src).toContain("今までどおり、型Aで作ります");
  });
  it("「DMの種類を開く」は管理者だけ(セッションの役割で判定)", () => {
    for (const rel of [DIALOG, ADJUST]) {
      const src = read(rel);
      expect(src).toContain('from "next-auth/react"');
      expect(src).toMatch(/session\?\.user as \{ role\?: string \} \| undefined\)\?\.role === "admin"/);
      // 行き先は scenarioFixLinkFor 1か所で決め、出すのは isAdmin のときだけ
      expect(src).toMatch(/fixLink\s*=[^;]*scenarioFixLinkFor\(/);
      expect(src).toMatch(/isAdmin\s*&&\s*fixLink\s*&&/);
      expect(src).not.toMatch(/href="\/admin\/dm-scenarios"/);
    }
    const sidebar = read("src/components/layout/sidebar-model.tsx");
    expect(sidebar).toContain('href: "/admin/dm-scenarios"');
  });
  it("物件一覧は確認ダイアログ(window.confirm)ではなく作成画面を開く・defaultScenarioId を送る", () => {
    const src = read(PROPERTIES_PAGE);
    expect(src).toContain("SaleDmCreateCampaignDialog");
    expect(src).not.toContain("選択した ${ids.length} 件の物件で宛先の一覧を作ります");
    expect(src).toMatch(/createSaleDmCampaign\(\{[\s\S]{0,600}defaultScenarioId/);
    expect(src).toMatch(/blankBodyCount:\s*res\.blankBodyCount/);
    expect(src).toMatch(/lpMissingScenarios:\s*res\.lpMissingScenarios/);
  });
});

/**
 * needle が `{!scenario && (` … 単独行の `)}` の分岐(=種類つきの発送では出さない)の中にあるか。
 * needle 自体は分岐の外でも内でも必ず存在する(=種類なしの発送では残る)ことも確かめる。
 */
const guardedBefore = (src: string, needle: string) => {
  const idx = src.indexOf(needle);
  expect(idx, needle).toBeGreaterThan(0);
  const re = /\{!scenario && \(\n[\s\S]*?\n[ \t]*\)\}\n/g;
  for (const m of src.matchAll(re)) {
    const start = m.index ?? 0;
    if (idx > start && idx < start + m[0].length) return true;
  }
  return false;
};

describe("走査: 種類つきの発送ではボタンを隠す/種類なしの発送では残す", () => {
  it("手紙の型: 型を追加・編集・削除・均等に割り当て", () => {
    const src = read(VARIANT_MANAGER);
    expect(src).toContain("isScenarioCampaignView(campaign)");
    for (const needle of ["型を追加", "を編集`}", "を削除`}", "均等に割り当て\n"]) {
      expect(guardedBefore(src, needle), needle).toBe(true);
    }
    // 文面(書類のアイコン)は種類つきでも出す
    expect(guardedBefore(src, "の文面`}")).toBe(false);
  });
  it("LPの型: LP型を追加・編集・削除", () => {
    const src = read(LP_MANAGER);
    expect(src).toContain("isScenarioCampaignView(campaign)");
    for (const needle of ["LP型を追加", "を編集`}", "を削除`}"]) {
      expect(guardedBefore(src, needle), needle).toBe(true);
    }
    // 文章・写真と図・プレビューは出す
    for (const needle of ["の文章`}", "の写真と図`}", "のプレビュー`}"]) {
      expect(guardedBefore(src, needle), needle).toBe(false);
    }
  });
  it("宛先ごとの型の選択は種類なしの発送だけ・種類つきは物件ごとの「種類を変える」", () => {
    const src = read(ADJUST);
    expect(src).toContain("isScenarioCampaignView(campaign)");
    expect(src).toMatch(/!scenario\s*&&\s*campaign\.variants\.length > 1/);
    expect(src).toContain("changeSaleDmPropertyScenario(");
    expect(src).toContain("scenarioChangeConfirmText(");
    expect(src).toContain("fetchSaleDmScenarioOptions()");
    // ready でない種類は選べない
    expect(src).toMatch(/disabled=\{!o\.ready\}/);
  });
  it("宛先一覧・集計: 種類つきは「種類」・種類なしは今までどおり「型 」", () => {
    const rl = read(RECIPIENTS);
    expect(rl).toContain("型 {variantLabel(campaign.variants, r.variantId)}");
    expect(rl).toContain("種類 {variantLabel(campaign.variants, r.variantId)}");
    const ag = read(AGGREGATE);
    expect(ag).toMatch(/scenario \? r\.label : `型 \$\{r\.label\}`/);
  });
  it("発送の画面: 上部の注意と手順の案内の分岐", () => {
    const src = read(CAMPAIGN_PAGE);
    expect(src).toContain("scenarioCampaignNotices(");
    expect(src).toContain("本文が空の下書き");
    expect(src).toContain("LPが未登録の種類: ");
    expect(src).toMatch(/scenarioCampaign:\s*scenario/);
    expect(src).toMatch(/scenarioCampaign=\{scenario\}/);
    expect(read("src/components/sale-dm/step-guide.tsx")).toContain("visibleGuideSteps(scenarioCampaign)");
  });
});
