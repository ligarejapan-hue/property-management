import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UndeliverableClearNotice,
  mailingAddressChanges,
  undeliverableClearResultMessage,
} from "@/components/properties/undeliverable-clear-notice";

/**
 * 宛先不明の解除(2026-11-13 発注者決定)の、編集の欄に出す案内とチェック。
 * 「この住所を宛先にする」で開いた編集のときだけ出す。解除は、住所を保存できたあとにだけ行う。
 */
const noop = () => {};

describe("UndeliverableClearNotice", () => {
  it("解除できる記録があれば、件数つきのチェックを出す", () => {
    const html = renderToStaticMarkup(
      <UndeliverableClearNotice summary={{ clearable: 2, shared: 0, other: 0 }} checked onChange={noop} mailingChanges />,
    );
    expect(html).toContain("古い住所あての「宛先不明」（2件）を解除して、この方をDMに戻す");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("「送付可」に戻ります");
  });

  it("⚠共有でまとめて送った記録は、解除しないことと件数を出す(発注者決定)", () => {
    const html = renderToStaticMarkup(
      <UndeliverableClearNotice summary={{ clearable: 1, shared: 3, other: 0 }} checked={false} onChange={noop} mailingChanges />,
    );
    expect(html).toContain("共有の方とまとめて送った「宛先不明」が 3 件あります");
    expect(html).toContain("自動では解除しません");
  });

  it("解除できる記録が無ければ、チェックは出さず「戻りません」と知らせる", () => {
    const html = renderToStaticMarkup(
      <UndeliverableClearNotice summary={{ clearable: 0, shared: 1, other: 2 }} checked={false} onChange={noop} mailingChanges />,
    );
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("解除しない「宛先不明」が 2 件あります");
    expect(html).toContain("この方はDMの対象に戻りません");
  });

  it("⚠保存しても宛先が変わらないとき(現住所がある方)は、チェックを出さず、解除しないと知らせる(@codex P2)", () => {
    const html = renderToStaticMarkup(
      <UndeliverableClearNotice
        summary={{ clearable: 2, shared: 0, other: 0 }}
        checked
        onChange={noop}
        mailingChanges={false}
      />,
    );
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("DMの宛先は変わりません");
    expect(html).toContain("「宛先不明」は解除しません");
  });

  it("宛先不明が無い所有者・件数を渡されていないときは何も出さない", () => {
    expect(
      renderToStaticMarkup(
        <UndeliverableClearNotice summary={{ clearable: 0, shared: 0, other: 0 }} checked={false} onChange={noop} mailingChanges />,
      ),
    ).toBe("");
    expect(renderToStaticMarkup(<UndeliverableClearNotice summary={null} checked={false} onChange={noop} mailingChanges />)).toBe("");
  });
});

describe("mailingAddressChanges(保存で実際の宛先が変わるか・@codex P2)", () => {
  const before = { zip: "1000001", address: "東京都見本区1-1-1", currentZip: "", currentAddress: "" };

  it("現住所が無い方: 登記上の住所を替えれば、宛先が変わる", () => {
    expect(mailingAddressChanges(before, { ...before, address: "大阪府見本市2-2-2", zip: "" })).toBe(true);
  });

  it("⚠現住所がある方: 登記上の住所を替えても、宛先は現住所のまま=変わらない", () => {
    const withCurrent = { ...before, currentAddress: "神奈川県見本市3-3-3" };
    expect(mailingAddressChanges(withCurrent, { ...withCurrent, address: "大阪府見本市2-2-2" })).toBe(false);
  });

  it("現住所を消して登記上の別の住所にすれば、宛先が変わる", () => {
    const withCurrent = { ...before, currentAddress: "神奈川県見本市3-3-3" };
    expect(
      mailingAddressChanges(withCurrent, { ...before, address: "大阪府見本市2-2-2", currentAddress: "" }),
    ).toBe(true);
  });

  it("同じ住所(全角と半角・空白の違いだけ)は変わっていない・宛先が空になるのも変わったと扱わない", () => {
    expect(mailingAddressChanges(before, { ...before, address: "東京都見本区１-１-１ " })).toBe(false);
    expect(mailingAddressChanges(before, { ...before, address: "" })).toBe(false);
  });
});

describe("undeliverableClearResultMessage(結果の知らせ・件数だけ)", () => {
  it("解除した件数と、DM 可否を戻した物件の数を知らせる", () => {
    expect(
      undeliverableClearResultMessage({ cleared: 2, sharedSkipped: 0, otherSkipped: 0, flagsCleared: 1, dmStatusRestored: 1 }),
    ).toBe("「宛先不明」を 2 件解除しました。DM可否を「送付可」に戻した物件: 1 件。");
  });

  it("⚠解除していない記録が残っていれば、まだ DM の対象に戻らないことを知らせる", () => {
    const msg = undeliverableClearResultMessage({
      cleared: 1, sharedSkipped: 1, otherSkipped: 1, flagsCleared: 0, dmStatusRestored: 0,
    });
    expect(msg).toContain("解除していない「宛先不明」が 2 件残っています");
    expect(msg).toContain("まだDMの対象に戻りません");
  });

  it("解除できるものが無かったとき", () => {
    expect(
      undeliverableClearResultMessage({ cleared: 0, sharedSkipped: 0, otherSkipped: 0, flagsCleared: 0, dmStatusRestored: 0 }),
    ).toBe("解除できる「宛先不明」はありませんでした。");
  });
});

describe("物件の所有者カードへの組み込み(ソース)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("チェックは「この住所を宛先にする」で開いた編集のときだけ出す(ふつうの編集では出さない)", () => {
    expect(src).toContain("{viaRegistryAddress && (");
    const edit = src.slice(src.indexOf("const handleEdit = () => {"), src.indexOf("const handleUseRegistryAddress"));
    expect(edit).toContain("setViaRegistryAddress(false);");
    expect(edit).toContain("setClearUndeliverable(false);");
    const use = src.slice(src.indexOf("const handleUseRegistryAddress"), src.indexOf("const handleCancel"));
    expect(use).toContain("setViaRegistryAddress(true);");
  });

  it("⚠解除は、住所の保存(updateOwner)ができたあとにだけ呼ぶ", () => {
    const save = src.slice(src.indexOf("const handleSave = async () => {"), src.indexOf("} catch (err) {", src.indexOf("const handleSave = async () => {")));
    const iUpdate = save.indexOf("await updateOwner(");
    const iClear = save.indexOf("await clearOwnerDmUndeliverable(propertyId, po.ownerId)");
    expect(iUpdate).toBeGreaterThan(0);
    expect(iClear).toBeGreaterThan(iUpdate);
    // チェックを入れたときだけ
    // チェックを入れ、かつ実際の宛先が変わるときだけ(@codex P2)
    expect(save).toContain(
      "if (viaRegistryAddress && clearUndeliverable && mailingAddressChanges(po.owner, form)) {",
    );
  });
});
