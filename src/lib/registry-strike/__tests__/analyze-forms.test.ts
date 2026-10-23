import { describe, it, expect } from "vitest";
import { analyzeRegistryRights } from "../analyze";
import { kouWith, marked, otsuWith, plain } from "./helpers";

/**
 * 住所・氏名の変更/更正、所有権更正、相続、持分の移転、仮登記の本登記、抹消回復、
 * 抵当権の移転・変更の判定。
 *
 * ⚠ どれも実物の謄本ではなく、法務省「不動産登記記録例」の形に合わせた架空の表。
 *   （実物で確かめたのは「登記名義人住所変更」「根抵当権・仮登記の抹消」だけ）
 *   【…】＝下線（抹消事項）。
 */
const SEP = "┠─────┼────────────────┼───────────┼─────────────────────┨";
const SUB = "┃ ├────────────────┼───────────┼─────────────────────┨";

const row = (rank: string, purpose: string, ...details: string[]) =>
  [
    `┃${rank} │${purpose} │令和１年１月１日 │${details[0] ?? ""} ┃`,
    ...details.slice(1).map((d, i) => `┃ │ │${i === 0 ? "第１号" : ""} │${d} ┃`),
  ].join("\n");

const kou = (...rows: string[]) => analyzeRegistryRights(marked(kouWith(rows.join("\n"))));
const otsu = (...rows: string[]) => analyzeRegistryRights(marked(otsuWith(rows.join("\n"))));

const SOLE_A = row("１", "所有権移転", "原因 平成１０年１月１日売買", "所有者 世田谷区架空一丁目１番１号", " 甲 野 一 郎");
const CO_AB = row(
  "１",
  "所有権移転",
  "原因 平成１０年１月１日売買",
  "共有者 世田谷区架空一丁目１番１号",
  " 持分２分の１",
  " 甲 野 一 郎",
  " 世田谷区架空二丁目２番２号",
  " 持分２分の１",
  " 乙 山 二 郎",
);

describe("相続・持分の移転", () => {
  it("相続による所有権移転は、共有者と持分をそのまま今の所有者にする", () => {
    const r = kou(
      SOLE_A,
      SEP,
      row(
        "２",
        "所有権移転",
        "原因 令和２年１月１日相続",
        "共有者 世田谷区架空一丁目１番１号",
        " 持分３分の２",
        " 甲 野 花 子",
        " 目黒区架空三丁目３番３号",
        " 持分３分の１",
        " 甲 野 次 郎",
      ),
    );
    expect(r.currentOwners).toEqual([
      { name: "甲野花子", address: "世田谷区架空一丁目１番１号", share: "3分の2" },
      { name: "甲野次郎", address: "目黒区架空三丁目３番３号", share: "3分の1" },
    ]);
    expect(r.notes).toEqual([]);
  });

  it("所有権一部移転: 単独所有者の持分が残りの割合になる", () => {
    const r = kou(
      SOLE_A,
      SEP,
      row("２", "所有権一部移転", "原因 令和２年１月１日贈与", "共有者 港区架空四丁目４番４号", " 持分３分の１", " 丙 川 三 郎"),
    );
    expect(r.currentOwners).toEqual([
      { name: "甲野一郎", address: "世田谷区架空一丁目１番１号", share: "3分の2" },
      { name: "丙川三郎", address: "港区架空四丁目４番４号", share: "3分の1" },
    ]);
  });

  it("A持分全部移転: Aが抜け、取得者が入る", () => {
    const r = kou(
      CO_AB,
      SEP,
      row("２", "甲野一郎持分全部移転", "原因 令和２年１月１日売買", "共有者 港区架空四丁目４番４号", " 持分２分の１", " 丙 川 三 郎"),
    );
    expect(r.currentOwners).toEqual([
      { name: "乙山二郎", address: "世田谷区架空二丁目２番２号", share: "2分の1" },
      { name: "丙川三郎", address: "港区架空四丁目４番４号", share: "2分の1" },
    ]);
  });

  it("A持分一部移転: 取得者が既に共有者なら持分を足し合わせる", () => {
    const r = kou(
      CO_AB,
      SEP,
      row("２", "甲野一郎持分一部移転", "原因 令和２年１月１日売買", "共有者 世田谷区架空二丁目２番２号", " 持分４分の１", " 乙 山 二 郎"),
    );
    expect(r.currentOwners).toEqual([
      { name: "甲野一郎", address: "世田谷区架空一丁目１番１号", share: "4分の1" },
      { name: "乙山二郎", address: "世田谷区架空二丁目２番２号", share: "4分の3" },
    ]);
  });

  it("「A持分」のAが今の共有者に見当たらなければ、推測せず確認を促す", () => {
    const r = kou(
      CO_AB,
      SEP,
      row("２", "丁田四郎持分全部移転", "原因 令和２年１月１日売買", "共有者 港区架空四丁目４番４号", " 持分２分の１", " 丙 川 三 郎"),
    );
    expect(r.currentOwners).toEqual([]);
    expect(r.notes.join()).toContain("特定できません");
  });

  it("持分の合計が1にならない共有は、推測せず確認を促す", () => {
    const r = kou(
      row("１", "所有権移転", "原因 平成１０年１月１日売買", "共有者 世田谷区架空一丁目１番１号", " 持分２分の１", " 甲 野 一 郎"),
    );
    expect(r.currentOwners).toEqual([]);
    expect(r.notes.join()).toContain("合計");
  });
});

describe("住所・氏名の変更/更正", () => {
  it("単独所有者の氏名変更（付記）を反映する", () => {
    const r = kou(
      row("１", "所有権移転", "原因 平成１０年１月１日売買", "所有者 世田谷区架空一丁目１番１号", " 【甲 野 花 子】"),
      SUB,
      row("付記１号", "１番登記名義人氏名変更", "原因 令和２年１月１日氏名変更", "氏名 乙 山 花 子"),
    );
    expect(r.currentOwners).toEqual([
      { name: "乙山花子", address: "世田谷区架空一丁目１番１号", share: null },
    ]);
  });

  it("共有者の1人の住所変更（「共有者Aの住所」）を、その人にだけ反映する", () => {
    const r = kou(
      row(
        "１",
        "所有権移転",
        "原因 平成１０年１月１日売買",
        "共有者 【世田谷区架空一丁目１番１号】",
        " 持分２分の１",
        " 甲 野 一 郎",
        " 世田谷区架空二丁目２番２号",
        " 持分２分の１",
        " 乙 山 二 郎",
      ),
      SUB,
      row("付記１号", "１番登記名義人住所変更", "原因 令和２年１月１日住所移転", "共有者甲野一郎の住所 渋谷区架空五丁目５番５号"),
    );
    expect(r.currentOwners).toEqual([
      { name: "甲野一郎", address: "渋谷区架空五丁目５番５号", share: "2分の1" },
      { name: "乙山二郎", address: "世田谷区架空二丁目２番２号", share: "2分の1" },
    ]);
  });

  it("住所の更正（錯誤）も変更と同じく反映する", () => {
    const r = kou(
      row("１", "所有権移転", "原因 平成１０年１月１日売買", "所有者 【世田谷区架空一丁目１番１号】", " 甲 野 一 郎"),
      SUB,
      row("付記１号", "１番登記名義人住所更正", "原因 錯誤", "住所 世田谷区架空一丁目１１番１号"),
    );
    expect(r.currentOwners[0].address).toBe("世田谷区架空一丁目１１番１号");
  });

  it("下線の無い入力でも、変更の付記で置き換える", () => {
    const r = analyzeRegistryRights(
      plain(
        kouWith(
          [
            row("１", "所有権移転", "原因 平成１０年１月１日売買", "所有者 世田谷区架空一丁目１番１号", " 甲 野 一 郎"),
            SUB,
            row("付記１号", "１番登記名義人住所変更", "原因 令和２年１月１日住所移転", "住所 渋谷区架空五丁目５番５号"),
          ].join("\n"),
        ),
      ),
    );
    expect(r.currentOwners[0].address).toBe("渋谷区架空五丁目５番５号");
  });
});

describe("所有権更正・仮登記の本登記・抹消回復・相続人申告", () => {
  it("所有権更正の付記があれば、名義人はその付記の内容で読む", () => {
    const r = kou(
      row("１", "所有権移転", "原因 平成１０年１月１日売買", "【所有者 世田谷区架空一丁目１番１号】", " 【甲 野 一 郎】"),
      SUB,
      row(
        "付記１号",
        "１番所有権更正",
        "原因 錯誤",
        "共有者 世田谷区架空一丁目１番１号",
        " 持分２分の１",
        " 甲 野 一 郎",
        " 世田谷区架空一丁目１番１号",
        " 持分２分の１",
        " 甲 野 花 子",
      ),
    );
    expect(r.currentOwners.map((o) => [o.name, o.share])).toEqual([
      ["甲野一郎", "2分の1"],
      ["甲野花子", "2分の1"],
    ]);
  });

  it("仮登記の下の余白に本登記があれば、本登記の所有者が今の所有者。仮登記は注意に出さない", () => {
    const r = kou(
      SOLE_A,
      SEP,
      row("２", "所有権移転仮登記", "原因 令和２年１月１日売買", "権利者 港区架空四丁目４番４号", " 丙 川 三 郎"),
      SUB,
      row("", "所有権移転", "原因 令和２年１月１日売買", "所有者 港区架空四丁目４番４号", " 丙 川 三 郎"),
    );
    expect(r.currentOwners).toEqual([{ name: "丙川三郎", address: "港区架空四丁目４番４号", share: null }]);
    expect(r.cautions).toEqual([]);
  });

  it("本登記の無い仮登記は注意に出し、所有者は変えない", () => {
    const r = kou(
      SOLE_A,
      SEP,
      row("２", "所有権移転請求権仮登記", "原因 令和２年１月１日売買予約", "権利者 港区架空四丁目４番４号", " 丙 川 三 郎"),
      SUB,
      row("", "余白", ""),
    );
    expect(r.currentOwners.map((o) => o.name)).toEqual(["甲野一郎"]);
    expect(r.cautions).toEqual([{ section: "甲区", rank: "2", purpose: "所有権移転請求権仮登記" }]);
  });

  it("抹消回復の登記があれば、所有者は推測せず確認を促す", () => {
    const r = kou(SOLE_A, SEP, row("２", "１番所有権回復", "原因 錯誤"));
    expect(r.currentOwners).toEqual([]);
    expect(r.notes.join()).toContain("抹消回復");
  });

  it("相続人申告は所有者を変えず、注記だけ出す", () => {
    const r = kou(
      SOLE_A,
      SUB,
      row("付記１号", "１番所有権登記名義人相続人申告", "原因 令和６年４月１日申出", "相続人 港区架空四丁目４番４号", " 甲 野 次 郎"),
    );
    expect(r.currentOwners.map((o) => o.name)).toEqual(["甲野一郎"]);
    expect(r.notes.join()).toContain("相続人申告");
  });
});

describe("乙区: 抵当権の移転・変更", () => {
  const MORTGAGE = row(
    "１",
    "抵当権設定",
    "原因 令和１年１月１日金銭消費貸借同日設定",
    "債権額 【金３，０００万円】",
    "債務者 世田谷区架空一丁目１番１号",
    " 甲 野 一 郎",
    "抵当権者 千代田区架空一丁目１番１号",
    " 【株 式 会 社 架 空 銀 行】",
    " 【（取扱店 本店）】",
  );

  it("代位弁済による抵当権移転は、移転後の抵当権者にする", () => {
    const r = otsu(
      MORTGAGE,
      SUB,
      row("付記１号", "１番抵当権移転", "原因 令和３年１月１日代位弁済", "抵当権者 港区架空六丁目１番１号", " 架空保証株式会社"),
      SUB,
      row("付記２号", "１番抵当権変更", "原因 令和３年１月１日一部弁済", "債権額 金２，０００万円"),
    );
    expect(r.activeRights).toEqual([
      {
        rank: "1",
        purpose: "抵当権設定",
        amount: "金２，０００万円",
        holder: "架空保証株式会社",
        debtor: "甲野一郎",
        activeAnnotations: 2,
      },
    ]);
  });

  it("抵当権一部移転は、元の抵当権者と取得者の両方を出す", () => {
    const r = analyzeRegistryRights(
      plain(
        otsuWith(
          [
            MORTGAGE,
            SUB,
            row("付記１号", "１番抵当権一部移転", "原因 令和３年１月１日一部代位弁済", "弁済額 金５００万円", "抵当権者 港区架空六丁目１番１号", " 架空保証株式会社"),
          ].join("\n"),
        ),
      ),
    );
    expect(r.activeRights[0].holder).toBe("株式会社架空銀行、架空保証株式会社");
  });

  it("根抵当権の極度額変更・債務者変更を反映する", () => {
    const r = otsu(
      row(
        "１",
        "根抵当権設定",
        "原因 令和１年１月１日設定",
        "極度額 【金１，０００万円】",
        "債権の範囲 銀行取引",
        "債務者 【世田谷区架空一丁目１番１号】",
        " 【甲 野 一 郎】",
        "根抵当権者 千代田区架空一丁目１番１号",
        " 株 式 会 社 架 空 銀 行",
      ),
      SUB,
      row("付記１号", "１番根抵当権変更", "原因 令和３年１月１日変更", "極度額 金２，０００万円"),
      SUB,
      row("付記２号", "１番根抵当権変更", "原因 令和４年１月１日相続", "債務者 世田谷区架空一丁目１番１号", " 甲 野 花 子"),
    );
    expect(r.activeRights[0]).toMatchObject({
      amount: "金２，０００万円",
      debtor: "甲野花子",
      holder: "株式会社架空銀行",
    });
  });

  it("読み取り対象外の付記は、目視確認を促す", () => {
    const r = otsu(MORTGAGE, SUB, row("付記１号", "１番抵当権転抵当", "原因 令和３年１月１日金銭消費貸借同日設定"));
    expect(r.notes.join()).toContain("転抵当");
  });
});

describe("レビュー指摘（PR #558 Codex）", () => {
  it("「順位N番の登記を移記」は所有者欄の続きではない（氏名と取り違えない）", () => {
    const r = kou(
      row("１", "所有権移転", "原因 平成３年４月１１日相続", "所有者 杉並区架空一丁目１番１号", " 甲 野 一 郎", "順位４番の登記を移記"),
      SEP,
      row("", "", "昭和６３年法務省令第３７号附則第２条第２項", "の規定により移記"),
    );
    expect(r.currentOwners).toEqual([{ name: "甲野一郎", address: "杉並区架空一丁目１番１号", share: null }]);
    expect(r.notes).toEqual([]);
  });

  it("1つの抹消登記で複数の順位を抹消したら、すべて抹消扱い（下線の無い入力でも）", () => {
    const m = (rank: string) =>
      row(rank, "抵当権設定", "原因 令和１年１月１日設定", "債権額 金１，０００万円", "抵当権者 千代田区架空一丁目１番１号", " 株 式 会 社 架 空 銀 行");
    const r = analyzeRegistryRights(
      plain(otsuWith([m("１"), SEP, m("２"), SEP, m("３"), SEP, row("４", "１番、２番抵当権抹消", "原因 令和５年１月１日弁済")].join("\n"))),
    );
    expect(r.activeRights.map((x) => x.rank)).toEqual(["3"]);
    expect(r.cancelled.otsuku).toBe(2);
  });

  it("権利者の名称変更の付記は、権利者名を変更後にする（古い名称に下線があっても住所と取り違えない）", () => {
    const r = otsu(
      row(
        "１",
        "抵当権設定",
        "原因 令和１年１月１日設定",
        "債権額 金１，０００万円",
        "債務者 世田谷区架空一丁目１番１号",
        " 甲 野 一 郎",
        "抵当権者 千代田区架空一丁目１番１号",
        " 【株 式 会 社 旧 架 空 銀 行】",
      ),
      SUB,
      row("付記１号", "１番登記名義人名称変更", "原因 令和３年１月１日名称変更", "名称 株式会社新架空銀行"),
    );
    expect(r.activeRights[0].holder).toBe("株式会社新架空銀行");
    expect(r.notes).toEqual([]);
  });

  it("表示していない項目だけの変更（利息以外で読めないもの）は、反映済みと言わずに確認を促す", () => {
    const r = otsu(
      row("１", "抵当権設定", "原因 令和１年１月１日設定", "債権額 金１，０００万円", "抵当権者 千代田区架空一丁目１番１号", " 株 式 会 社 架 空 銀 行"),
      SUB,
      row("付記１号", "１番抵当権変更", "原因 令和３年１月１日変更", "特約 譲渡記載"),
    );
    expect(r.notes.join()).toContain("１番抵当権変更".replace("１", "1"));
  });
});
