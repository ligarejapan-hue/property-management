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
 *
 * 重要（pre-review P1#2）: 旧 honorific(corporateNumber) は
 *   `typeof === "string" && length > 0`（**trim しない**）で判定する。
 *   よって空白のみの法人番号（"   "）は length>0 -> 御中。本ライブラリの
 *   法人番号判定はこの旧挙動の **ドロップイン上位互換**（同じ corporateNumber 入力には
 *   同じ敬称を返す。新挙動は「法人番号なし＋組織名」の救済のみ）であることを
 *   parity テストで固定する。
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

  it("法人番号が空 / null / undefined は corp 判定にしない（旧 honorific=様 と一致）", () => {
    expect(classifyHonorificKind("山田太郎", "")).toBe("person");
    expect(classifyHonorificKind("山田太郎", null)).toBe("person");
    expect(classifyHonorificKind("山田太郎", undefined)).toBe("person");
  });

  it("空白のみの法人番号は corp（旧 honorific は trim せず length>0 -> 御中 ＝上位互換）", () => {
    // 旧 honorific("   ") は length 3 > 0 -> 御中。本ライブラリも同値（corp）にする。
    expect(classifyHonorificKind("山田太郎", "   ")).toBe("corp");
    expect(classifyHonorificKind("山田太郎", "\t")).toBe("corp");
    expect(classifyHonorificKind("○○管理組合", "   ")).toBe("corp");
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
    // pre-review P1#1: 裸の 財団法人 / 社団法人（一般/公益 等の接頭なし）も org。
    ["財団法人（後置）", "○○財団法人"],
    ["社団法人（後置）", "○○社団法人"],
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

describe("classifyHonorificKind — pre-review P1#1: 財団法人 / 社団法人 / ㈳ / ㈶ 取りこぼし修正", () => {
  // バグ: 裸の「財団法人」「社団法人」と記号 ㈳/㈶ がマーカ語彙に無く、
  // 「財団法人○○」「○○社団法人」が person（様）に誤判定されていた。
  it("前置「財団法人○○」も org（強マーカは語中含有）", () => {
    expect(classifyHonorificKind("財団法人○○記念会", null)).toBe("org");
  });

  it("前置「社団法人○○」も org", () => {
    expect(classifyHonorificKind("社団法人○○協会", null)).toBe("org");
  });

  it("後置「○○財団法人」「○○社団法人」も org", () => {
    expect(classifyHonorificKind("○○財団法人", null)).toBe("org");
    expect(classifyHonorificKind("○○社団法人", null)).toBe("org");
  });

  it("㈳（NFKC -> (社)）を含む名称は org", () => {
    expect(classifyHonorificKind("㈳○○協会", null)).toBe("org");
    expect(classifyHonorificKind("○○㈳", null)).toBe("org");
  });

  it("㈶（NFKC -> (財)）を含む名称は org", () => {
    expect(classifyHonorificKind("㈶○○記念会", null)).toBe("org");
    expect(classifyHonorificKind("○○㈶", null)).toBe("org");
  });

  it("(社) / (財)（既に NFKC 後の半角括弧形）も org", () => {
    expect(classifyHonorificKind("(社)○○協会", null)).toBe("org");
    expect(classifyHonorificKind("(財)○○記念会", null)).toBe("org");
  });

  it("学校法人 / 医療法人 / 宗教法人 は前置でも org（語中含有）", () => {
    expect(classifyHonorificKind("学校法人○○学園", null)).toBe("org");
    expect(classifyHonorificKind("医療法人○○会", null)).toBe("org");
    expect(classifyHonorificKind("宗教法人○○寺", null)).toBe("org");
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

  it("pre-review P1#1 ガード: 「社」「財」を含むが法人格語でない個人名は person", () => {
    // 「財前」姓・「社」単体などは org マーカ（財団法人/社団法人/(社)/(財)）に
    // マッチしないので person のまま（個人名 false positive を作らない）。
    expect(classifyHonorificKind("財前 五郎", null)).toBe("person");
    expect(classifyHonorificKind("社本 太郎", null)).toBe("person");
    expect(classifyHonorificKind("財団", null)).toBe("person");
    expect(classifyHonorificKind("社団", null)).toBe("person");
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

describe("pre-review P2(a): 旧 honorific(corporateNumber) との完全 parity", () => {
  // 旧実装の **正確な複製**（dm-export.ts:54-58 / property-dm-export.ts:53-57）。
  // 重要: trim しない。`typeof === "string" && length > 0` のみで判定する。
  function oldHonorific(corporateNumber: string | null | undefined): string {
    return typeof corporateNumber === "string" && corporateNumber.length > 0
      ? "御中"
      : "様";
  }

  // 代表的な corporateNumber 入力（空・空白のみ・有効13桁・記号混じり・null/undefined）。
  const corpNumberCases: Array<string | null | undefined> = [
    "",
    " ",
    "   ",
    "\t",
    "\n",
    "　", // 全角スペース（length 1 > 0 -> 旧=御中）
    "1234567890123",
    "9876543210987",
    "12345", // 桁数不問（旧は length>0 のみ）
    "abc",
    null,
    undefined,
  ];

  // 法人番号判定が名称に依らず旧と一致することを示すため、複数の name で確認する
  // （個人名・組織名・空名のいずれでも、corporateNumber 由来の敬称は旧と同値）。
  const names: Array<string | null | undefined> = ["山田太郎", "○○管理組合", "", null];

  for (const cn of corpNumberCases) {
    for (const nm of names) {
      it(`corporateNumber=${JSON.stringify(cn)} / name=${JSON.stringify(
        nm,
      )} は旧 honorific と一致`, () => {
        const expected = oldHonorific(cn);
        // classifyHonorificKind -> honorificFor 経路。
        const viaClassify = honorificFor(classifyHonorificKind(nm, cn));
        // honorificForOwner(name, hasCorporateNumber) 経路（hasCorporateNumber は
        // 旧の「corporateNumber 非空」シグナルそのもの）。
        const viaOwner = honorificForOwner(nm, oldHonorific(cn) === "御中");

        if (expected === "御中") {
          // 旧が御中になる入力（法人番号非空）は、名称に関係なく必ず御中。
          // ＝ corp 判定が org/person 名称判定より優先（ドロップイン上位互換）。
          expect(viaClassify).toBe("御中");
          expect(viaOwner).toBe("御中");
        } else {
          // 旧が様になる入力（法人番号が空/null/undefined）でのみ、新挙動
          // （名称ベースの org 救済）が効く。個人名・空名は旧どおり様、
          // 組織名は新たに御中（＝意図した唯一の上位拡張）。両経路とも
          // classifyHonorificKind(name, ...) を通るので同じ判定になる。
          const nameIsOrg = classifyHonorificKind(nm, null) === "org";
          const want = nameIsOrg ? "御中" : expected;
          expect(viaClassify).toBe(want);
          expect(viaOwner).toBe(want);
        }
      });
    }
  }

  it("空白のみ corporateNumber は旧と同様 御中（trim しない＝ドロップイン上位互換）", () => {
    expect(oldHonorific("   ")).toBe("御中");
    expect(honorificFor(classifyHonorificKind("山田太郎", "   "))).toBe("御中");
    expect(honorificForOwner("山田太郎", true)).toBe("御中");
  });
});
