import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import DealTargetParcels, { initialParcelSelection } from "../deal-target-parcels";

const options = [
  { key: "main:land", kind: "land" as const, label: "土地 1番1（1筆目）" },
  { key: "x", kind: "land" as const, label: "土地 1番2" },
  { key: "y", kind: "building" as const, label: "建物 1番2" },
];
const render = (target: string[] | null, dirtyElsewhere = false) => renderToStaticMarkup(
  <DealTargetParcels options={options} target={target} dirtyElsewhere={dirtyElsewhere} busy={false} onSave={() => {}} />,
);

describe("この取引の土地・建物の欄(2026-11-06 3回目)", () => {
  it("選べるものが無ければ何も出さない(1筆1棟の物件の取引は今までどおり)", () => {
    expect(renderToStaticMarkup(<DealTargetParcels options={[]} target={null} dirtyElsewhere={false} busy={false} onSave={() => {}} />)).toBe("");
  });
  it("初め: 選んでいない取引は全部に印・選んだ取引はそれだけ", () => {
    expect((render(null).match(/checked=""/g) ?? []).length).toBe(3);
    const html = render(["x"]);
    expect((html.match(/checked=""/g) ?? []).length).toBe(1);
    expect(html).toContain("この取引の土地・建物");
    expect(html).toContain("土地 1番2");
  });
  it("保存してある選びが物件から消えていたら全部(サーバーと同じ読み方)", () => {
    expect(initialParcelSelection(options, ["消えた"])).toEqual(["main:land", "x", "y"]);
    expect(initialParcelSelection(options, ["y", "消えた"])).toEqual(["y"]);
  });
  it("変えていなければ保存は押せない", () => {
    expect(render(null)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*選んだ土地・建物を保存/);
  });
});

describe("物件タブへの配線(ソース)", () => {
  const src = readFileSync(path.join(__dirname, "..", "deal-property-panel.tsx"), "utf8");
  it("★物件を見られる人・物件のある取引だけに出し、ほかの項目を直している途中は保存させない", () => {
    expect(src).toContain("deal.propertyId && canOpenProperty && parcelOptions.length > 0");
    expect(src).toContain("dirtyElsewhere={dirty}");
    expect(src).toContain("dealsApi.saveTargetParcels(deal.id, deal.version, keys)");
  });
});
