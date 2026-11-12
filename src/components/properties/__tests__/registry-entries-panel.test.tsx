import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RegistryEntriesPanel,
  RegistryShareBadge,
} from "@/components/properties/registry-entries-panel";

/**
 * 登記上の記載(所有者事項の行ごとの住所と持分・2026-11-12 発注者決定)の見た目。
 * - 持分の札は所有者全員に出す(共有者も・行が1つだけの人も)。
 * - 内訳の表は行が2つ以上の人だけ。
 */
const three = {
  entries: [
    { position: 1, address: "東京都港区見本1-1-1", share: { num: 2, den: 10 } },
    { position: 2, address: "埼玉県さいたま市見本区2-2-2", share: { num: 3, den: 10 } },
    { position: 3, address: "神奈川県横浜市見本区3-3-3", share: { num: 2, den: 10 } },
  ],
  shareTotal: { num: 7, den: 10 },
};
const one = {
  entries: [{ position: 2, address: "神奈川県横浜市見本区3-3-3", share: { num: 3, den: 10 } }],
  shareTotal: { num: 3, den: 10 },
};

describe("RegistryShareBadge", () => {
  it("持分の合計を札で出す(行が1つだけの共有者にも出す)", () => {
    expect(renderToStaticMarkup(<RegistryShareBadge registry={three} />)).toContain("持分 7/10");
    expect(renderToStaticMarkup(<RegistryShareBadge registry={one} />)).toContain("持分 3/10");
  });

  it("合計が出せない・記載が無いときは何も出さない", () => {
    expect(renderToStaticMarkup(<RegistryShareBadge registry={{ ...one, shareTotal: null }} />)).toBe("");
    expect(renderToStaticMarkup(<RegistryShareBadge registry={null} />)).toBe("");
  });
});

describe("RegistryEntriesPanel", () => {
  it("行が2つ以上なら、行ごとの住所と持分を表で出す", () => {
    const html = renderToStaticMarkup(<RegistryEntriesPanel registry={three} />);
    expect(html).toContain("所有者事項に 3 行");
    expect(html).toContain("東京都港区見本1-1-1");
    expect(html).toContain("3/10");
    expect(html).toContain("所有者事項からは分かりません");
  });

  it("行が1つだけ・記載が無いときは表を出さない(今までと同じ見た目)", () => {
    expect(renderToStaticMarkup(<RegistryEntriesPanel registry={one} />)).toBe("");
    expect(renderToStaticMarkup(<RegistryEntriesPanel registry={undefined} />)).toBe("");
  });

  it("住所が伏せられている行・持分が読めない行は「-」", () => {
    const html = renderToStaticMarkup(
      <RegistryEntriesPanel
        registry={{
          entries: [
            { position: 1, address: null, share: null },
            { position: 2, address: "住所B", share: { num: 1, den: 2 } },
          ],
          shareTotal: null,
        }}
      />,
    );
    expect(html).toContain(">-<");
  });

  it("⚠行の順に新旧の意味を持たせる言葉(最新・現在の住所)を書かない", () => {
    const html = renderToStaticMarkup(<RegistryEntriesPanel registry={three} />);
    expect(html).not.toMatch(/最新|最も新しい|現在の住所/);
  });
});

describe("物件の所有者カードへの組み込み(ソース)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("見出しに持分の札・見出しの下に内訳の表を置く", () => {
    expect(src).toContain("<RegistryShareBadge registry={po.registry} />");
    expect(src).toContain("<RegistryEntriesPanel");
    expect(src).toContain("registry={po.registry}");
  });

  it("「この住所を宛先にする」は、住所と郵便番号の両方を編集できる人に・編集中でないときだけ渡す", () => {
    const flat = src.split(/\s+/).join(" ");
    expect(flat).toContain(
      "onUseAddress={ editAllowed && !editing && !editLockHeld && editableFields.address && editableFields.zip ? handleUseRegistryAddress : undefined }",
    );
  });

  it("⚠押しても保存はしない(編集を開いて住所を入れ、郵便番号を空にするだけ)", () => {
    const start = src.indexOf("const handleUseRegistryAddress = (address: string) => {");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("\n  };", start));
    expect(body).toContain("handleEdit();");
    expect(body).toContain('setForm((f) => ({ ...f, address, zip: "" }));');
    for (const word of ["handleSave", "updateOwner", "fetch("]) {
      expect(body).not.toContain(word);
    }
  });
});

describe("この住所を宛先にする(第2回)", () => {
  const owner = "神奈川県横浜市見本区3-3-3";

  it("今の登記上の住所と同じ行には「今の宛先」・ほかの行にはボタンを出す", () => {
    const html = renderToStaticMarkup(
      <RegistryEntriesPanel registry={three} ownerAddress={owner} onUseAddress={() => {}} />,
    );
    expect(html.match(/今の宛先/g)).toHaveLength(1);
    expect(html.split("この住所を宛先にする</button>").length - 1).toBe(2);
    expect(html).toContain("保存で確定してください");
  });

  it("書き方だけ違う住所(全角・ハイフン)も同じ住所として「今の宛先」にする", () => {
    const html = renderToStaticMarkup(
      <RegistryEntriesPanel registry={three} ownerAddress={"神奈川県横浜市見本区３－３－３"} onUseAddress={() => {}} />,
    );
    expect(html.match(/今の宛先/g)).toHaveLength(1);
  });

  it("⚠編集できない人(onUseAddress なし)にはボタンを出さない", () => {
    const html = renderToStaticMarkup(<RegistryEntriesPanel registry={three} ownerAddress={owner} />);
    expect(html).not.toContain("この住所を宛先にする</button>");
    expect(html).toContain("今の宛先");
  });

  it("住所が伏せられている行(null)にはボタンを出さない", () => {
    const html = renderToStaticMarkup(
      <RegistryEntriesPanel
        registry={{ entries: [{ position: 1, address: null, share: null }, { position: 2, address: "住所B", share: null }], shareTotal: null }}
        ownerAddress={"住所Z"}
        onUseAddress={() => {}}
      />,
    );
    expect(html.split("この住所を宛先にする</button>").length - 1).toBe(1);
  });

  it("現住所が入っている人には、DM は現住所あてと出す", () => {
    const html = renderToStaticMarkup(
      <RegistryEntriesPanel registry={three} ownerAddress={owner} hasCurrentAddress onUseAddress={() => {}} />,
    );
    expect(html).toContain("DM は現住所あてに出ます");
  });
});
