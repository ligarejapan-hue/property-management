/**
 * DQ-05: 敬称判定（エンティティ種別 -> 敬称）純関数テスト。
 *
 * 検証観点（22B-dq-02-04-05-design.md DQ-05 節）:
 * - classifyHonorificKind: 法人番号シグナル -> "corp" / 組織名サフィックス -> "org" /
 *   それ以外 -> "person"。
 * - honorificFor: corp/org -> "御中"、person -> "様"。
 * - honorificForOwner: name + 任意 hasCorporateNumber から敬称文字列を直接返す
 *   （既存 honorific(corporateNumber) の上位互換・保守的）。
 * - 管理組合 / 法人 / 任意団体ケース、個人名 -> 様、全角・空白ゆらぎ、空/null、
 *   誤検出回避（個人名の組織語中間一致を拾わない・裸の「会」「組合」を拾わない）。
 *
 * 既存挙動との後方互換:
 * - 法人番号が非空なら（名称に関係なく）"corp" -> 御中（dm-export.ts:54 honorific と一致）。
 * - 法人番号が空で組織名でもない通常の個人名は "様"（従来どおり）。
 */
import { describe, it, expect } from "vitest";
import {
  classifyHonorificKind,
  honorificFor,
  honorificForOwner,
  HONORIFIC_RESPECT,
  HONORIFIC_ORG,
  type HonorificKind,
} from "../owner-honorific";

describe("classifyHonorificKind — 法人番号シグナル（判定順 1）", () => {
  it("法人番号が非空なら名称に関係なく corp", () => {
    expect(classifyHonorificKind("山田太郎", "1234567890123")).toBe("corp");
    expect(classifyHonorificKind("", "1234567890123")).toBe("corp");
  });

  it("法人番号が空 / null / undefined / 空白のみは corp 判定にしない", () => {
    expect(classifyHonorificKind("山田太郎", "")).toBe("person");
    expect(classifyHonorificKind("山田太郎", null)).toBe("person");
    expect(classifyHonorificKind("山田太郎", undefined)).toBe("person");
    expect(classifyHonorificKind("山田太郎", "   ")).toBe("person");
  });

  it("法人番号シグナルは組織名サフィックスより優先（後方互換: 法人番号ありは常に corp）", () => {
    // 名称が組織サフィックスでも、法人番号があれば corp（org に倒さない）。
    expect(classifyHonorificKind("○○管理組合", "9876543210987")).toBe("corp");
  });
});

describe("classifyHonorificKind — 組織名サフィックス（判定順 2）-> org", () => {
  const orgNames: Array<[string, string]> = [
    ["管理組合", "○○マンション管理組合"],
    ["管理組合法人", "○○マンション管理組合法人"],
    ["自治会", "桜ヶ丘自治会"],
    ["町内会", "本町町内会"],
    ["町会", "東一丁目町会"],
    ["区会", "中央区会"],
    ["管理会社", "○○不動産管理会社"],
    ["株式会社（後株）", "○○商事株式会社"],
    ["有限会社", "○○有限会社"],
    ["合同会社", "○○合同会社"],
    ["合資会社", "○○合資会社"],
    ["合名会社", "○○合名会社"],
    ["一般社団法人", "○○一般社団法人"],
    ["一般財団法人", "○○一般財団法人"],
    ["公益社団法人", "○○公益社団法人"],
    ["公益財団法人", "○○公益財団法人"],
    ["社会福祉法人", "○○社会福祉法人"],
    ["宗教法人", "○○宗教法人"],
    ["医療法人", "○○医療法人"],
    ["学校法人", "○○学校法人"],
    ["協同組合", "○○協同組合"],
    ["連合会", "○○連合会"],
    ["商店会", "○○商店会"],
  ];

  for (const [label, name] of orgNames) {
    it(`${label}: 「${name}」-> org`, () => {
      expect(classifyHonorificKind(name, null)).toBe("org");
    });
  }

  it("前株（株式会社が先頭）も org として検出する（含有判定で吸収）", () => {
    expect(classifyHonorificKind("株式会社○○", null)).toBe("org");
  });

  it("法人格語の前後に空白があっても検出する（正規化後判定）", () => {
    expect(classifyHonorificKind("  ○○商事 株式会社  ", null)).toBe("org");
  });

  it("全角／半角ゆらぎ（NFKC）でも検出する: （株）/ (株) / ㈱", () => {
    expect(classifyHonorificKind("○○（株）", null)).toBe("org");
    expect(classifyHonorificKind("○○(株)", null)).toBe("org");
    expect(classifyHonorificKind("○○㈱", null)).toBe("org");
  });
});

describe("classifyHonorificKind — 個人名（判定順 3）-> person", () => {
  const personNames = [
    "山田太郎",
    "佐藤花子",
    "鈴木 一郎",
    "ﾀﾅｶ ﾀﾛｳ",
    "Smith John",
    "李 明",
  ];
  for (const name of personNames) {
    it(`個人名「${name}」-> person`, () => {
      expect(classifyHonorificKind(name, null)).toBe("person");
    });
  }
});

describe("classifyHonorificKind — 誤検出回避（no false positive）", () => {
  it("裸の「会」単独サフィックスは org にしない（例: 田中会）", () => {
    expect(classifyHonorificKind("田中会", null)).toBe("person");
  });

  it("裸の「組合」単独サフィックスは org にしない（例: 組合）", () => {
    expect(classifyHonorificKind("組合", null)).toBe("person");
  });

  it("「会計」は会で終わらない・組織語でない -> person（例: 田中会計）", () => {
    expect(classifyHonorificKind("田中会計", null)).toBe("person");
  });

  it("組織語を含む建物名のような中間一致でも、owner.name が組織サフィックスで終われば org（語尾優先）", () => {
    // 「○○管理組合ビル」は管理組合で終わらない -> person（中間一致で拾わない）。
    expect(classifyHonorificKind("○○管理組合ビル", null)).toBe("person");
  });

  it("「組合せ」のような語は組合サフィックス扱いしない（語尾の閉じた語彙のみ）", () => {
    expect(classifyHonorificKind("パズル組合せ", null)).toBe("person");
  });
});

describe("classifyHonorificKind — 空 / null / 空白のみ -> person（保守的・様）", () => {
  it("空文字は person", () => {
    expect(classifyHonorificKind("", null)).toBe("person");
  });
  it("null は person", () => {
    expect(classifyHonorificKind(null, null)).toBe("person");
  });
  it("undefined は person", () => {
    expect(classifyHonorificKind(undefined, null)).toBe("person");
  });
  it("空白のみは person", () => {
    expect(classifyHonorificKind("   　　", null)).toBe("person");
  });
});

describe("honorificFor — 種別 -> 敬称文字列", () => {
  it("corp -> 御中", () => {
    expect(honorificFor("corp")).toBe("御中");
    expect(honorificFor("corp")).toBe(HONORIFIC_ORG);
  });
  it("org -> 御中", () => {
    expect(honorificFor("org")).toBe("御中");
    expect(honorificFor("org")).toBe(HONORIFIC_ORG);
  });
  it("person -> 様", () => {
    expect(honorificFor("person")).toBe("様");
    expect(honorificFor("person")).toBe(HONORIFIC_RESPECT);
  });

  it("全 HonorificKind を網羅（exhaustive）", () => {
    const kinds: HonorificKind[] = ["corp", "org", "person"];
    for (const k of kinds) {
      const h = honorificFor(k);
      expect(h === "御中" || h === "様").toBe(true);
    }
  });
});

describe("honorificForOwner — name(+hasCorporateNumber) -> 敬称（上位互換 API）", () => {
  it("個人名 -> 様", () => {
    expect(honorificForOwner("山田太郎")).toBe("様");
  });

  it("管理組合 -> 御中（法人番号なしでも組織名で御中）", () => {
    expect(honorificForOwner("○○マンション管理組合")).toBe("御中");
  });

  it("自治会 -> 御中", () => {
    expect(honorificForOwner("桜ヶ丘自治会")).toBe("御中");
  });

  it("株式会社 -> 御中", () => {
    expect(honorificForOwner("○○商事株式会社")).toBe("御中");
  });

  it("hasCorporateNumber=true なら名称に関係なく 御中（後方互換）", () => {
    expect(honorificForOwner("山田太郎", true)).toBe("御中");
  });

  it("hasCorporateNumber=false / 省略時は名称ベース判定", () => {
    expect(honorificForOwner("山田太郎", false)).toBe("様");
    expect(honorificForOwner("○○管理組合", false)).toBe("御中");
  });

  it("空 / null / undefined / 空白のみ -> 様（個人扱い・保守的）", () => {
    expect(honorificForOwner("")).toBe("様");
    expect(honorificForOwner(null)).toBe("様");
    expect(honorificForOwner(undefined)).toBe("様");
    expect(honorificForOwner("   ")).toBe("様");
  });

  it("誤検出回避: 田中会 / 田中会計 -> 様", () => {
    expect(honorificForOwner("田中会")).toBe("様");
    expect(honorificForOwner("田中会計")).toBe("様");
  });
});

describe("既存 honorific(corporateNumber) との後方互換", () => {
  // 旧 honorific は corporateNumber のみで判定（非空 -> 御中 / 空 -> 様）。
  // honorificForOwner(name, hasCorporateNumber) は、組織名を見ない限り同値であること。
  it("法人番号あり個人名: 旧=御中 と一致（honorificForOwner name任意 + true）", () => {
    expect(honorificForOwner("山田太郎", true)).toBe("御中");
  });
  it("法人番号なし通常個人名: 旧=様 と一致", () => {
    expect(honorificForOwner("山田太郎", false)).toBe("様");
  });
});
