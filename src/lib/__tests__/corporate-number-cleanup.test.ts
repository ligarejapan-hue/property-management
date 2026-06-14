import { describe, it, expect } from "vitest";
import { decideOwnerCorporateCleanup } from "../corporate-number-cleanup";

const N = "1234567890123";
const M = "9876543210987";

describe("decideOwnerCorporateCleanup", () => {
  it("検出なし → action none", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
    expect(p.changedFields).toEqual([]);
  });

  it("列空・name に1候補 → cleanup・列へ移送・name除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("save");
    expect(p.corporateNumberToSet).toBe(N);
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name", "corporateNumber"]);
  });

  it("列=候補と同一・text にも混入 → cleanup・移送なし・text除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: N });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("noop");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("列=別番号・text に別番号混入(conflict)→ cleanup・移送なし・検出番号のみ除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: M });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("conflict");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("複数番号検出 → manual(multi)・変更なし", () => {
    const p = decideOwnerCorporateCleanup({ name: `${N} ${M}`, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("multi");
    expect(p.changedFields).toEqual([]);
  });

  it("空化ガード: name が番号のみ → manual(name_would_be_empty)・変更なし", () => {
    const p = decideOwnerCorporateCleanup({ name: N, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("name_would_be_empty");
    expect(p.changedFields).toEqual([]);
  });

  it("address に混入 → address除去・空になれば null 化", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: N, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.cleanedAddress).toBeNull();
    expect(p.corporateNumberToSet).toBe(N);
    expect(p.changedFields).toEqual(["address", "corporateNumber"]);
  });

  it("raw-visible でないフィールドは呼び出し側で null を渡す前提(全フィールド null → none)", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
  });

  it("idempotency: cleanup済(name清浄＋列に番号)を再投入 → action none・changedFields空(二重更新しない)", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: N });
    expect(p.action).toBe("none");
    expect(p.changedFields).toEqual([]);
    expect(p.corporateNumberToSet).toBeNull();
  });

  it("除去対象を含まないフィールド(空白のみ差分)は changedFields に含めない(Codex P2: 無関係改変防止)", () => {
    // name に番号、address は全角スペースのみ(番号なし)→ address は変更しない
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: "東京都　港区", note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.changedFields).toContain("name");
    expect(p.changedFields).toContain("corporateNumber");
    expect(p.changedFields).not.toContain("address");
    expect(p.cleanedAddress).toBe("東京都　港区");
  });

  it("save候補でも text除去が起きないハイフン連結IDは列に保存しない(action none・Codex P2 round4)", () => {
    // 検出器は "整理番号 1234567890123-45" の先頭13桁を save 候補にするが、
    // 厳格 cleanup remover は除去しない → text無変更のまま列へ誤保存しない。
    const p = decideOwnerCorporateCleanup({ name: "整理番号 1234567890123-45", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.changedFields).toEqual([]);
  });

  it("全角ハイフン連結ID save候補も列に保存しない(Codex P2 round4)", () => {
    const p = decideOwnerCorporateCleanup({ name: "整理番号 1234567890123－45", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
    expect(p.corporateNumberToSet).toBeNull();
  });

  it("空文字フィールドの null 正規化を『除去』と誤判定しない(hyphen ID + address='' → action none・Codex P2 round5)", () => {
    // address='' は emptyToNull で null になるが、番号は1件も除去していない。
    // これを「除去あり」と誤判定して save すると数字断片を誤保存し address も書き換える。
    const p = decideOwnerCorporateCleanup({ name: "整理番号 1234567890123-45", address: "", note: null, corporateNumber: null });
    expect(p.action).toBe("none");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.changedFields).toEqual([]);
  });

  it("ラベルなし全角bare 13桁が cleanup で到達可能(検出→save→除去・Codex round5 scope拡張)", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○ １２３４５６７８９０１２３", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("save");
    expect(p.corporateNumberToSet).toBe("1234567890123");
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name", "corporateNumber"]);
  });

  // ─── 会社法人等番号(12桁)混入除去(除去のみ・列移送なし・13桁非干渉) ───
  describe("会社法人等番号(12桁)混入除去", () => {
    const REG = "020001012345";

    it("address にラベル付き12桁混入のみ → cleanup・address除去・列移送なし(corporateNumberToSet null)", () => {
      const p = decideOwnerCorporateCleanup({
        name: "株式会社○○",
        address: `東京都港区1-1 会社法人等番号 0200-01-012345`,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("cleanup");
      expect(p.importAction).toBe("none"); // 13桁は無いので import 判定は none
      expect(p.corporateNumberToSet).toBeNull(); // 12桁は列へ移送しない
      expect(p.cleanedAddress).toBe("東京都港区1-1");
      expect(p.changedFields).toEqual(["address"]);
    });

    it("全角ラベル・全角数字・全角ハイフンの12桁も除去", () => {
      const p = decideOwnerCorporateCleanup({
        name: "株式会社○○",
        address: `東京都港区1-1 会社法人等番号 ０２００−０１−０１２３４５`,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("cleanup");
      expect(p.cleanedAddress).toBe("東京都港区1-1");
      expect(p.corporateNumberToSet).toBeNull();
      expect(p.changedFields).toEqual(["address"]);
    });

    it("ラベルなし裸12桁は誤検出/除去しない(action none・無関係改変なし)", () => {
      const p = decideOwnerCorporateCleanup({
        name: "整理番号 020001012345",
        address: "東京都港区1-1 020001012345",
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("none");
      expect(p.changedFields).toEqual([]);
    });

    it("13桁(name)+ 12桁(address)同時 → 両方除去・13桁は列移送・12桁は除去のみ", () => {
      const p = decideOwnerCorporateCleanup({
        name: `株式会社○○ ${N}`,
        address: `東京都港区1-1 会社法人等番号 ${REG}`,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("cleanup");
      expect(p.importAction).toBe("save");
      expect(p.corporateNumberToSet).toBe(N); // 13桁のみ列へ
      expect(p.cleanedName).toBe("株式会社○○");
      expect(p.cleanedAddress).toBe("東京都港区1-1");
      expect(p.changedFields).toContain("name");
      expect(p.changedFields).toContain("address");
      expect(p.changedFields).toContain("corporateNumber");
    });

    it("12桁検出は detectedIn に該当フィールドを含める", () => {
      const p = decideOwnerCorporateCleanup({
        name: "株式会社○○",
        address: `会社法人等番号 ${REG} 東京都`,
        note: null,
        corporateNumber: null,
      });
      expect(p.detectedIn).toContain("address");
    });

    it("除去で address が空になれば null 化", () => {
      const p = decideOwnerCorporateCleanup({
        name: "株式会社○○",
        address: `会社法人等番号 ${REG}`,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("cleanup");
      expect(p.cleanedAddress).toBeNull();
      expect(p.changedFields).toEqual(["address"]);
    });

    it("空化ガード: name が「ラベル+12桁」のみ → manual(name_would_be_empty)", () => {
      const p = decideOwnerCorporateCleanup({
        name: `会社法人等番号 ${REG}`,
        address: null,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("manual");
      expect(p.manualReason).toBe("name_would_be_empty");
      expect(p.changedFields).toEqual([]);
    });

    it("idempotency: 12桁除去済みを再投入 → action none", () => {
      const p = decideOwnerCorporateCleanup({
        name: "株式会社○○",
        address: "東京都港区1-1",
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("none");
      expect(p.changedFields).toEqual([]);
    });

    it("13桁の multi 判定は 12桁混入が併存しても従来どおり manual(multi)", () => {
      const p = decideOwnerCorporateCleanup({
        name: `${N} ${M}`,
        address: `会社法人等番号 ${REG}`,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("manual");
      expect(p.manualReason).toBe("multi");
      expect(p.changedFields).toEqual([]);
    });

    it("13桁誤検出save候補(ハイフン連結ID=列移送なし) + 別フィールド12桁 → cleanup・corporateNumberToSet null・12桁除去のみ(Codex P2)", () => {
      // name のハイフン連結ID は save 候補(importAction=save)だが厳格 remover は除去しない
      // (corporate13Removed=false → corporateNumberToSet=null)。一方 address の12桁は除去される。
      // この場合 changedFields は ["address"] のみ(corporateNumber は含まれない)。
      const p = decideOwnerCorporateCleanup({
        name: "整理番号 1234567890123-45",
        address: `東京都港区1-1 会社法人等番号 ${REG}`,
        note: null,
        corporateNumber: null,
      });
      expect(p.action).toBe("cleanup");
      expect(p.importAction).toBe("save"); // 13桁は save 候補のまま
      expect(p.corporateNumberToSet).toBeNull(); // ただし 13桁は除去できないので列移送なし
      expect(p.cleanedName).toBe("整理番号 1234567890123-45"); // name は不変
      expect(p.cleanedAddress).toBe("東京都港区1-1"); // 12桁のみ除去
      expect(p.changedFields).toEqual(["address"]);
      expect(p.changedFields).not.toContain("corporateNumber");
    });
  });
});
