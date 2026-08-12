/**
 * 21-C PR: 住所補完 UI core（AddressLookupControls）を Owner フォームへ統合した配線を
 * source assertion で固定する（node 環境＝描画テスト不可・既存テスト構成に合わせる）。
 *
 * 対象 2 面:
 *  - Owner 新規作成: src/components/owners/owner-link-modal.tsx（create モード）
 *  - Owner 編集: 物件詳細 OwnerCard（src/app/(dashboard)/properties/[id]/page.tsx）
 *
 * 検証の主眼は addressEdited（user-edit signal）契約（Codex P2-G）:
 *  住所 input をユーザーが直接編集したときだけ addressEdited=true。
 *  候補 apply（onAddressChange）や初期ロードでは立てない＝レコードを開いた・既存値が
 *  入っただけでは provider へ住所 PII を送らない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (rel: string) =>
  readFileSync(resolve(process.cwd(), rel), "utf8");

const modal = read("src/components/owners/owner-link-modal.tsx");
const ownerCard = read("src/app/(dashboard)/properties/[id]/page.tsx");

describe("Owner 新規作成（owner-link-modal create モード）への統合", () => {
  it("AddressLookupControls を import して使う", () => {
    expect(modal).toMatch(
      /from\s+["']@\/components\/address\/address-lookup-controls["']/,
    );
    expect(modal).toContain("<AddressLookupControls");
  });

  it("zip/address は form の永続フィールドに束ねる（owner は zip を持つ）", () => {
    // ⚠現住所の2段化(2026-08)以降、補完の対象は「分けているかどうか」で切り替わる。
    // 分けていないときは登記上(zip/address)、分けているときは現住所(currentZip/currentAddress)。
    // 登記上の欄に補完を効かせると、郵便番号APIの正規化表記で登記の記載を書き換えてしまう。
    expect(modal).toMatch(/zip=\{addressSplit \? form\.currentZip : form\.zip\}/);
    expect(modal).toMatch(
      /address=\{addressSplit \? form\.currentAddress : form\.address\}/,
    );
    // 候補確定で zip/address をペア反映（form を更新）。
    expect(modal).toMatch(/onZipChange=\{[\s\S]*?zip:/);
    expect(modal).toMatch(/onAddressChange=\{[\s\S]*?address:/);
  });

  it("addressEdited を state で持ち（既定 false）AddressLookupControls へ渡す", () => {
    expect(modal).toMatch(
      /const \[addressEdited, setAddressEdited\] = useState\(false\)/,
    );
    expect(modal).toContain("addressEdited={addressEdited}");
  });

  it("user-edit signal は住所 input のユーザー編集時だけ立てる（candidate apply では立てない）", () => {
    // setAddressEdited(true) はちょうど 1 箇所（住所 input の onChange）だけ。
    const occurrences = modal.match(/setAddressEdited\(true\)/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("disabled / mode を渡す", () => {
    expect(modal).toContain("disabled={submitting}");
    expect(modal).toMatch(/mode="(both|postal|search)"/);
  });
});

describe("Owner 編集（物件詳細 OwnerCard）への統合", () => {
  it("AddressLookupControls を import して使う", () => {
    expect(ownerCard).toMatch(
      /from\s+["']@\/components\/address\/address-lookup-controls["']/,
    );
    expect(ownerCard).toContain("<AddressLookupControls");
  });

  it("zip/address フィールド権限がそろう時だけ補完 UI を出す（書込権限 gate）", () => {
    // zip と address の双方が編集可能なときのみ表示（両方へ書くため）。
    expect(ownerCard).toMatch(
      /editableFields\.zip\s*&&\s*editableFields\.address/,
    );
  });

  it("addressEdited を state で持ち、編集開始（handleEdit）で false にリセットする", () => {
    expect(ownerCard).toMatch(
      /const \[addressEdited, setAddressEdited\] = useState\(false\)/,
    );
    // 編集モードに入るたびに user-edit signal をリセット（保存値ロードでは立てない）。
    expect(ownerCard).toMatch(/setAddressEdited\(false\)/);
  });

  it("user-edit signal は住所 input のユーザー編集時だけ立てる（OwnerCard 内）", () => {
    // OwnerCard 内で setAddressEdited(true) はちょうど 1 箇所（住所 input の onChange）。
    const occurrences = ownerCard.match(/setAddressEdited\(true\)/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("候補確定は zip/address をペアで form へ反映する", () => {
    expect(ownerCard).toMatch(/onZipChange=\{[\s\S]*?zip:/);
    expect(ownerCard).toMatch(/onAddressChange=\{[\s\S]*?address:/);
  });
});
