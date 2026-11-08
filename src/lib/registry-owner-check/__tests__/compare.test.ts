import { describe, it, expect } from "vitest";

import { compareRegistryOwners, planOwnerReplacement } from "@/lib/registry-owner-check/compare";

describe("compareRegistryOwners(照合と同じそろえ方)", () => {
  it("システムに所有者がいなければ no_owner", () => {
    expect(compareRegistryOwners(["山田太郎"], [])).toBe("no_owner");
  });

  it("全角半角・空白だけの違いは same", () => {
    expect(compareRegistryOwners(["山田　太郎"], ["山田太郎"])).toBe("same");
    expect(compareRegistryOwners(["ＡＢＣ株式会社"], ["ABC株式会社"])).toBe("same");
  });

  it("(株)と株式会社・大文字小文字・異体字だけの違いは same_notation", () => {
    expect(compareRegistryOwners(["株式会社ABC"], ["株式会社abc"])).toBe("same_notation");
    expect(compareRegistryOwners(["ABC(株)"], ["ABC株式会社"])).toBe("same_notation");
    expect(compareRegistryOwners(["髙橋一郎"], ["高橋一郎"])).toBe("same_notation");
    expect(compareRegistryOwners(["渡邉花子", "山﨑次郎"], ["渡辺花子", "山崎次郎"])).toBe("same_notation");
  });

  it("謄本の人がシステムにいなければ mismatch", () => {
    expect(compareRegistryOwners(["山田太郎", "山田花子"], ["山田太郎"])).toBe("mismatch");
    expect(compareRegistryOwners(["鈴木一郎"], ["佐藤一郎"])).toBe("mismatch");
  });

  it("謄本にない人がシステムにいても mismatch", () => {
    expect(compareRegistryOwners(["山田太郎"], ["山田太郎", "山田花子"])).toBe("mismatch");
  });

  it("謄本に同じ人が2回載っていても(持分の行)同じ人として数える", () => {
    expect(compareRegistryOwners(["山田太郎", "山田　太郎"], ["山田太郎"])).toBe("same");
  });
});

describe("planOwnerReplacement(謄本の名義に直す)", () => {
  const reg = (name: string, address: string | null = "東京都千代田区1-1") => ({ name, address, share: null });

  it("謄本にない人は外し、システムにいない謄本の人は足す", () => {
    const plan = planOwnerReplacement(
      [reg("山田太郎"), reg("山田花子")],
      [
        { ownerId: "o1", name: "山田太郎" },
        { ownerId: "o2", name: "佐藤一郎" },
      ],
    );
    expect(plan.keepOwnerIds).toEqual(["o1"]);
    expect(plan.removeOwnerIds).toEqual(["o2"]);
    expect(plan.add.map((o) => o.name)).toEqual(["山田花子"]);
  });

  it("表記の違いだけの人は外さない・足さない(二重に登録しない)", () => {
    const plan = planOwnerReplacement([reg("髙橋一郎")], [{ ownerId: "o1", name: "高橋一郎" }]);
    expect(plan).toEqual({ keepOwnerIds: ["o1"], removeOwnerIds: [], add: [] });
  });

  it("余分な人だけのとき(足す人なし)", () => {
    const plan = planOwnerReplacement(
      [reg("山田太郎")],
      [
        { ownerId: "o1", name: "山田太郎" },
        { ownerId: "o2", name: "山田花子" },
      ],
    );
    expect(plan).toEqual({ keepOwnerIds: ["o1"], removeOwnerIds: ["o2"], add: [] });
  });

  it("全員入れ替え", () => {
    const plan = planOwnerReplacement([reg("鈴木一郎")], [{ ownerId: "o1", name: "佐藤一郎" }]);
    expect(plan.keepOwnerIds).toEqual([]);
    expect(plan.removeOwnerIds).toEqual(["o1"]);
    expect(plan.add.map((o) => o.name)).toEqual(["鈴木一郎"]);
  });
});
