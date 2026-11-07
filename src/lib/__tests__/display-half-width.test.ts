import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { displayHalfWidth } from "../notation";

describe("画面に出すときだけ数字を半角に(2026-11-07)", () => {
  it("★全角の数字だけを半角にする(区切りや漢字・ケヶはそのまま)", () => {
    expect(displayHalfWidth("東京都大田区北千束１丁目２－３")).toBe("東京都大田区北千束1丁目2－3");
    expect(displayHalfWidth("１２３番４")).toBe("123番4");
    expect(displayHalfWidth("茅ヶ崎市１")).toBe("茅ヶ崎市1");
    expect(displayHalfWidth("1-2-3")).toBe("1-2-3");
  });

  it("★空・null・undefined はそのまま返す", () => {
    expect(displayHalfWidth("")).toBe("");
    expect(displayHalfWidth(null)).toBeNull();
    expect(displayHalfWidth(undefined)).toBeUndefined();
  });
});

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return name === "__tests__" ? [] : filesUnder(rel);
    return /\.tsx?$/.test(name) ? [rel] : [];
  });
}

describe("当てる画面と当てない画面", () => {
  it("★物件の一覧: 住所・地番・候補の所有者の住所", () => {
    const s = read("src/app/(dashboard)/properties/page.tsx");
    expect(s).not.toMatch(/\{property\.address\}/);
    expect(s).not.toMatch(/\{property\.lotNumber \?\? "-"\}/);
    expect(s).not.toMatch(/\{item\.address\}/);
    expect(s).not.toMatch(/\{o\.(address|currentAddress)\}/);
  });

  it("★物件の詳細: 見出し・住所・地番・家屋番号・ほかの土地建物・所有者の住所", () => {
    const s = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(s).toMatch(/<h2[^>]*>\n\s*\{displayHalfWidth\(property\.address\)\}/);
    expect(s).toMatch(/label="物件住所" value=\{displayHalfWidth\(property\.address\)\}/);
    expect(s).toMatch(/label="地番" value=\{displayHalfWidth\(parcelNumberLabel\(/);
    expect(s).toMatch(/label="家屋番号" value=\{displayHalfWidth\(parcelNumberLabel\(/);
    expect(s).toMatch(/label="ほかの土地・建物" value=\{displayHalfWidth\(extraParcelsText\(/);
    expect(s).not.toMatch(/<OwnerField label="(現住所|登記上住所)" value=\{po\.owner\.(address|currentAddress)\} \/>/);
  });

  it("★所有者の管理画面・棟の画面", () => {
    const owner = read("src/app/(dashboard)/admin/owners/[id]/page.tsx");
    expect(owner).toMatch(/value=\{displayHalfWidth\(owner\.ownerAddressMasked\)\}/);
    expect(owner).toMatch(/value=\{displayHalfWidth\(owner\.ownerCurrentAddressMasked\)/);
    expect(owner).toMatch(/\{displayHalfWidth\(p\.address\)\}/);
    expect(read("src/app/(dashboard)/buildings/page.tsx")).toMatch(/\{displayHalfWidth\(b\.address\)\}/);
    expect(read("src/app/(dashboard)/buildings/[id]/page.tsx")).toMatch(/label="住所" value=\{displayHalfWidth\(building\.address\)\}/);
  });

  it("★入力欄の値には当てない(打っていないのに変わったことになる)", () => {
    for (const p of ["src/app/(dashboard)/properties/[id]/page.tsx", "src/app/(dashboard)/buildings/page.tsx"]) {
      expect(read(p), p).not.toMatch(/(value|defaultValue|address)=\{displayHalfWidth\(form\./);
      expect(read(p), p).not.toMatch(/:\s*displayHalfWidth\(/);
    }
  });

  it("★帳票・DM・販売図面には当てない(縦書きや原本の写しは元の字のまま)", () => {
    const files = [
      ...filesUnder("src/lib/deals/documents"),
      ...filesUnder("src/lib/dm-batch"),
      ...filesUnder("src/lib/sale-dm-letter"),
      ...filesUnder("src/lib/sales-sheet"),
      ...filesUnder("src/components/sales-sheet"),
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const p of files) expect(read(p), p).not.toMatch(/displayHalfWidth/);
  });
});
