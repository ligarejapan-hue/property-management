import { describe, it, expect } from "vitest";
import {
  pickReusableAddresslessOwner,
  type LinkedOwnerCandidate,
} from "@/lib/registry-pdf/owner-reuse";

/**
 * 住所の無い所有者を、**その物件に既に紐づいている**所有者から再利用してよいかの判定。
 *
 * 背景: 住所の無い所有者は「名前だけでの自動統合はしない」規則のため、取り込むたびに
 * 新しく作られる。謄本PDFの保存は処理の最後で、失敗しても取込自体は成功扱い（警告のみ）
 * なので「PDFだけ入らなかったのでやり直す」が現実に起き、そのたびに所有者が増える
 * （@codex #394 R6 P2）。
 * ⚠**グローバルな名前だけの統合は従来どおり禁止**（同姓同名の別人を混ぜない）。
 *   ここで再利用するのは**同じ物件に既に紐づいている**所有者だけ。
 */
const owner = (o: Partial<LinkedOwnerCandidate>): LinkedOwnerCandidate => ({
  id: "o1",
  name: "山田太郎",
  address: null,
  isArchived: false,
  corporateNumber: null,
  ...o,
});

describe("pickReusableAddresslessOwner", () => {
  it("同じ物件に同名・住所なしの所有者が居れば再利用する（やり直しで増やさない）", () => {
    const hit = pickReusableAddresslessOwner([owner({ id: "o-1" })], "山田太郎");
    expect(hit?.id).toBe("o-1");
  });

  it("名前が違えば再利用しない（別人を混ぜない）", () => {
    expect(
      pickReusableAddresslessOwner([owner({ name: "鈴木一郎" })], "山田太郎"),
    ).toBeNull();
  });

  it("表記ゆれ（全角空白・旧字などの正規化）を吸収する", () => {
    // normalizeName と同じ正規化で比べる（片方だけ素の値で比べると永久にすれ違う）。
    const hit = pickReusableAddresslessOwner(
      [owner({ id: "o-2", name: "山田　太郎" })],
      "山田 太郎",
    );
    expect(hit?.id).toBe("o-2");
  });

  it("アーカイブ済みの所有者は再利用しない", () => {
    expect(
      pickReusableAddresslessOwner([owner({ isArchived: true })], "山田太郎"),
    ).toBeNull();
  });

  it("紐づきが無ければ再利用しない（初回の取込は従来どおり新規作成）", () => {
    expect(pickReusableAddresslessOwner([], "山田太郎")).toBeNull();
  });

  it("名前が空なら再利用しない（空同士で誤って一致させない）", () => {
    expect(pickReusableAddresslessOwner([owner({ name: "" })], "")).toBeNull();
  });

  it("住所を後から入れた所有者にも当てる（同じ物件なら同一人物とみなす）", () => {
    // ⚠住所ありに限定すると、人が後から住所を入れた瞬間に重複が復活する。
    const hit = pickReusableAddresslessOwner(
      [owner({ id: "o-3", address: "東京都港区1-1" })],
      "山田太郎",
    );
    expect(hit?.id).toBe("o-3");
  });

  it("同名が複数居るときは住所の無い方を優先する（前回の取込で作られたのは住所なし）", () => {
    const hit = pickReusableAddresslessOwner(
      [
        owner({ id: "o-withaddr", address: "東京都港区1-1" }),
        owner({ id: "o-noaddr", address: null }),
      ],
      "山田太郎",
    );
    expect(hit?.id).toBe("o-noaddr");
  });
});
