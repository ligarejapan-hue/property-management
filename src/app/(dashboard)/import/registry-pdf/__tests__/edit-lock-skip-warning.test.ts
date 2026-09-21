/**
 * D10: 謄本PDF取込結果画面の「編集中のため補完を見送りました」表示。
 *
 * 表示を入れないと、取込は成功したのに欄が空のままであることに誰も気づけない。
 * 画面から判定を切り出した純粋関数 editLockSkipMessages を検査する
 * (@codex R7 P2: 表示もこの Task の範囲・R12 P2: 2つのフラグを別々に検査する)。
 * ⚠描画までは確かめない(ブリーフの指示どおり)。
 */
import { describe, it, expect } from "vitest";
import { editLockSkipMessages } from "../page";

describe("editLockSkipMessages", () => {
  it("両方 false なら何も出さない", () => {
    expect(
      editLockSkipMessages({
        propertyFillSkippedByEditLock: false,
        ownerCorporateFillSkippedByEditLock: false,
      }),
    ).toEqual([]);
  });

  it("フラグが無い(undefined)ときも何も出さない", () => {
    expect(editLockSkipMessages({})).toEqual([]);
  });

  it("物件側だけ true なら物件の文言だけを出す", () => {
    const messages = editLockSkipMessages({
      propertyFillSkippedByEditLock: true,
      ownerCorporateFillSkippedByEditLock: false,
    });
    expect(messages).toEqual([
      "編集中のため、地番・家屋番号・不動産番号の補完を見送りました",
    ]);
  });

  it("所有者側だけ true なら所有者の文言だけを出す", () => {
    const messages = editLockSkipMessages({
      propertyFillSkippedByEditLock: false,
      ownerCorporateFillSkippedByEditLock: true,
    });
    expect(messages).toEqual(["編集中のため、法人番号の補完を見送りました"]);
  });

  it("両方 true なら両方の文言を出す(物件→所有者の順)", () => {
    const messages = editLockSkipMessages({
      propertyFillSkippedByEditLock: true,
      ownerCorporateFillSkippedByEditLock: true,
    });
    expect(messages).toEqual([
      "編集中のため、地番・家屋番号・不動産番号の補完を見送りました",
      "編集中のため、法人番号の補完を見送りました",
    ]);
  });
});
