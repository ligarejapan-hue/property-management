import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DirectoryCombobox, {
  BRANCH_NEEDS_BANK_TEXT, DirectoryOptionList, bankSearchUrl, branchSearchUrl, directoryStatusText,
} from "../bank-directory-combobox";

describe("候補の一覧", () => {
  it("選べる行を並べ、選んでいる行に印を付ける。金融機関はコードも出す", () => {
    const html = renderToStaticMarkup(
      <DirectoryOptionList listId="b" activeIndex={1} showCode onPick={() => {}}
        options={[{ code: "0001", name: "みずほ銀行" }, { code: "0005", name: "三菱UFJ銀行" }]} />,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="b-opt-0" role="option" aria-selected="false"');
    expect(html).toContain('id="b-opt-1" role="option" aria-selected="true"');
    expect(html).toContain("みずほ銀行");
    expect(html).toContain("0005");
  });
});

describe("一覧の代わりに出す一言", () => {
  const ok = (data: { code: string; name: string }[]) => ({ key: "u", status: "ok" as const, data });
  it("空なら何も出さない/問い合わせ先が無いなら案内(支店は銀行を選んでから)", () => {
    expect(directoryStatusText({ value: " ", url: null, noUrlText: "x", result: null, resultMatches: false })).toBeNull();
    expect(directoryStatusText({ value: "か", url: null, noUrlText: BRANCH_NEEDS_BANK_TEXT, result: null, resultMatches: false })).toBe(BRANCH_NEEDS_BANK_TEXT);
  });
  it("今の字の結果がまだなら探し中・失敗・該当なしは、そのまま入力できると伝える", () => {
    expect(directoryStatusText({ value: "み", url: "u", noUrlText: "", result: null, resultMatches: false })).toBe("候補を探しています…");
    expect(directoryStatusText({ value: "み", url: "u", noUrlText: "", result: { key: "u", status: "error", data: [] }, resultMatches: true })).toMatch(/そのまま入力できます/);
    expect(directoryStatusText({ value: "み", url: "u", noUrlText: "", result: ok([]), resultMatches: true })).toMatch(/候補がありません/);
    expect(directoryStatusText({ value: "み", url: "u", noUrlText: "", result: ok([{ code: "0001", name: "みずほ銀行" }]), resultMatches: true })).toBeNull();
  });
});

describe("問い合わせ先", () => {
  it("金融機関は打った字で、支店は選んだ銀行のコードと打った字で", () => {
    expect(bankSearchUrl("み")).toBe(`/api/deals/bank-directory/banks?q=${encodeURIComponent("み")}`);
    expect(branchSearchUrl("0001")("か")).toBe(`/api/deals/bank-directory/branches?bank=0001&q=${encodeURIComponent("か")}`);
    expect(branchSearchUrl("")("か")).toBeNull();
  });
});

describe("入力欄", () => {
  it("候補つきの入力欄として読み上げられ、ブラウザの自動入力は出さない", () => {
    const html = renderToStaticMarkup(
      <DirectoryCombobox id="bank" value="" onType={() => {}} onPick={() => {}} searchUrl={bankSearchUrl} ariaLabel="手付金の銀行名" placeholder="銀行名" maxLength={100} />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="手付金の銀行名"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toMatch(/maxlength="100"/i);
  });
});
