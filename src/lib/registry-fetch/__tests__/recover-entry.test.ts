/**
 * 【回収】どちらの探し方で取り込むかの判断(@codex #394 R10 P1)。
 *
 * ⚠実害の記録: 確認パネルの「取得済みを取り込む（課金なし）」は引数なしで
 * 呼ばれるため、候補が無い(検索できない物件からの)経路では早期 return に
 * 当たり、**押しても何も起きない**状態になっていた。判断を純関数に出して、
 * 4通り全部をここで固定する。
 */
import { describe, expect, it } from "vitest";
import { resolveRecoverEntry } from "@/lib/registry-fetch/recover-entry";

describe("回収の探し方の決定", () => {
  it("候補を選んでいれば候補で取り込む", () => {
    expect(
      resolveRecoverEntry({ fromProperty: false, hasSelection: true }),
    ).toBe("candidate");
  });

  it("⚠候補が無ければ物件自身の地番で取り込む(押しても無反応にしない)", () => {
    expect(
      resolveRecoverEntry({ fromProperty: false, hasSelection: false }),
    ).toBe("property");
  });

  it("物件から始めた回収は、候補があっても物件の地番で取り込む", () => {
    expect(
      resolveRecoverEntry({ fromProperty: true, hasSelection: true }),
    ).toBe("property");
  });

  it("物件から始めて候補も無い場合も物件の地番", () => {
    expect(
      resolveRecoverEntry({ fromProperty: true, hasSelection: false }),
    ).toBe("property");
  });
});
