import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealPlaceField } from "../deal-place-field";
import { EMPTY_PLACE, type PlaceForm } from "@/lib/deals/place";

const draw = (value: PlaceForm, allowBank = true) =>
  renderToStaticMarkup(<DealPlaceField label="決済場所" allowBank={allowBank} value={value} onChange={() => {}} />);

describe("契約場所・決済場所の欄", () => {
  it("決済場所には銀行の選択肢・契約場所には無い", () => {
    expect(draw(EMPTY_PLACE)).toContain(">銀行</option>");
    expect(draw(EMPTY_PLACE, false)).not.toContain(">銀行</option>");
  });
  it("選択肢を選んだだけでは手入力の欄を出さない", () => {
    const html = draw({ ...EMPTY_PLACE, kind: "当社事務所" });
    expect(html).not.toContain("<input");
  });
  it("その他のときだけ場所の欄", () => {
    const html = draw({ ...EMPTY_PLACE, kind: "その他", other: "試験区の貸会議室" });
    expect(html).toContain('aria-label="決済場所(場所)"');
    expect(html).toContain('value="試験区の貸会議室"');
    expect(html).not.toContain("銀行名");
  });
  it("銀行のときだけ銀行名と支店名の欄", () => {
    const html = draw({ ...EMPTY_PLACE, kind: "銀行" });
    expect(html).toContain('aria-label="決済場所(銀行名)"');
    expect(html).toContain('aria-label="決済場所(支店名)"');
    expect(html).toContain("銀行名と支店名を入れてください");
  });
});
