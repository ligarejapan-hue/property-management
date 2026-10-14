import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPasteDraft } from "../build-draft";
import { parseLabeledLines } from "../parse-labeled-lines";
import { splitRoomFromBuildingName, parseOptionsFor } from "../source-profiles";
import { leadRowStatus, withFallbackLinkKey } from "../lead-sheet";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

/**
 * タカウル(マンションレビュー)の査定依頼メール。実物(2026-10-07 着)の書式を写した見本。
 * ⚠見本の書式(「- 見出し：値」・空行・罫線・ご住所の2行目・運営会社の署名欄)は変えない。
 *   個人情報は架空の値。
 */
describe("buildPasteDraft — タカウル 査定依頼", () => {
  const text = fixture("takauru-assessment.txt");
  const draft = buildPasteDraft(text, { maxYear: 2026 });
  const withheldLabels = draft.withheldFromNote.map((w) => w.label);

  it("送り元を見分ける", () => {
    expect(draft.sourceProfile).toBe("takauru_assessment");
    expect(draft.sourceProfileLabel).toBe("タカウル 査定依頼");
  });

  it("物件の所在地・建物名・部屋番号(建物名の末尾の「305号室」から)", () => {
    expect(draft.property.address.value).toBe("東京都世田谷区太子堂4丁目12-3");
    expect(draft.property.address.sourceLabel).toBe("査定物件の所在地");
    expect(draft.property.buildingName.value).toBe("東急サンプルハイツ");
    expect(draft.property.roomNo.value).toBe("305");
    expect(draft.property.roomNo.sourceLabel).toBe("建物名");
  });

  it("種別・面積・間取り・築年・現況", () => {
    expect(draft.property.propertyType.value).toBe("apartment_unit");
    expect(draft.property.exclusiveArea.value).toBe("52");
    expect(draft.property.layoutType.value).toBe("2LK/2LDK");
    expect(draft.property.builtYear.value).toBe("1998");
    // 「現在の物件状況：自身が居住している」
    expect(draft.property.occupancyStatus.value).toBe("occupied");
    expect(draft.warnings.filter((w) => w.code === "value_unreadable")).toEqual([]);
  });

  it("★所有者の氏名は「ご所有者様名」(申込者=お名前 とは別の人)", () => {
    expect(draft.owner?.name.value).toBe("佐藤　太郎");
    expect(draft.owner?.name.sourceLabel).toBe("ご所有者様名");
    // フリガナは申込者のもの → 所有者の欄には入れない
    expect(draft.owner?.nameKana.value).toBeNull();
    expect(draft.warnings.map((w) => w.code)).toContain("owner_differs_from_applicant");
  });

  it("Excel の代わりの鍵の材料(applicantName)は以前と同じ「お名前」の値(@codex PR#491 6巡目)", () => {
    expect(draft.applicantName).toBe("佐藤　花子");
    expect(buildPasteDraft("物件所在地：東京都A区1\nご所有者様名：山田").applicantName).toBeNull();
  });

  it("申込者の氏名・フリガナは捨てずに「備考に入れない項目」へ", () => {
    expect(draft.withheldFromNote).toContainEqual({ label: "お名前", value: "佐藤　花子", reason: "label" });
    expect(draft.withheldFromNote).toContainEqual({ label: "フリガナ", value: "サトウ　ハナコ", reason: "label" });
    expect(draft.noteFromUnmapped).not.toContain("佐藤");
    expect(draft.noteFromUnmapped).not.toContain("ハナコ");
  });

  it("連絡先は申込者のもの。ご住所は2行目までつなぐ", () => {
    expect(draft.owner?.phone.value).toBe("09012345678");
    expect(draft.owner?.email.value).toBe("hanako@example.jp");
    expect(draft.owner?.currentAddress.value).toBe(
      "154-0004 東京都世田谷区太子堂4-12-3東急サンプルハイツ 305号室",
    );
  });

  it("査定ナンバーに当たる番号は無い", () => {
    expect(draft.externalLinkKey).toBeNull();
  });

  it("選択式の項目は物件の備考へ", () => {
    for (const line of [
      "査定物件の郵便番号: 154-0004",
      "現在の活動状況: 売却検討中",
      "物件の所有者: 親族が所有",
      "ご関係: 夫",
      "売却/賃貸の時期: 〜３ヶ月程度",
      "買い換えについて: 買い替え先はこれから探す",
      "不動産会社からのご希望連絡先: 電子メール",
      "送信日時: 2026/10/07 15:45",
      "マンションレビューを見る: https://www.mansion-review.jp/mansion/99999.html",
    ]) {
      expect(draft.noteFromUnmapped).toContain(line);
    }
  });

  it("自由記述・年齢は備考に入れず、画面に出す", () => {
    expect(withheldLabels).toContain("年齢");
    expect(withheldLabels).toContain("物件のセールスポイント・ご要望等");
    expect(withheldLabels).toContain("売却する理由");
  });

  it("運営会社の署名欄(住所・TEL・Mail)は項目として読まない(読み取れなかった行に残す)", () => {
    expect(withheldLabels).not.toContain("住 所");
    expect(withheldLabels).not.toContain("T E L");
    expect(withheldLabels).not.toContain("Mail");
    expect(draft.unlabeled.some((l) => l.includes("03-6432-0498"))).toBe(true);
    expect(draft.noteFromUnmapped).not.toContain("虎ノ門");
  });

  it("URL だけの行を「https」という見出しに割らない", () => {
    expect(withheldLabels).not.toContain("https");
    expect(draft.unmapped.map((u) => u.label)).not.toContain("https");
  });

  it("Excel 取込が足す「反響番号」(二重登録の鍵)と補いの列が読める", () => {
    const body = `${text}\nお名前：佐藤　花子`;
    const d = buildPasteDraft(withFallbackLinkKey(body, buildPasteDraft(body), "lead-abc123"), {
      maxYear: 2026,
    });
    expect(d.externalLinkKey).toBe("lead-abc123");
    expect(d.owner?.name.value).toBe("佐藤　太郎");
  });
});

describe("「物件の所有者」「ご関係」は値で判定する(見出しだけで備考へ通さない)", () => {
  it.each([
    ["物件の所有者", "山田太郎ほか2名"],
    ["ご関係", "山田花子の夫"],
  ])("%s：%s は備考へ入れない", (label, value) => {
    const d = buildPasteDraft(`- 査定物件の所在地：東京都A区B1-2-3\n- ${label}：${value}`);
    expect(d.noteFromUnmapped).not.toContain(value);
    expect(d.withheldFromNote.map((w) => w.label)).toContain(label);
  });
});

describe("タカウルの見分け方(@codex PR#491 3巡目)", () => {
  it("「査定物件の所在地」だけでは決めない(他社の文章にタカウル用の読み方を掛けない)", () => {
    const d = buildPasteDraft("査定物件の所在地：東京都A区B1-2-3\nご住所：154-0004\n説明の行");
    expect(d.sourceProfile).toBe("generic");
    expect(d.owner?.currentAddress.value).toBe("154-0004");
    expect(d.unlabeled).toContain("説明の行");
  });
});

describe("所有者と申込者が同じ人のとき", () => {
  it("警告を出さず、フリガナも所有者に入れる", () => {
    const d = buildPasteDraft(
      "- 査定物件の所在地：東京都A区B1-2-3\n- ご所有者様名：山田 太郎\n- お名前：山田　太郎\n- フリガナ：ヤマダ　タロウ",
    );
    expect(d.owner?.name.value).toBe("山田 太郎");
    expect(d.owner?.nameKana.value).toBe("ヤマダ　タロウ");
    expect(d.warnings.map((w) => w.code)).not.toContain("owner_differs_from_applicant");
    expect(d.withheldFromNote).toEqual([]);
  });

  it("ご所有者様名だけがあれば、それを所有者の氏名にする", () => {
    const d = buildPasteDraft("- 査定物件の所在地：東京都A区B1-2-3\n- ご所有者様名：山田 太郎");
    expect(d.owner?.name.value).toBe("山田 太郎");
    expect(d.warnings.map((w) => w.code)).not.toContain("owner_name_missing");
    expect(d.warnings.map((w) => w.code)).not.toContain("owner_contact_unconfirmed");
  });

  it("★ご所有者様名はあるがお名前が空で、フリガナ・連絡先だけある → 決めずに確認へ(@codex PR#491 5巡目)", () => {
    const d = buildPasteDraft(
      "- 物件種別：マンション\n- 査定物件の所在地：東京都A区B1-2-3\n- 建物（専有）面積：50m2\n- 現在の物件状況：自身が居住している\n- ご所有者様名：山田 太郎\n- お名前：\n- フリガナ：ヤマダ　ハナコ\n- 電話番号：09012345678",
    );
    expect(d.owner?.name.value).toBe("山田 太郎");
    expect(d.owner?.nameKana.value).toBeNull();
    expect(d.withheldFromNote).toContainEqual({ label: "フリガナ", value: "ヤマダ　ハナコ", reason: "label" });
    expect(d.warnings.map((w) => w.code)).toContain("owner_contact_unconfirmed");
    const none = { blocked: false, similarCount: 0, ownerCandidateCount: 0, ownerCandidatesTruncated: false };
    expect(leadRowStatus(d, none)).toEqual({
      status: "review",
      reasons: ["申込者のお名前が無く、連絡先が所有者本人のものか分かりません"],
    });
  });
});

describe("Excel まとめ取込: 人に確かめる警告がある行は自動で登録しない(@codex PR#491)", () => {
  const none = { blocked: false, similarCount: 0, ownerCandidateCount: 0, ownerCandidatesTruncated: false };

  it("所有者と申込者が別(タカウル見本)なら review", () => {
    const d = buildPasteDraft(fixture("takauru-assessment.txt"), { maxYear: 2026 });
    const r = leadRowStatus(d, none);
    expect(r.status).toBe("review");
    expect(r.reasons).toEqual(["所有者と申込者が別の方です(連絡先は申込者のもの)"]);
  });

  it("部屋番号が食い違えば review", () => {
    const d = buildPasteDraft(
      "物件所在地：東京都A区B1-2-3グリーンコート303\n建物名：グリーンコート 305号室\n物件種別：マンション\nお名前：山田太郎\n建物（専有）面積：50m2\n現況：居住中",
    );
    const r = leadRowStatus(d, none);
    expect(r.status).toBe("review");
    expect(r.reasons).toEqual(["部屋番号が所在地と建物名で食い違っています"]);
  });
});

describe("現在の物件状況の言い換え", () => {
  const occ = (v: string) => buildPasteDraft(`物件所在地：東京都A区B1-2-3\n現在の物件状況：${v}`);
  it.each([
    ["自身が居住している", "occupied"],
    // ★2026-10-14: 人に貸している=賃貸中(rented)。タカウル実物「賃貸で貸している」も
    ["賃貸している", "rented"],
    ["賃貸で貸している", "rented"],
    ["賃貸中", "rented"],
    ["所有者は居住していない（賃貸中）", "rented"],
    ["賃借人が入居中", "rented"],
    ["入居者あり", "rented"],
    ["テナント入居中", "rented"],
    ["入居者：所有者本人", "occupied"],
    ["入居者はオーナー本人", "occupied"],
    ["本人ではなく賃借人が入居中", "rented"],
    ["空室（即入居可）", "vacant"],
    ["入居者本人が居住中", "rented"],
    ["所有者の物件で賃借人が入居中", "rented"],
    ["居住中（賃借人）", "rented"],
    ["入居中：テナント", "rented"],
    ["現在入居中（賃貸）", "rented"],
    ["賃貸物件として入居中", "rented"],
    ["本人以外の入居者あり", "rented"],
    ["本人所有、賃借人が入居中", "rented"],
    ["自身・親族が居住中", "occupied"],
    ["賃借人が居住している", "rented"],
    ["借り手が入居中", "rented"],
    ["賃借者が居住中", "rented"],
    ["借り主が入居中", "rented"],
    ["店子が入居中", "rented"],
    ["所有者はいない。賃借人が入居中", "rented"],
    // 「本人所有」は持っていることの言及=住んでいる印ではない。空室だけが言われている
    ["本人所有、現在空室", "vacant"],
    ["誰も住んでいない", "vacant"],
    ["空いている", "vacant"],
  ])("%s → %s", (v, expected) => {
    expect(occ(v).property.occupancyStatus.value).toBe(expected);
  });

  it.each([
    ["自身は居住していないが、親族が居住中"],
    ["自己居住の一部を賃貸中"],
    ["賃貸中ではない"],
    ["賃貸に出していない"],
    ["貸していない"],
    ["賃貸中ではありません"],
    ["貸していません"],
    ["賃貸には出しておりません"],
    ["賃貸ではございません"],
    ["賃貸中じゃない"],
    ["賃貸中じゃありません"],
    ["賃貸には出していない"],
    ["賃貸に出しているわけではない"],
    ["賃貸に出しているわけではありません"],
    ["入居者なし"],
    ["テナント募集中"],
    ["賃借人は退去済み"],
    ["賃貸中だったが退去済み"],
    ["賃貸中・入居者なし"],
    ["以前は賃貸中、現在は空室"],
    ["入居者はいません"],
    ["テナントはおりません"],
    ["入居者未定"],
    ["入居者については確認中"],
    ["入居者を探している"],
    ["入居者がいるか確認中"],
    ["所有者以外が居住中"],
    ["オーナー以外が居住中"],
    ["自己居住ではない"],
    ["自己居住ではありません"],
    ["居住中ではない"],
    ["自己居住してません"],
    ["本人は居住してません"],
    ["本人は住んでません"],
    ["本人は居住しておらず"],
    ["本人は住まず"],
    ["賃借人が居住してない"],
    ["賃借人が居住していた"],
    ["入居者が住んでいました"],
    ["本人が居住していた"],
    ["自己居住の予定"],
    ["今後は本人が住む"],
    ["所有者が入居していました"],
    ["所有者が居住しているか確認中"],
    ["親族が居住中"],
    ["家族が入居中"],
    ["第三者が居住中"],
    ["親族が入居者として居住中"],
    ["家族のテナントが入居中"],
    ["入居者：家族が居住中"],
    ["居住者本人が居住中"],
    ["所有者の家族が居住中"],
    ["オーナーの息子が入居中"],
    ["所有者の妻が居住中"],
    ["配偶者が居住中"],
    ["入居中：テナントではありません"],
    ["賃貸中ではなかった"],
    ["賃借人以外が入居中"],
    ["入居者以外が入居中"],
    ["賃貸ではありませんでした"],
    ["居住中（賃借人ではない）"],
    ["本人が居住中、賃借人も入居中"],
    ["本人が居住している、賃貸中"],
    ["現在居住中、入居者は賃借人"],
    ["居住している"],
    ["入居している"],
    ["入居中"],
    ["本人が入居希望"],
    ["賃貸中止"],
    ["所有者に無断で第三者が入居中"],
    ["所有者の代理人が居住中"],
    ["所有者が入居者を探している"],
    ["賃借人がいるわけではない"],
    ["賃借人がいるとは限らない"],
    ["所有者が入居準備中"],
    ["所有者が入居前"],
    ["所有者は未入居"],
    ["所有者は未居住"],
    ["所有者は別住所に居住"],
    ["所有者が来月入居する"],
    ["所有者が入居を拒否した"],
    ["過去は賃貸中"],
    ["管理人が居住中"],
    ["所有者によると管理人が居住中"],
    ["管理人も居住中"],
    ["管理人が現在居住中"],
    ["居住中（管理人）"],
    ["管理人が現在この物件に居住中"],
    ["管理人居住中"],
    ["所有者が居住権を有する"],
    ["管理人が現在この対象不動産の一室に居住中"],
    ["昨年まで賃貸中"],
    ["所有者は居住歴あり"],
    ["所有者が居住可能"],
    ["本人が入居できる"],
    ["本人に入居経験あり"],
    ["所有者が居住しているとは考えられない"],
    ["本人は居住して無い"],
    ["所有者は住んで無い"],
    ["賃借人がいるとは言えません"],
    ["昔は本人が居住中"],
    ["本人が居住中、賃借人もいる"],
    ["本人が来週から居住する"],
    ["本人は実家に住んでいる"],
    ["賃借人がいる可能性があります"],
    ["本人が住んでいるかもしれない"],
    ["賃貸中断"],
    ["賃貸契約は解約済み"],
    ["本人が入居を検討中"],
    ["所有者が居住を希望"],
    ["所有者は居住していない"],
    ["自身は住んでいない"],
  ])(
    "人についての打ち消し・居住中の印との混在は決めない(読み取れない扱い): %s",
    (v) => {
      const d = occ(v);
      expect(d.property.occupancyStatus.value).toBeNull();
      expect(d.warnings.find((w) => w.code === "value_unreadable")?.field).toBe("occupancyStatus");
    },
  );
});

describe("splitRoomFromBuildingName（建物名の末尾の号室）", () => {
  it.each([
    ["東急サンプルハイツ 305号室", "東急サンプルハイツ", "305"],
    ["東急サンプルハイツ　３０５号室", "東急サンプルハイツ", "305"],
    ["グリーンコート1203号室", "グリーンコート", "1203"],
    ["グリーンコート 2-301号室", "グリーンコート", "2-301"],
  ])("%s → %s / %s", (input, name, room) => {
    expect(splitRoomFromBuildingName(input)).toEqual({ buildingName: name, roomNo: room });
  });

  it.each([["パークハウス2"], ["グリーンコート303"], ["305号室"], ["メゾン第2号"]])(
    "「号室」が無い・建物名が残らないものは切らない: %s",
    (input) => {
      expect(splitRoomFromBuildingName(input)).toEqual({ buildingName: input, roomNo: null });
    },
  );
});

describe("部屋番号の食い違い", () => {
  it("所在地の末尾と建物名の末尾で違えば所在地を採り、警告する", () => {
    const d = buildPasteDraft("物件所在地：東京都A区B1-2-3グリーンコート303\n建物名：グリーンコート 305号室");
    expect(d.property.roomNo.value).toBe("303");
    expect(d.property.buildingName.value).toBe("グリーンコート");
    expect(d.warnings.find((w) => w.code === "room_no_conflict")?.field).toBe("roomNo");
  });
});

describe("parseLabeledLines の読み方の違い", () => {
  it("既定(HOME4U など)は続き行をつながない＝従来どおり", () => {
    const r = parseLabeledLines("ご住所：154-0004\n東京都A区B1-2-3");
    expect(r.labeled[0].value).toBe("154-0004");
    expect(r.unlabeled).toEqual(["東京都A区B1-2-3"]);
  });

  it("つなぐのは「値が郵便番号だけ」の行の次の1行だけ", () => {
    const r = parseLabeledLines(
      "ご住所：〒154-0004\n東京都A区B1-2-3\n2行目\nお名前：山田太郎\n説明の行\n郵便：154-0004\n\n空行の後\n郵便：1540004\n────────",
      parseOptionsFor("takauru_assessment"),
    );
    expect(r.labeled.map((l) => l.value)).toEqual([
      "〒154-0004 東京都A区B1-2-3",
      "山田太郎",
      "154-0004",
      "1540004",
    ]);
    expect(r.unlabeled).toEqual(["2行目", "説明の行", "空行の後", "────────"]);
  });

  it("★署名欄が途中で切れて閉じる罫線が無くても、運営会社の電話を所有者に入れない・鍵は残る", () => {
    // 申込者の電話が空のセルが、署名欄の開く罫線の直後で切れている(@codex PR#491 4巡目)。
    const cut =
      "- 査定物件の郵便番号：154-0004\n- 査定物件の所在地：東京都A区B1-2-3\n- お名前：山田太郎\n━━━━━━━━\n　T E L：03-6432-0498（代表）";
    const first = buildPasteDraft(cut);
    expect(first.sourceProfile).toBe("takauru_assessment");
    expect(first.owner?.phone.value).toBeNull();
    expect(first.unlabeled.some((l) => l.includes("03-6432-0498"))).toBe(true);
    const d = buildPasteDraft(withFallbackLinkKey(cut, first, "lead-2"));
    expect(d.externalLinkKey).toBe("lead-2");
    expect(d.owner?.phone.value).toBeNull();
  });

  it("URL だけの行は、既定でも見出しに割らない", () => {
    const r = parseLabeledLines("https://example.com/a\n- http://example.com/b\n見出し：https://example.com/c");
    expect(r.labeled).toEqual([{ label: "見出し", value: "https://example.com/c", lineNumber: 3 }]);
    expect(r.unlabeled).toEqual(["https://example.com/a", "- http://example.com/b"]);
  });

  it("HOME4U の書式では、続き行・署名欄の読み方を使わない", () => {
    expect(parseOptionsFor("home4u_assessment")).toEqual({});
    expect(parseOptionsFor("home4u_vacant_house")).toEqual({});
    expect(parseOptionsFor("generic")).toEqual({});
  });
});
