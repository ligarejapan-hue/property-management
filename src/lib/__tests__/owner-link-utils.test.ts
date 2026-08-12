import { describe, it, expect } from "vitest";
import {
  buildCreateOwnerPayload,
  canSubmitOwnerCreate,
  defaultIsPrimaryForLink,
  buildLinkOwnerPayload,
  canShowAddOwner,
  isSelectedOwnerSubmittable,
  isLatestSearch,
  isExistingLinkedOwner,
  isOwnerSearchHitSelectable,
  buildCreateAndLinkPayload,
  type OwnerCreateFormValues,
} from "@/lib/owner-link-utils";

const baseForm: OwnerCreateFormValues = {
  name: "",
  nameKana: "",
  phone: "",
  zip: "",
  address: "",
  // 現住所は未設定（＝登記上の住所を使う）を既定にする。
  // 現住所そのものの挙動は owner-current-address-write.test.ts で固定している。
  currentAddress: "",
  currentZip: "",
  email: "",
};

describe("buildCreateOwnerPayload", () => {
  it("name を trim して返す", () => {
    const payload = buildCreateOwnerPayload({ ...baseForm, name: "  山田太郎  " });
    expect(payload.name).toBe("山田太郎");
  });

  it("空欄の任意項目は null になる（DB に空文字を書かない）", () => {
    const payload = buildCreateOwnerPayload({ ...baseForm, name: "山田太郎" });
    expect(payload.nameKana).toBeNull();
    expect(payload.phone).toBeNull();
    expect(payload.zip).toBeNull();
    expect(payload.address).toBeNull();
    expect(payload.email).toBeNull();
  });

  it("入力済みの任意項目は trim して保持する", () => {
    const payload = buildCreateOwnerPayload({
      name: "山田太郎",
      nameKana: " ヤマダタロウ ",
      phone: " 090-1234-5678 ",
      zip: " 100-0001 ",
      address: " 東京都千代田区 ",
      currentAddress: "",
      currentZip: "",
      email: " a@example.com ",
    });
    expect(payload.nameKana).toBe("ヤマダタロウ");
    expect(payload.phone).toBe("090-1234-5678");
    expect(payload.zip).toBe("100-0001");
    expect(payload.address).toBe("東京都千代田区");
    expect(payload.email).toBe("a@example.com");
  });
});

describe("canSubmitOwnerCreate", () => {
  it("name が空なら false", () => {
    expect(canSubmitOwnerCreate({ name: "" })).toBe(false);
  });

  it("name が空白のみなら false", () => {
    expect(canSubmitOwnerCreate({ name: "   " })).toBe(false);
  });

  it("name があれば true", () => {
    expect(canSubmitOwnerCreate({ name: "山田太郎" })).toBe(true);
  });
});

describe("defaultIsPrimaryForLink", () => {
  it("既存所有者が 0 件なら true（最初の1人を主所有者にする）", () => {
    expect(defaultIsPrimaryForLink(0)).toBe(true);
  });

  it("既存所有者がいれば false", () => {
    expect(defaultIsPrimaryForLink(1)).toBe(false);
    expect(defaultIsPrimaryForLink(3)).toBe(false);
  });
});

describe("canShowAddOwner", () => {
  it("owner:read かつ owner:write があるときだけ true", () => {
    expect(canShowAddOwner(true, true)).toBe(true);
  });

  it("owner:write が無ければ false（field_staff など閲覧専用に導線を出さない）", () => {
    expect(canShowAddOwner(true, false)).toBe(false);
  });

  it("owner:read が無ければ false", () => {
    expect(canShowAddOwner(false, true)).toBe(false);
    expect(canShowAddOwner(false, false)).toBe(false);
  });
});

describe("isSelectedOwnerSubmittable（P2: stale selected / 既存紐付け防止）", () => {
  const hits = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("未選択（null）なら false", () => {
    expect(isSelectedOwnerSubmittable(null, hits, [])).toBe(false);
  });

  it("選択中の owner が現在の検索結果に含まれていなければ false（古い選択は紐付け不可）", () => {
    expect(isSelectedOwnerSubmittable({ id: "z" }, hits, [])).toBe(false);
    expect(isSelectedOwnerSubmittable({ id: "a" }, [], [])).toBe(false);
  });

  it("選択中の owner が現在の検索結果に含まれていれば true", () => {
    expect(isSelectedOwnerSubmittable({ id: "b" }, hits, [])).toBe(true);
  });

  it("選択中の owner が既に紐付け済み(existingOwnerIds)なら false（unique 制約 500 を UI で防ぐ）", () => {
    expect(isSelectedOwnerSubmittable({ id: "b" }, hits, ["b"])).toBe(false);
  });
});

describe("isExistingLinkedOwner / isOwnerSearchHitSelectable（既に紐付け済み owner）", () => {
  const existing = ["o1", "o2"];

  it("既存紐付けID一覧に含まれれば既存紐付け済み", () => {
    expect(isExistingLinkedOwner("o1", existing)).toBe(true);
    expect(isExistingLinkedOwner("o9", existing)).toBe(false);
  });

  it("既存紐付け済み owner は検索結果で選択不可（それ以外は選択可）", () => {
    expect(isOwnerSearchHitSelectable({ id: "o1" }, existing)).toBe(false);
    expect(isOwnerSearchHitSelectable({ id: "o9" }, existing)).toBe(true);
  });
});

describe("isLatestSearch（Codex: stale 検索レスポンス破棄）", () => {
  it("リクエスト seq が最新と一致すれば true（結果を反映してよい）", () => {
    expect(isLatestSearch(3, 3)).toBe(true);
  });

  it("古いリクエスト（seq < 最新）の結果は破棄する（false）", () => {
    // 後から解決した古い検索が新しい検索結果を上書きしないことを保証する判定。
    expect(isLatestSearch(1, 2)).toBe(false);
    expect(isLatestSearch(2, 5)).toBe(false);
  });
});

describe("buildCreateAndLinkPayload（atomic create-and-link 用 payload）", () => {
  const form: OwnerCreateFormValues = {
    name: "  山田太郎 ",
    nameKana: "",
    phone: " 090 ",
    zip: "",
    address: " 東京都 ",
    currentAddress: "",
    currentZip: "",
    email: "",
  };

  it("owner 作成 payload に relationship / isPrimary を統合する", () => {
    const payload = buildCreateAndLinkPayload(form, " 本人 ", true);
    expect(payload).toEqual({
      name: "山田太郎",
      nameKana: null,
      phone: "090",
      zip: null,
      address: "東京都",
      // ⚠現住所は**常にペアで**送る（片方だけ送るとサーバー側の規則で拒否/クリアされる）。
      // 未設定なら両方 null＝「現住所は使わない＝登記上の住所へ送る」。
      currentAddress: null,
      currentZip: null,
      email: null,
      relationship: "本人",
      isPrimary: true,
    });
  });

  it("relationship が空なら null・isPrimary を透過", () => {
    const payload = buildCreateAndLinkPayload(form, "   ", false);
    expect(payload.relationship).toBeNull();
    expect(payload.isPrimary).toBe(false);
    expect(payload.name).toBe("山田太郎");
  });
});

describe("buildLinkOwnerPayload", () => {
  it("relationship が空なら null", () => {
    const payload = buildLinkOwnerPayload("owner-1", "   ", false);
    expect(payload).toEqual({ ownerId: "owner-1", relationship: null, isPrimary: false });
  });

  it("relationship を trim して保持し、isPrimary を透過する", () => {
    const payload = buildLinkOwnerPayload("owner-2", "  本人  ", true);
    expect(payload).toEqual({ ownerId: "owner-2", relationship: "本人", isPrimary: true });
  });
});
