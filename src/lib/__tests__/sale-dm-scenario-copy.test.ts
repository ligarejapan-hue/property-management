/**
 * 「DMの種類」共通手順(設計 2026-09-27 §3.3.0)のテスト。
 * 準備の検査・写す対応表・差し込み・台帳の全行ロックを1か所にまとめたモジュールを検証する。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/generated/prisma", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));

import { Prisma } from "@/generated/prisma";
import {
  checkScenarioReady,
  LETTER_COPY_MAP,
  LP_COPY_MAP,
  letterVariantData,
  lpVariantData,
  expandDraftBody,
  lockAllScenariosForShare,
  loadScenariosForCopy,
  copyScenarioIntoCampaign,
  type ScenarioFull,
} from "../sale-dm-letter/scenario-copy";

const LETTER_COLS = [
  "designTemplate", "tone", "length", "appeal", "strength",
  "extraInstruction", "letterPromptText", "letterBodyTemplate",
  // 手紙のイラスト(設計 2026-10-05 §7)
  "letterIllustrationAssetId",
];
const LP_COLS = [
  "lpTone", "lpLength", "lpAppeal", "lpStrength", "lpPromptText",
  "lpRawTemplate", "lpHeadline", "lpLead", "lpBodyText", "lpFaqJson",
];

function fullScenario(overrides: Partial<ScenarioFull> = {}): ScenarioFull {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "相続",
    autoKey: null,
    active: true,
    deletedAt: null,
    designTemplate: "template-a",
    tone: "friendly",
    length: "short",
    appeal: "price",
    strength: "strong",
    extraInstruction: "追加指示",
    letterPromptText: "letter prompt",
    letterBodyTemplate: "手紙の本文 {{物件所在}}",
    letterIllustrationAssetId: null,
    lpTone: "friendly",
    lpLength: "short",
    lpAppeal: "price",
    lpStrength: "strong",
    lpPromptText: "lp prompt",
    lpRawTemplate: "lp raw",
    lpHeadline: "見出し",
    lpLead: "リード",
    lpBodyText: "本文です",
    lpFaqJson: [{ q: "a", a: "b" }],
    ...overrides,
  };
}

describe("checkScenarioReady", () => {
  it("使わない(active=false)→unusable", () => {
    expect(checkScenarioReady(fullScenario({ active: false }))).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  it("削除済み(deletedAt有り)→unusable", () => {
    expect(checkScenarioReady(fullScenario({ deletedAt: new Date() }))).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  it("手紙の原文が空→letter_missing", () => {
    expect(checkScenarioReady(fullScenario({ letterBodyTemplate: null }))).toEqual({
      ok: false,
      reason: "letter_missing",
    });
    expect(checkScenarioReady(fullScenario({ letterBodyTemplate: "   " }))).toEqual({
      ok: false,
      reason: "letter_missing",
    });
  });

  it.each(["designTemplate", "tone", "length", "appeal", "strength"] as const)(
    "手紙の設定(%s)が空でも letter_missing(写した型の必須列が埋まらないため)",
    (key) => {
      expect(checkScenarioReady(fullScenario({ [key]: null }))).toEqual({
        ok: false,
        reason: "letter_missing",
      });
    },
  );

  it("手紙ありLP無し(本文/見出しが空)→{ok:true,hasLp:false}", () => {
    expect(checkScenarioReady(fullScenario({ lpBodyText: null }))).toEqual({
      ok: true,
      hasLp: false,
    });
    expect(checkScenarioReady(fullScenario({ lpHeadline: null }))).toEqual({
      ok: true,
      hasLp: false,
    });
  });

  it.each(["lpTone", "lpLength", "lpAppeal", "lpStrength"] as const)(
    "LPの設定(%s)が空ならLP無し扱い(DmLpVariant の必須列が埋まらないため)",
    (key) => {
      expect(checkScenarioReady(fullScenario({ [key]: null }))).toEqual({
        ok: true,
        hasLp: false,
      });
    },
  );

  it("手紙もLPも揃っている→{ok:true,hasLp:true}", () => {
    expect(checkScenarioReady(fullScenario())).toEqual({ ok: true, hasLp: true });
  });
});

describe("写す列の対応表(足し忘れ検出)", () => {
  it("LETTER_COPY_MAP/LP_COPY_MAP の左辺が ScenarioFull の手紙・LP列全部と一致する", () => {
    expect(LETTER_COPY_MAP.map(([k]) => k).sort()).toEqual([...LETTER_COLS].sort());
    expect(LP_COPY_MAP.map(([k]) => k).sort()).toEqual([...LP_COLS].sort());
  });
});

describe("letterVariantData", () => {
  it("全列を対応表どおりに写す(label/scenarioId込み・lpUrlは含まない)", () => {
    const s = fullScenario();
    const data = letterVariantData("campaign-1", s);
    expect(data).toEqual({
      campaignId: "campaign-1",
      label: s.name,
      scenarioId: s.id,
      designTemplate: s.designTemplate,
      tone: s.tone,
      length: s.length,
      appeal: s.appeal,
      strength: s.strength,
      extraInstruction: s.extraInstruction,
      promptText: s.letterPromptText,
      bodyTemplate: s.letterBodyTemplate,
      illustrationAssetId: s.letterIllustrationAssetId,
    });
    expect(Object.keys(data)).not.toContain("lpUrl");
  });
});

describe("lpVariantData", () => {
  it("全列を対応表どおりに写す(label/scenarioId込み)", () => {
    const s = fullScenario();
    const data = lpVariantData("campaign-1", s);
    expect(data).toEqual({
      campaignId: "campaign-1",
      label: s.name,
      scenarioId: s.id,
      tone: s.lpTone,
      length: s.lpLength,
      appeal: s.lpAppeal,
      strength: s.lpStrength,
      promptText: s.lpPromptText,
      rawTemplate: s.lpRawTemplate,
      headline: s.lpHeadline,
      lead: s.lpLead,
      bodyText: s.lpBodyText,
      faqJson: s.lpFaqJson,
    });
  });

  it("lpBodyText が空なら null(LP無し)", () => {
    expect(lpVariantData("c", fullScenario({ lpBodyText: null }))).toBeNull();
    expect(lpVariantData("c", fullScenario({ lpBodyText: "   " }))).toBeNull();
  });

  it("lpHeadline が空なら null(LP無し)", () => {
    expect(lpVariantData("c", fullScenario({ lpHeadline: null }))).toBeNull();
  });

  it.each(["lpTone", "lpLength", "lpAppeal", "lpStrength"] as const)(
    "LPの設定(%s)が空なら null(DmLpVariant の必須列が埋まらないため)",
    (key) => {
      expect(lpVariantData("c", fullScenario({ [key]: null }))).toBeNull();
    },
  );

  it("faqJson が null なら Prisma.DbNull に変換する(JSON列の消去は素のnullでなくDbNull)", () => {
    const data = lpVariantData("c", fullScenario({ lpFaqJson: null }));
    expect(data?.faqJson).toBe(Prisma.DbNull);
  });

  it("faqJson に値があればそのまま写す", () => {
    const faq = [{ q: "x", a: "y" }];
    const data = lpVariantData("c", fullScenario({ lpFaqJson: faq }));
    expect(data?.faqJson).toBe(faq);
  });
});

describe("expandDraftBody", () => {
  it("住所が読めない(null)→blank", () => {
    const r = expandDraftBody("ご所有の{{物件所在}}について", {
      address: null,
      propertyType: "land",
    });
    expect(r).toEqual({ body: "", blank: true });
  });

  it("物件種別が空で{{物件種別}}を含む→blank", () => {
    const r = expandDraftBody("{{物件種別}}のご売却について", {
      address: "東京都杉並区西荻北3-19-4",
      propertyType: null,
    });
    expect(r).toEqual({ body: "", blank: true });
  });

  it("両方ある→差し込まれた本文", () => {
    const r = expandDraftBody("{{物件所在}}の{{物件種別}}について", {
      address: "東京都杉並区西荻北3-19-4",
      propertyType: "land",
    });
    expect(r).toEqual({ body: "東京都杉並区西荻北の土地について", blank: false });
  });

  it("差し込み後に validateLetterBody が不正(長すぎ)→blank", () => {
    const longBody = "あ".repeat(20001);
    const r = expandDraftBody(longBody, {
      address: "東京都杉並区西荻北3-19-4",
      propertyType: "land",
    });
    expect(r).toEqual({ body: "", blank: true });
  });
});

describe("lockAllScenariosForShare", () => {
  it("台帳の全行をORDER BY idでFOR SHAREする(WHERE無し=全行)", async () => {
    const queryRaw = vi.fn(async (..._args: unknown[]) => []);
    await lockAllScenariosForShare({ $queryRaw: queryRaw as never });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = String(queryRaw.mock.calls[0][0]);
    expect(sql).toContain("FROM dm_scenarios");
    expect(sql).toContain("ORDER BY id");
    expect(sql).toContain("FOR SHARE");
    expect(sql).not.toMatch(/WHERE/);
  });

  it("tx を this にして呼ぶ(Prisma の $queryRaw はメソッド=this が要る。外すと本物の DB で必ず落ちる)", async () => {
    // 2026-09-28 Task 6 の実機確認で発見: `const run = tx.$queryRaw` の素呼びで
    // 「Cannot read properties of undefined (reading '_createPrismaPromise')」=種類つきの作成が必ず 500。
    const tx = {
      marker: "tx",
      async $queryRaw(this: { marker?: string }, ..._args: unknown[]) {
        if (this?.marker !== "tx") throw new Error("unbound $queryRaw");
        return [];
      },
    };
    await expect(lockAllScenariosForShare(tx as never)).resolves.toBeUndefined();
  });
});

describe("loadScenariosForCopy", () => {
  it("台帳の全列(削除済み含む)をselectし、絞り込み無しで返す", async () => {
    const rows = [fullScenario()];
    const findMany = vi.fn(async (..._args: unknown[]) => rows);
    const tx = { dmScenario: { findMany } } as never;
    const result = await loadScenariosForCopy(tx);
    expect(result).toBe(rows);
    const arg = findMany.mock.calls[0][0] as unknown as { select: Record<string, unknown>; where?: unknown };
    const ALL_COLS = ["id", "name", "autoKey", "active", "deletedAt", ...LETTER_COLS, ...LP_COLS];
    expect(Object.keys(arg.select).sort()).toEqual([...ALL_COLS].sort());
    expect(arg.where).toBeUndefined();
  });
});

describe("copyScenarioIntoCampaign", () => {
  const scenario = fullScenario();

  function txMock(overrides: {
    dmVariant?: Partial<{ findFirst: unknown; create: unknown }>;
    dmLpVariant?: Partial<{ findFirst: unknown; create: unknown }>;
    dmScenarioMedia?: Partial<{ findMany: unknown }>;
    dmLpVariantMedia?: Partial<{ createMany: unknown }>;
  } = {}) {
    return {
      dmVariant: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "letter-new" })),
        ...overrides.dmVariant,
      },
      dmLpVariant: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "lp-new" })),
        ...overrides.dmLpVariant,
      },
      dmScenarioMedia: {
        findMany: vi.fn(async () => []),
        ...overrides.dmScenarioMedia,
      },
      dmLpVariantMedia: {
        createMany: vi.fn(async () => ({ count: 0 })),
        ...overrides.dmLpVariantMedia,
      },
    };
  }

  it("既に写しがある→createを呼ばず既存のidを返す", async () => {
    const tx = txMock({
      dmVariant: { findFirst: vi.fn(async () => ({ id: "letter-existing", bodyTemplate: "写しの本文{{物件所在}}" })) },
      dmLpVariant: { findFirst: vi.fn(async () => ({ id: "lp-existing" })) },
    });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", scenario);
    expect(result).toEqual({ letterVariantId: "letter-existing", lpVariantId: "lp-existing", template: "写しの本文{{物件所在}}" });
    expect(tx.dmVariant.create).not.toHaveBeenCalled();
    expect(tx.dmLpVariant.create).not.toHaveBeenCalled();
    expect(tx.dmVariant.findFirst).toHaveBeenCalledWith({
      where: { campaignId: "campaign-1", scenarioId: scenario.id },
      select: { id: true, bodyTemplate: true },
    });
  });

  it("既に写しがある→本文は台帳の今の本文ではなく写しの本文を返す(台帳は凍結されない)", async () => {
    const tx = txMock({
      dmVariant: { findFirst: vi.fn(async () => ({ id: "letter-existing", bodyTemplate: "写しの本文" })) },
    });
    const s = fullScenario({ letterBodyTemplate: "台帳で後から書き換えた本文" });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", s);
    expect(result.template).toBe("写しの本文");
  });

  it("既に写しがあり本文が NULL → 空の本文(差し込みで下書き扱いになる)", async () => {
    const tx = txMock({ dmVariant: { findFirst: vi.fn(async () => ({ id: "letter-existing", bodyTemplate: null })) } });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", scenario);
    expect(result.template).toBe("");
  });

  it("既に写しがあるがLPは無い→lpVariantId:null", async () => {
    const tx = txMock({
      dmVariant: { findFirst: vi.fn(async () => ({ id: "letter-existing", bodyTemplate: "写し" })) },
      dmLpVariant: { findFirst: vi.fn(async () => null) },
    });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", scenario);
    expect(result).toEqual({ letterVariantId: "letter-existing", lpVariantId: null, template: "写し" });
    expect(tx.dmVariant.create).not.toHaveBeenCalled();
  });

  it("無い→letter作成+LPあり→LP作成+写真をlpVariantId付きで複製", async () => {
    const media = [
      { id: "m1", scenarioId: scenario.id, slot: "hero", heading: null, assetId: "asset-1", figureKind: null, sortOrder: 0, createdAt: new Date() },
      { id: "m2", scenarioId: scenario.id, slot: "section", heading: "見出しA", assetId: null, figureKind: "flow", sortOrder: 1, createdAt: new Date() },
    ];
    const tx = txMock({ dmScenarioMedia: { findMany: vi.fn(async () => media) } });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", scenario);

    expect(tx.dmVariant.create).toHaveBeenCalledWith({
      data: letterVariantData("campaign-1", scenario),
      select: { id: true },
    });
    expect(tx.dmLpVariant.create).toHaveBeenCalledWith({
      data: lpVariantData("campaign-1", scenario),
      select: { id: true },
    });
    expect(tx.dmLpVariantMedia.createMany).toHaveBeenCalledWith({
      data: [
        { lpVariantId: "lp-new", slot: "hero", heading: null, assetId: "asset-1", figureKind: null, sortOrder: 0 },
        { lpVariantId: "lp-new", slot: "section", heading: "見出しA", assetId: null, figureKind: "flow", sortOrder: 1 },
      ],
    });
    expect(result).toEqual({ letterVariantId: "letter-new", lpVariantId: "lp-new", template: scenario.letterBodyTemplate });
  });

  it("LP無し(本文が空)→letterのみ作成・LP create/写真複製/写真読み出しは呼ばない", async () => {
    const tx = txMock();
    const s = fullScenario({ lpBodyText: null });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", s);
    expect(tx.dmLpVariant.create).not.toHaveBeenCalled();
    expect(tx.dmScenarioMedia.findMany).not.toHaveBeenCalled();
    expect(tx.dmLpVariantMedia.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ letterVariantId: "letter-new", lpVariantId: null, template: s.letterBodyTemplate });
  });

  it("LPありだが写真が無い→createManyは呼ばない", async () => {
    const tx = txMock({ dmScenarioMedia: { findMany: vi.fn(async () => []) } });
    const result = await copyScenarioIntoCampaign(tx as never, "campaign-1", scenario);
    expect(tx.dmLpVariantMedia.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ letterVariantId: "letter-new", lpVariantId: "lp-new", template: scenario.letterBodyTemplate });
  });
});

describe("attachScenario(宛先に付けて差し込む・§3.3.0-3)", () => {
  it("手紙とLPの組をそのまま付け、本文を差し込む", async () => {
    const { attachScenario } = await import("../sale-dm-letter/scenario-copy");
    const r = attachScenario(
      { letterVariantId: "v1", lpVariantId: "lp1", template: "{{物件所在}}の{{物件種別}}について" },
      { address: "東京都杉並区西荻北3-19-4", propertyType: "land" },
    );
    expect(r).toEqual({ variantId: "v1", lpVariantId: "lp1", body: "東京都杉並区西荻北の土地について", blank: false });
  });

  it("LPの無い種類は lpVariantId=null のまま", async () => {
    const { attachScenario } = await import("../sale-dm-letter/scenario-copy");
    const r = attachScenario(
      { letterVariantId: "v2", lpVariantId: null, template: "{{物件所在}}について" },
      { address: "東京都杉並区西荻北3-19-4", propertyType: null },
    );
    expect(r).toEqual({ variantId: "v2", lpVariantId: null, body: "東京都杉並区西荻北について", blank: false });
  });

  it("差し込めない(住所 null)なら本文を空・blank=true・組は付ける", async () => {
    const { attachScenario } = await import("../sale-dm-letter/scenario-copy");
    const r = attachScenario(
      { letterVariantId: "v1", lpVariantId: "lp1", template: "{{物件所在}}について" },
      { address: null, propertyType: "land" },
    );
    expect(r).toEqual({ variantId: "v1", lpVariantId: "lp1", body: "", blank: true });
  });
});

describe("手紙のイラストの写し取り(設計 2026-10-05 §7)", () => {
  const S = {
    id: "s1", name: "相続", autoKey: "inheritance", active: true, deletedAt: null,
    designTemplate: "formal", tone: "polite", length: "standard", appeal: "inheritance", strength: "soft",
    extraInstruction: null, letterPromptText: "p", letterBodyTemplate: "本文",
    lpTone: null, lpLength: null, lpAppeal: null, lpStrength: null, lpPromptText: null, lpRawTemplate: null,
    lpHeadline: null, lpLead: null, lpBodyText: null, lpFaqJson: null,
    letterIllustrationAssetId: "11111111-1111-4111-8111-111111111111",
  };
  it("台帳のイラストを型の illustrationAssetId へ写す", () => {
    expect(letterVariantData("c1", S as never)).toMatchObject({ illustrationAssetId: "11111111-1111-4111-8111-111111111111" });
  });
  it("未登録なら null のまま写す", () => {
    expect(letterVariantData("c1", { ...S, letterIllustrationAssetId: null } as never)).toMatchObject({ illustrationAssetId: null });
  });
  it("対応表に載っている(作成と種類を変えるの両方が同じ表を通る)", () => {
    expect(LETTER_COPY_MAP).toContainEqual(["letterIllustrationAssetId", "illustrationAssetId"]);
  });
  it("走査: 写す前の読み出しにもイラストの列が入っている", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/sale-dm-letter/scenario-copy.ts"), "utf8");
    const start = src.indexOf("const SCENARIO_FULL_SELECT");
    const sel = src.slice(start, src.indexOf("} as const;", start));
    expect(sel).toContain("letterIllustrationAssetId: true");
  });
});
