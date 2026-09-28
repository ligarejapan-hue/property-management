import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 2026-09-26 発注者メモ「後で改修するもの」: 所有者の編集画面の使いにくさ3件。
const dir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n");
const PROPERTY_PAGE = "../../app/(dashboard)/properties/[id]/page.tsx";
const LINK_MODAL = "../../components/owners/owner-link-modal.tsx";

describe("郵便番号→住所のボタン(発注者指定: 名前を変え、郵便番号のすぐ下へ)", () => {
  it("ボタンの名前は「郵便番号から住所を自動入力」", () => {
    const src = read("../../components/address/address-lookup-controls.tsx");
    expect(src).toContain("郵便番号から住所を自動入力");
    expect(src).not.toMatch(/>\s*住所を自動入力\s*</);
  });

  it.each([[PROPERTY_PAGE], [LINK_MODAL]])("%s: 住所補完の部品は1つだけで、郵便番号の欄のすぐ下(住所の欄より前)に置く", (rel) => {
    const src = read(rel);
    // ⚠2つに分けると、取消と「自動入力は再検索しない」の見張りが別々になり、郵便番号から入れた住所で
    //   住所→郵便番号の検索が走り直す(@codex #447 R1)。1つのまま置き場所だけ変える。
    expect(src.split("<AddressLookupControls").length - 1).toBe(1);
    const both = src.indexOf('mode="both"');
    const addressLabel = src.indexOf(">現住所</label>");
    expect(both).toBeGreaterThan(0);
    expect(both).toBeLessThan(addressLabel);
  });
});

describe("電話番号はハイフンありにそろえる(発注者決定)", () => {
  it.each([[PROPERTY_PAGE], [LINK_MODAL]])("%s: 欄を離れたときに自動でハイフンを入れ、正しくない番号には確認を促す", (rel) => {
    const src = read(rel);
    expect(src).toContain('from "@/lib/phone-format-jp"');
    expect(src).toMatch(/type="tel"[\s\S]{0,400}onBlur=\{[\s\S]{0,200}formatPhoneJp\(/);
    expect(src).toContain("isValidPhoneJp(");
    expect(src).toContain("電話番号の桁をご確認ください");
    expect(src).toMatch(/placeholder="例: 09012345678"/);
  });
});

describe("所有者名の欄を1回で空にできる(発注者: 名前が入っていて邪魔)", () => {
  it("所有者の編集で、氏名の欄に「×」(中身を消す)ボタンがある", () => {
    const src = read(PROPERTY_PAGE);
    expect(src).toContain('aria-label="所有者名を消す"');
    expect(src).toMatch(/aria-label="所有者名を消す"[\s\S]{0,300}name: ""/);
  });
});
