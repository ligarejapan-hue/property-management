/**
 * 所有者カードの「現住所／登記上住所」2段化の配線を固定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §3
 *
 * ⚠vitest は env=node（jsdom 無し）なので、クリックや state 遷移は実行できない。
 * ここではソースの文字列で**配線**を固定する（この方式はこのリポの既存の慣例）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PAGE = path.join(
  process.cwd(),
  "src/app/(dashboard)/properties/[id]/page.tsx",
);
const src = fs.readFileSync(PAGE, "utf-8");

describe("所有者カード — 現住所の2段化", () => {
  it("ホバーの説明文が発注者指定のとおり", () => {
    expect(src).toContain(
      "登記上の住所と現在の所在が違う場合はクリックしてください",
    );
  });

  it("⚠既に現住所が入っている所有者は最初から分けて開く（空で保存して消さない）", () => {
    // 1段で開くと、フォームの現住所が空のまま保存され登録済みの値を消す。
    const initializations = src.match(
      /setAddressSplit\(\s*\(po\.owner\.currentAddress \?\? ""\)\.trim\(\) !== "",?\s*\)/g,
    );
    const useStateInit = src.match(
      /useState\(\s*\(po\.owner\.currentAddress \?\? ""\)\.trim\(\) !== "",?\s*\)/g,
    );
    // 初期化(useState) と 編集を開き直したとき(handleEdit) の2箇所が要る。
    expect((initializations?.length ?? 0) + (useStateInit?.length ?? 0)).toBe(2);
  });

  it("⚠分けるボタンは住所と郵便番号を**ペアで**コピーして開始する", () => {
    // 郵便番号をコピーしないと、住所を直さずに保存した時点で
    // 「宛先は変わっていないのに郵便番号だけ消える」状態になる。
    expect(src).toMatch(/currentAddress:\s*f\.address/);
    expect(src).toMatch(/currentZip:\s*f\.zip/);
  });

  it("⚠現住所を編集したら現住所の郵便番号を空にする", () => {
    // 前の住所に対応した番号を残すと、宛先の解決がズレたペアを採用する。
    expect(src).toMatch(/currentAddress:\s*e\.target\.value,[\s\S]{0,400}?currentZip:\s*""/);
  });

  it("⚠登記上の欄は読み取り専用（郵便番号APIの表記で登記の記載を書き換えない）", () => {
    // 分けているときに出る「登記上住所」「郵便番号（登記上）」は readOnly。
    expect(src).toContain("登記上住所");
    expect(src).toContain("郵便番号（登記上）");
    expect((src.match(/readOnly/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("郵便番号が空のときは注意を出す（保存は妨げない）", () => {
    expect(src).toContain("現住所の郵便番号が空です");
  });

  it("閲覧時は現住所があればそれを主に出し、登記上住所も併記する", () => {
    expect(src).toMatch(/OwnerField label="現住所" value=\{po\.owner\.currentAddress\}/);
    expect(src).toMatch(/OwnerField label="登記上住所" value=\{po\.owner\.address\}/);
  });
});
