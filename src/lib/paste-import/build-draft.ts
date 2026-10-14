/**
 * 段2〜4を通して下書きを組み立てる。純関数。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */
import { parseLabeledLines, isBlankValue, type LabeledLine } from "./parse-labeled-lines";
import {
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
  normalizeExternalLinkKey,
  type YearBoundOptions,
} from "./normalize";
import { fieldKeyForLabel, type DraftFieldKey } from "./label-dictionary";
import { propertyTypeForRaw } from "./property-type-dictionary";
import {
  detectSourceProfile,
  parseOptionsFor,
  splitBuildingAndRoom,
  splitRoomFromBuildingName,
  SOURCE_PROFILE_LABELS,
} from "./source-profiles";
import { judgeOwnerPersonalInfo } from "./owner-personal-info";
import type { DraftField, DraftWarning, PasteDraft } from "./types";

const EMPTY: DraftField = { value: null, sourceLabel: null };
const field = (value: string | null, sourceLabel: string): DraftField =>
  value === null ? EMPTY : { value, sourceLabel };

/**
 * 賃貸の打ち消し。「賃貸／貸」のあと、句読点をはさまず16字以内に打ち消し(ない・なく・ません)が
 * 来れば打ち消しとみなす(空白を除いた文字列に当てる)。言い回しを1つずつ並べると漏れるため
 * (「ではない」「じゃない」「ではありません」「しておりません」「出しているわけではない」…・
 * @codex PR#512 2〜4巡目)、形で捉える。現況の1項目は短いので、16字の幅で別の文の打ち消しを拾うことはまず無い。
 * ⚠迷ったら「決めない」側に倒れる(誤って賃貸中にしない)。
 */
const RENTAL_NEGATION = /(賃貸|貸)[^。．、，,.]{0,16}?(ない|なく|ません)/;

/** 「自己居住ではない」「居住中ではありません」など、居住の印の打ち消し(16巡目)。 */
//   住む・居住・入居のあと8字以内の打ち消し(「居住してません」「住んでません」「住んでない」)も同じ(17巡目)。
const OCCUPIED_NEGATION =
  /(自己居住|居住中|入居中)(では|で|じゃ)?(な|無|ありません|ございません)|(居住|住ん|住ま|入居)[^、。,，．]{0,8}?(ない|なく|ません|おらず|せず|ず[、。,，．]|ず$)/;

/** 「本人ではない」「所有者以外」など、住んでいるのが本人でないと言っている(15巡目)。 */
const NOT_OWNER = /(本人|オーナー|所有者|自身)((では|で|じゃ)?(な|無)|以外)/;

/** 借り手の語のすぐ後ろ(句読点をはさまず8字以内)に、いない・募集・退去などの不在の印がある。 */
const TENANT_ABSENT =
  /(賃借人|借主|入居者|テナント|借家人)[^、。,，．]{0,8}?(なし|無し|いない|いません|おりません|おらず|募集|退去|空き|不在)/;

/** 借り手の語のすぐ後ろ(句読点をはさまず6字以内)に、住んでいる印がある。 */
const TENANT_PRESENT =
  /(賃借人|借主|入居者|テナント|借家人)[^、。,，．]{0,6}?(入居中|居住中|住んで|入居して|居住して|あり|有り|がいる|はいる|がいます|がおります)/;

/** 現況の言い換え → OccupancyStatus。分からなければ null（unknown を推測で入れない）。 */
function occupancyFor(raw: string): string | null {
  const s = raw.replace(/[\s　]/g, "");
  const has = (words: string[]) => words.some((w) => s.includes(w));
  // 打ち消し(「居住していない」)は「居住して」より先に見る(逆に当たるため)。
  // ⚠空室とみなすのは**物件全体**について言っているときだけ(@codex PR#491 3巡目)。
  //   `所有者は居住していない` は、賃借人や家族が住んでいるかもしれない＝決めない。
  const nobodyLiving = has(["誰も住んでいない", "誰も居住していない", "空いている"]);
  const someoneNotLiving = has(["住んでいない", "居住していない"]) || OCCUPIED_NEGATION.test(s);
  // ⚠2026-10-14 発注者指示: 「居住中(本人が住んでいる)」と「賃貸中(人に貸している)」を分ける。
  //   タカウル「現在の物件状況：賃貸で貸している」(実物)も賃貸中。
  // 借りている人(賃借人・入居者・借主・テナント)が住んでいる=賃貸中(@codex PR#512 7巡目)。
  //   ⚠「入居者なし」「テナント募集中」「賃借人は退去済み」は住んでいない側=賃貸中と読まない(8巡目)。
  //   ⚠借り手の不在は**借り手の語のすぐ後ろ**だけを見る(「所有者はいない。賃借人が入居中」=賃貸中・18巡目)。
  const tenantAbsent = TENANT_ABSENT.test(s);
  // ⚠「入居者：所有者本人」「入居者はオーナー本人」は本人の居住=借り手の語として数えない(10巡目)。
  //   「本人ではなく賃借人が入居中」「本人以外」のような本人の打ち消しは本人の居住と数えない(11巡目)。
  //   ⚠「本人所有」のような**持っている**ことの言及は本人の居住ではない=住んでいる語と結びつくときだけ(13巡目)。
  const ownerSelf =
    !OCCUPIED_NEGATION.test(s) &&
    (has(["自己居住"]) ||
      /(本人|自身|オーナー|所有者)[^、。,，．]{0,8}(居住|住ん|入居)/.test(s) ||
      /(入居者|居住者)[^、。,，．]{0,6}(所有者|オーナー)/.test(s)) &&
    // ⚠「入居者本人」「賃借人本人」の本人は借り手のこと=所有者の居住ではない(24巡目)。
    !/(入居者|居住者|賃借人|借主|テナント|借家人)本人/.test(s) &&
    !NOT_OWNER.test(s);
  //   ⚠借り手の語は**住んでいる印**(入居中・居住中・住んでいる・あり・いる)と一緒のときだけ数える
  //   (「入居者未定」「入居者については確認中」は決めない・13巡目)。
  //   ⚠住んでいる印は**借り手の語のすぐ後ろ**だけを見る。「入居者を探している」「入居者がいるか確認中」の
  //   ような探している・確かめている言い回しは数えない(14巡目)。
  //   ⚠親族・家族などが住んでいる言い方は借り手と決めない(「親族が入居者として居住中」・23巡目)。
  const familyWord = has(["親族", "家族", "第三者", "知人", "親戚", "息子", "娘", "両親", "子供", "子ども", "従業員", "社宅", "他人"]);
  const tenantMarker =
    !familyWord &&
    !tenantAbsent &&
    !ownerSelf &&
    TENANT_PRESENT.test(s) &&
    // 打ち消し(「居住してない」)・過去(「居住していた」「入居していた」)は今住んでいる印にしない(19巡目)。
    !OCCUPIED_NEGATION.test(s) &&
    !has(["ていた", "でいた", "だった", "ていました", "でいました"]) &&
    !has(["探し", "確認中", "未定", "かどうか", "いるか", "あるか"]);
  const explicitRental = has(["賃貸中", "賃貸している", "貸している", "賃貸に出している"]);
  const rentedMarker = tenantMarker || explicitRental;
  // ⚠賃貸の打ち消し(「賃貸中ではない」「貸していない」)は賃貸中と読まない=決めない(@codex PR#512)。
  //   ていねいな打ち消し(「賃貸中ではありません」「貸していません」)も同じ(@codex PR#512 2巡目)。
  if (RENTAL_NEGATION.test(s)) return null;
  // ⚠今ではないこと(過去・予定)や、まだ分からないこと(確認中・未定)を言っているなら、
  //   誰についてでも決めない(20巡目)。「本人が居住していた」「自己居住の予定」「居住しているか確認中」など。
  if (
    has(["ていた", "でいた", "だった", "ていました", "でいました", "予定", "以前", "かつて", "元は", "今後", "将来"]) ||
    has(["確認中", "未定", "かどうか", "いるか", "あるか", "不明"])
  ) {
    return null;
  }
  const occupiedMarker = has(["居住中", "入居中", "自己居住"]) && !OCCUPIED_NEGATION.test(s);
  // ⚠打ち消しと居住中の印が**両方**あれば決めない(@codex PR#491 2巡目)。
  if (nobodyLiving) return occupiedMarker || rentedMarker ? null : "vacant";
  // ⚠住んでいる側の語(賃貸・借り手・本人・居住中)と、空き・退去・以前の語が**両方**あれば決めない
  //   (「賃貸中だったが退去済み」「以前は賃貸中、現在は空室」「本人所有、現在空室」・9/12巡目)。
  //   ⚠「いない」は含めない(「所有者は居住していない（賃貸中）」=賃貸中を壊さない)。
  const vacancyWord = has(["空室", "空家", "空き家", "以前", "だった", "退去", "募集", "なし", "無し", "不在", "いません", "おりません"]);
  if (
    vacancyWord &&
    (ownerSelf || occupiedMarker || has(["賃貸", "貸して", "賃借人", "借主", "入居者", "テナント", "借家人"]))
  ) {
    return null;
  }
  // 借りている人が「入居中」なら賃貸中(本人の居住を言う語は tenantMarker の時点で外してある)。
  if (tenantMarker) return "rented";
  // 本人でない人が住んでいる(家族か借り手か分からない)=賃貸の語が無ければ決めない(15巡目)。
  if (NOT_OWNER.test(s) && !explicitRental) return null;
  //   本人以外の人(親族・家族・第三者・知人など)が住んでいると言っているときも同じ(21巡目)。
  //   ⚠本人も一緒に住んでいる(「自身・親族が居住中」)なら居住中のまま=下の本人の判定へ。
  if (
    !explicitRental &&
    !ownerSelf &&
    familyWord
  ) {
    return null;
  }
  // 本人の居住を言っていて賃貸の語が無ければ居住中(「入居者：所有者本人」)。
  if (ownerSelf && !explicitRental && !someoneNotLiving) return "occupied";
  // 「居住者本人が居住中」のように、住んでいる人が所有者か借り手か書かれていなければ決めない(24巡目)。
  if (/(入居者|居住者|賃借人|借主|テナント|借家人)本人/.test(s) && !explicitRental) return null;
  // `所有者は居住していない（賃貸中）` = 本人は住まず人に貸している=賃貸中(10/14 から決められる)。
  if (rentedMarker) return occupiedMarker ? null : "rented";
  if (someoneNotLiving) return null;
  if (occupiedMarker) return "occupied";
  // タカウル「現在の物件状況：自身が居住している」(実物 2026-10-07)。
  if (has(["居住している", "入居している"])) return "occupied";
  if (has(["空室", "空家", "空き家"])) return "vacant";
  return null;
}


/**
 * ⚠**時計を読むのは API 層（境界）だけ**。ここは上限を引数で受け取るだけで、
 *   同じ入力には同じ結果を返す（テストは固定値を渡す）。
 */
export function buildPasteDraft(text: string, options?: YearBoundOptions): PasteDraft {
  // 送り元は見出しの顔ぶれで決まるので、まず共通の読み方で割ってから見分け、
  // 送り元に固有の読み方があれば読み直す(HOME4U の2書式は読み直さない＝従来どおり)。
  const firstPass = parseLabeledLines(text);
  const sourceProfile = detectSourceProfile(firstPass.labeled.map((l) => l.label));
  const parseOptions = parseOptionsFor(sourceProfile);
  const { labeled, unlabeled } =
    Object.keys(parseOptions).length === 0 ? firstPass : parseLabeledLines(text, parseOptions);
  const warnings: DraftWarning[] = [];

  // 見出しごとの最初の値だけを採る（同じ見出しが2回出たら先勝ち）。
  const picked = new Map<DraftFieldKey, LabeledLine>();
  const unmapped: { label: string; value: string }[] = [];
  const withheldFromNote: PasteDraft["withheldFromNote"] = [];
  const unreadable: PasteDraft["unreadable"] = [];

  for (const line of labeled) {
    if (isBlankValue(line.value)) continue; // 値なしは拾わない
    let key = fieldKeyForLabel(line.label);
    // ⚠メール欄の「メールアドレスを持っていない」のような**「@」の無い値は
    //   メールアドレスとして扱わない**(実物の HOME4U で22件・@codex PR#456 11巡目で判明)。
    //   欄に入れると登録で形式エラーになる。捨てずに、辞書に無い見出しと同じ扱い
    //   (見出しが「メール」なので下で所有者の個人情報として備考から外され、人に見せる)。
    if (key === "ownerEmail" && !line.value.includes("@")) key = null;
    if (key === null) {
      // ⚠所有者の個人情報にあたる見出しは**備考へ入れない**(@codex PR#414 11巡目 ①)。
      //   Property.note は所有者の項目別マスクを通らずに表示されるため、
      //   ここへ流すと項目別権限チェックの迂回路になる。捨てはせず、
      //   確認画面に出して人が適切な欄へ移せるようにする。
      const verdict = judgeOwnerPersonalInfo(line.label, line.value);
      if (verdict.isOwnerPersonalInfo && verdict.reason !== null) {
        withheldFromNote.push({
          label: line.label,
          value: line.value,
          reason: verdict.reason,
        });
        continue;
      }
      unmapped.push({ label: line.label, value: line.value });
      continue;
    }
    if (!picked.has(key)) picked.set(key, line);
  }

  // 見出しが1つも読み取れなかったときは、その1件だけを警告する。
  // 「そもそも何も読み取れていない」のに「住所が無い」「地番が無い」まで
  // 並ぶと利用者が誤解するため（address_missing / lot_number_missing を抑制）。
  const noLabeledLines = labeled.length === 0;
  if (noLabeledLines) {
    warnings.push({
      code: "no_labeled_lines",
      message:
        "読み取れる項目がありませんでした。「項目名：値」の形で書かれた文章を貼り付けてください。",
    });
  }

  const raw = (key: DraftFieldKey): string | null => picked.get(key)?.value ?? null;
  const label = (key: DraftFieldKey): string => picked.get(key)?.label ?? "";

  // ---- 住所・地番・建物名・部屋番号 ----
  const addressRaw = raw("address");
  // 建物名の末尾の「305号室」は部屋番号の欄へ(タカウル `建物名：東急◯◯ 305号室`)。
  const buildingNameRaw = raw("buildingName");
  const fromName =
    buildingNameRaw === null ? null : splitRoomFromBuildingName(buildingNameRaw);
  const buildingName = fromName?.buildingName ?? null;
  let address: string | null = null;
  let lotNumber: string | null = raw("lotNumber");
  let roomNo: string | null = null;

  if (addressRaw !== null) {
    const split = splitLotNumberFromAddress(addressRaw);
    address = split.address;
    if (lotNumber === null) lotNumber = split.lotNumber;
    const room = splitBuildingAndRoom(address, buildingName);
    address = room.address;
    roomNo = room.roomNo;
  }
  // 所在地から取れた部屋番号を優先する(従来どおり)。取れなければ建物名から。
  let roomNoLabel = label("address");
  if (roomNo === null && fromName?.roomNo) {
    roomNo = fromName.roomNo;
    roomNoLabel = label("buildingName");
  } else if (roomNo !== null && fromName?.roomNo && fromName.roomNo !== roomNo) {
    warnings.push({
      code: "room_no_conflict",
      field: "roomNo",
      message: `部屋番号が所在地（${roomNo}）と建物名（${fromName.roomNo}）で食い違っています。ご確認ください。`,
    });
  }

  if (address === null && !noLabeledLines) {
    warnings.push({
      code: "address_missing",
      message: "住所を読み取れませんでした。手で入力してください。",
    });
  }
  if (lotNumber === null && !noLabeledLines) {
    warnings.push({
      code: "lot_number_missing",
      message:
        "地番がありません。このままでは謄本を取得できません。地番検索サービスで調べて入力してください。",
    });
  }

  // ---- 物件種別 ----
  const typeRaw = raw("propertyTypeRaw");
  const mappedType = typeRaw === null ? null : propertyTypeForRaw(typeRaw);
  if (mappedType !== null && !mappedType.confident) {
    warnings.push({
      code: "property_type_unknown",
      field: "propertyType",
      message: `物件種別「${typeRaw}」を判別できませんでした。選び直してください。`,
    });
  }

  // ---- 所有者 ----
  // ⚠**氏名が無いだけで丸ごと捨てない**(@codex PR#414 21巡目 ①)。
  //   連絡先(電話・メール・現住所)やカナが読み取れているのに owner を null に
  //   すると、それらの行は unmapped からも除かれているため
  //   **確認画面のどこにも出ないまま、登録時に黙って消える**。
  //   「黙って捨てるのが一番悪い」。読み取れた値を入れた owner を返し、
  //   氏名が空であることを警告で伝える。画面側は R9 のガード
  //   (新規所有者モードで氏名が空なら登録を止める)がそのまま効くので、
  //   値は事前入力され、氏名の入力を促され、そのまま登録はできない。
  //   「所有者なしで登録する」を選べば従来どおり(人が見たうえで選んだ結果)。
  // ⚠**所有者の氏名が申込者(お名前)と別に書かれていたら、所有者はそちら**
  //   (発注者決定 2026-10-08・タカウル実物=所有者は申込者の夫)。
  //   申込者の氏名・フリガナは**捨てずに**「備考に入れない項目」として画面に出す
  //   (Excel 取込では所有者の備考へ入る)。フリガナは申込者のものなので、
  //   所有者の欄には入れない(別人の読みが付く)。
  //   電話・メール・住所は申込者の連絡先のまま所有者の連絡先として入れ、警告で知らせる。
  const applicantName = raw("ownerName");
  const declaredOwnerName = raw("propertyOwnerName");
  const sameName = (a: string, b: string) =>
    a.normalize("NFKC").replace(/[\s　]/g, "") === b.normalize("NFKC").replace(/[\s　]/g, "");
  const ownerDiffersFromApplicant =
    declaredOwnerName !== null && applicantName !== null && !sameName(declaredOwnerName, applicantName);
  const ownerName = declaredOwnerName ?? applicantName;
  const ownerNameLabel = declaredOwnerName !== null ? label("propertyOwnerName") : label("ownerName");
  let ownerKanaField = field(raw("ownerNameKana"), label("ownerNameKana"));
  if (ownerDiffersFromApplicant) {
    withheldFromNote.push({ label: label("ownerName"), value: applicantName, reason: "label" });
    const kana = raw("ownerNameKana");
    if (kana !== null) {
      withheldFromNote.push({ label: label("ownerNameKana"), value: kana, reason: "label" });
    }
    ownerKanaField = EMPTY;
    warnings.push({
      code: "owner_differs_from_applicant",
      message:
        `物件の所有者（${ownerNameLabel}）と申込者（${label("ownerName")}）が別の方です。` +
        `所有者の氏名は「${ownerNameLabel}」の値にしました。電話・メール・住所は申込者の連絡先です。ご確認ください。`,
    });
  }
  // ⚠所有者の氏名はあるのに申込者のお名前が無く、フリガナ・連絡先だけがある
  //   (@codex PR#491 5巡目)。それが所有者本人のものか申込者のものか決められない。
  //   フリガナは所有者に付けず(画面に出す)、連絡先は警告付きで入れ、人に確かめてもらう。
  const applicantSideKeys: DraftFieldKey[] = ["ownerNameKana", "ownerPhone", "ownerEmail", "ownerAddress"];
  if (
    declaredOwnerName !== null &&
    applicantName === null &&
    applicantSideKeys.some((k) => raw(k) !== null)
  ) {
    const kana = raw("ownerNameKana");
    if (kana !== null) {
      withheldFromNote.push({ label: label("ownerNameKana"), value: kana, reason: "label" });
    }
    ownerKanaField = EMPTY;
    warnings.push({
      code: "owner_contact_unconfirmed",
      message:
        `所有者の氏名（${ownerNameLabel}）はありますが、申込者のお名前がありません。` +
        "フリガナ・電話・メール・住所が所有者ご本人のものかご確認ください。",
    });
  }
  const ownerFieldKeys: DraftFieldKey[] = [
    "ownerName",
    "propertyOwnerName",
    "ownerNameKana",
    "ownerPhone",
    "ownerEmail",
    "ownerAddress",
  ];
  const hasAnyOwnerField = ownerFieldKeys.some((k) => raw(k) !== null);
  const owner = !hasAnyOwnerField
    ? null
    : {
        name: field(ownerName, ownerNameLabel),
        nameKana: ownerKanaField,
        phone: field(raw("ownerPhone"), label("ownerPhone")),
        email: field(raw("ownerEmail"), label("ownerEmail")),
        currentAddress: field(raw("ownerAddress"), label("ownerAddress")),
      };
  if (hasAnyOwnerField && ownerName === null) {
    warnings.push({
      code: "owner_name_missing",
      message:
        "所有者の連絡先を読み取りましたが、氏名が読み取れませんでした。氏名を入力するか、「所有者なしで登録する」を選んでください。",
    });
  }

  // ---- 値を解釈できなかった欄の共通処理 ----
  // ⚠**捨てて黙らない**(@codex PR#414 9巡目 ②)。5巡目で「単位が確かでなければ
  //   null」にした結果、`20坪（66.1㎡）` のような値は確認画面で
  //   「元の資料に記載がありません」と出ていた＝**元資料には書いてあるのに
  //   無いと言う**＝利用者への嘘で、設計の「誤解させない」に正面から反する。
  //   ①警告を出す ②生の値を備考へ残す(辞書に無い見出しと同じ扱い＝情報を失わない)
  //   ③欄は空のまま(推測で埋めない) の3つを同時に行う。
  // ⚠面積に限らず、**見出しは辞書にあるのに値を解釈できなかった場合すべて**に
  //   同じ扱いをする(築年の元号エラー・現況の言い換え不明も同型)。
  function readOrKeepRaw<T>(
    key: DraftFieldKey,
    fieldKey: string,
    fieldLabel: string,
    parse: (raw: string) => T | null,
  ): T | null {
    const rawValue = raw(key);
    if (rawValue === null) return null;
    const parsed = parse(rawValue);
    if (parsed !== null) return parsed;
    warnings.push({
      code: "value_unreadable",
      field: fieldKey,
      message: `${fieldLabel}「${rawValue}」を読み取れませんでした。ご確認のうえ入力してください。`,
    });
    // 備考へ回す(見出しは元の表記のまま＝原文と突き合わせられる)。
    const noteLabel = label(key) || fieldLabel;
    unmapped.push({ label: noteLabel, value: rawValue });
    // どの欄の生値かを覚えておく(人がその欄に値を入れたら備考から消すため)。
    unreadable.push({ field: fieldKey, label: noteLabel, value: rawValue });
    return null;
  }

  const builtYear = readOrKeepRaw("builtYearRaw", "builtYear", "築年", (v) =>
    warekiToSeireki(v, options),
  );
  const area = readOrKeepRaw("exclusiveArea", "exclusiveArea", "専有面積", parseAreaSqm);
  const landArea = readOrKeepRaw("landArea", "landArea", "土地面積", parseAreaSqm);
  const occupancy = readOrKeepRaw("occupancyRaw", "occupancyStatus", "現況", occupancyFor);

  return {
    sourceProfile,
    sourceProfileLabel: SOURCE_PROFILE_LABELS[sourceProfile],
    property: {
      address: field(address, label("address")),
      lotNumber: field(lotNumber, label("lotNumber") || label("address")),
      buildingName: field(buildingName, label("buildingName")),
      roomNo: field(roomNo, roomNoLabel),
      propertyType: field(mappedType?.value ?? null, label("propertyTypeRaw")),
      exclusiveArea: field(area === null ? null : String(area), label("exclusiveArea")),
      landArea: field(landArea === null ? null : String(landArea), label("landArea")),
      layoutType: field(raw("layoutType"), label("layoutType")),
      occupancyStatus: field(occupancy, label("occupancyRaw")),
      builtYear: field(builtYear === null ? null : String(builtYear), label("builtYearRaw")),
    },
    owner,
    // ⚠外部キー(査定ナンバー)は**この入口で1回だけ**正規化し、以降は
    //   「保存する値 == 検索する値 == 助言ロックの鍵」を常に同じ文字列で通す
    //   (@codex PR#414 の指摘 → 発注者判断 2026-08-26)。
    //   ⚠いちばん重要な理由は**ロック**: 助言ロックの鍵が比較に使う鍵と
    //   一致していなければ、鍵がずれた瞬間に直列化が外れ、二重登録のガードが
    //   静かに無効になる。ロックと比較は同じ値でなければ意味がない。
    //   正規化は既存の toHalfWidth + 前後の空白除去だけ(新しい正規化は増やさない)。
    //   査定ナンバーは元々半角ASCIIなので、実際に保存される文字列は変わらない。
    externalLinkKey: normalizeExternalLinkKey(raw("externalLinkKey")),
    applicantName,
    warnings,
    unmapped,
    withheldFromNote,
    unreadable,
    // ⚠割れなかった行も捨てずに持つ（設計書 §4.2）。全体レビュー I-5:
    //   parseLabeledLines は unlabeled を返していたのに、ここで labeled しか
    //   受け取っておらず、下書きに乗る前に消えていた。
    unlabeled,
    noteFromUnmapped: unmapped.map((u) => `${u.label}: ${u.value}`).join("\n"),
  };
}
