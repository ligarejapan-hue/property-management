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

  it.each([[PROPERTY_PAGE], [LINK_MODAL]])("%s: 郵便番号の欄のすぐ下に postal、住所の欄の下に search を置く", (rel) => {
    const src = read(rel);
    expect(src).not.toContain('mode="both"');
    const postal = src.indexOf('mode="postal"');
    const search = src.indexOf('mode="search"');
    const addressLabel = src.indexOf(">現住所</label>");
    expect(postal).toBeGreaterThan(0);
    expect(search).toBeGreaterThan(0);
    // postal は住所の欄より前(=郵便番号の欄の中)、search は住所の欄より後。
    expect(postal).toBeLessThan(addressLabel);
    expect(search).toBeGreaterThan(addressLabel);
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
