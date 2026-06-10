import { describe, it, expect } from "vitest";
import {
  buildCreateOwnerPayload,
  canSubmitOwnerCreate,
  defaultIsPrimaryForLink,
  buildLinkOwnerPayload,
  canShowAddOwner,
  isSelectedOwnerSubmittable,
  buildCreateAndLinkPayload,
  type OwnerCreateFormValues,
} from "@/lib/owner-link-utils";

const baseForm: OwnerCreateFormValues = {
  name: "",
  nameKana: "",
  phone: "",
  zip: "",
  address: "",
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

describe("isSelectedOwnerSubmittable（P2: stale selected 防止）", () => {
  const hits = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("未選択（null）なら false", () => {
    expect(isSelectedOwnerSubmittable(null, hits)).toBe(false);
  });

  it("選択中の owner が現在の検索結果に含まれていなければ false（古い選択は紐付け不可）", () => {
    expect(isSelectedOwnerSubmittable({ id: "z" }, hits)).toBe(false);
    expect(isSelectedOwnerSubmittable({ id: "a" }, [])).toBe(false);
  });

  it("選択中の owner が現在の検索結果に含まれていれば true", () => {
    expect(isSelectedOwnerSubmittable({ id: "b" }, hits)).toBe(true);
  });
});

describe("buildCreateAndLinkPayload（atomic create-and-link 用 payload）", () => {
  const form: OwnerCreateFormValues = {
    name: "  山田太郎 ",
    nameKana: "",
    phone: " 090 ",
    zip: "",
    address: " 東京都 ",
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
