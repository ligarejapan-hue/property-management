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
const RENTAL_NEGATION = /(賃貸|貸)[^。．、，,.]{0,16}?(ない|なく|無い|無く|ません|なかった)/;

/** 「自己居住ではない」「居住中ではありません」など、居住の印の打ち消し(16巡目)。 */
//   住む・居住・入居のあと8字以内の打ち消し(「居住してません」「住んでません」「住んでない」)も同じ(17巡目)。
const OCCUPIED_NEGATION =
  /(自己居住|居住中|入居中)(では|で|じゃ)?(な|無|ありません|ございません)|(居住|住ん|住ま|入居)[^、。,，．]{0,8}?(ない|なく|無い|無く|ません|おらず|せず|ず[、。,，．]|ず$)/;

/** 本人以外の、身内・知り合いなどを指す語(21・26・27巡目=配偶者も)。 */
const RELATIVE_WORDS = [
  "親族", "家族", "親戚", "息子", "娘", "両親", "子供", "子ども", "知人", "従業員", "兄弟", "姉妹",
  "配偶者", "妻", "夫", "奥様", "奥さん", "旦那", "主人", "母", "父", "祖父", "祖母", "孫", "義父", "義母",
];

/** 本人・所有者と、住む・入居の語が、借り手・身内・第三者の語をはさまずに続く。 */
const OWNER_RESIDES = new RegExp(
  `(本人|自身|オーナー|所有者)(?:(?!${[
    "賃借人", "借主", "借り手", "借り主", "賃借者", "店子", "入居者", "テナント", "借家人",
    ...RELATIVE_WORDS, "第三者", "他人", "社宅",
  ].join("|")})[^、。,，．]){0,8}(居住|住ん|入居)(?!者|を|の|権|地|費|料|日|先|予|証|歴|届)`,
);

/** 「本人ではない」「所有者以外」など、住んでいるのが本人でないと言っている(15巡目)。 */
const NOT_OWNER = /(本人|オーナー|所有者|自身)((では|で|じゃ)?(な|無)|以外)/;

/** 借り手の語のすぐ後ろ(句読点をはさまず8字以内)に、いない・募集・退去などの不在の印がある。 */
const TENANT_ABSENT =
  /(賃借人|借主|借り手|借り主|賃借者|店子|入居者|テナント|借家人)[^、。,，．]{0,8}?(なし|無し|いない|いません|おりません|おらず|募集|退去|空き|不在)/;

/**
 * 借り手の語のすぐ後ろ(句読点をはさまず6字以内)に、住んでいる印がある。
 * 逆の順(「居住中（賃借人）」「入居中：テナント」)も同じ(28巡目)。
 */
const TENANT_PRESENT =
  /(賃借人|借主|借り手|借り主|賃借者|店子|入居者|テナント|借家人)[^、。,，．]{0,6}?(入居中|居住中|住んで|入居して|居住して|あり|有り|がいる|はいる|もいる|がいます|もいます|がおります|もおります)|(入居中|居住中)[（(：:・\s]{0,2}(賃借人|借主|借り手|借り主|賃借者|店子|入居者|テナント|借家人)/;

/**
 * 「…が/は 居住・入居・住ん」の主語を見る。主語が無ければ true(書き方の決まった値=従来どおり)。
 * 主語が本人の語(本人・自身・所有者・オーナー・名義人・売主・私・自分)で終わる、本人と並べている
 * (「自身・親族」)、または借り手の語なら true。それ以外(管理人・代理人・知人…)は false。
 * 「所有者によると」「…の話では」のような**伝聞の前置き**は主語から外して、その後ろを主語とみる。
 */
function subjectIsOwnerOrTenant(s: string): boolean {
  //   「も」(管理人も居住中)・「のみ/だけ」も主語の印とみる(52巡目)。
  //   助詞と住む語の間の「現在」「今」「既に」などの言葉(4字まで)もはさめる(53巡目)。
  // 「居住中（管理人）」「入居中：管理人」のように、後ろに添えた人も主語とみる(54巡目)。
  const after = /(居住中|入居中|居住|入居)[（(：:・]([^）)、。,，．]{1,10})/.exec(s);
  if (after && !isOwnerOrTenantWord(after[2])) return false;
  // 助詞を省いた「管理人居住中」も、住む語のすぐ前の名詞を主語とみる(59巡目)。
  //   「現在」「今」「即」などの時の言葉・「自己」は主語でないので外す。
  const bare = /([^、。,，．（()：:\s]{1,10})(居住中|入居中|居住|入居)/.exec(s);
  if (bare) {
    const head = bare[1].replace(/(現在|今|現|既に|引き続き|継続|継続して|即|即時|自己|一部|全部|常時|主に|ずっと|長年|未)+$/, "");
    if (head !== "" && !/(が|は|も|の|に|で|と|を|や|、|のみ|だけ|て|として|し|く|へ|から|まで)$/.test(head) && !isOwnerOrTenantWord(head)) {
      return false;
    }
  }
  const m = /([^、。,，．（()：:]{1,16}?)(が|は|も|のみ|だけ)[^、。,，．（()：:がはも]{0,40}?(居住|入居|住ん)/.exec(s); // 間の言葉は文の中ならいくらでも・別の主語をまたがない(55・60巡目)
  if (!m) return true;
  const parts = m[1].split(/によると|によれば|の話では|の話だと|いわく|曰く|から聞いた|から聞く|では|から/);
  const subj = parts[parts.length - 1];
  // 「誰も住んでいない」=誰も住まない(空室の判定は別にある)。
  if (subj === "" || /(誰|だれ|どなた)$/.test(subj)) return true;
  return isOwnerOrTenantWord(subj);
}

/** 本人の語で終わる・本人と並べている・借り手の語で終わる(主語として居住中/賃貸中を決めてよい)。 */
function isOwnerOrTenantWord(subj: string): boolean {
  // 「前所有者」「元賃借人」「旧オーナー」は今の人ではない(61巡目)。
  if (/(前|元|旧|先代|以前の|前の|元の)(所有者|オーナー|名義人|売主|本人|賃借人|借主|借り手|借り主|賃借者|店子|入居者|テナント|借家人)/.test(subj)) {
    return false;
  }
  if (/(本人|自身|所有者|オーナー|名義人|売主|私|自分)(様|さん)?$/.test(subj)) return true;
  if (/(本人|自身|所有者|オーナー|名義人|売主)(・|と|や|及び|および)/.test(subj)) return true;
  if (/(賃借人|借主|借り手|借り主|賃借者|店子|入居者|テナント|借家人|賃貸)$/.test(subj)) return true;
  return false;
}

/**
 * 現況を決めてよい**決まった書き方**の一覧(許可リスト・@codex PR#512 64巡目)。
 * ⚠自由な文は言い回しが無限にあり、打ち消し・過去・推測・主語の違いを1つずつ追っても漏れが続いた。
 *   そこで、下の判定(occupancyJudge)の結果は、値の全体がこの一覧のどれかに**そのまま**合うときだけ採用する。
 *   合わない文は全部「読み取れない」=警告+原文を備考へ・Excel は人の確認へ(誤って決めるより安全)。
 */
// ⚠「入居者」は住んでいる人一般(借り手とは限らない)なので、許可リストの借り手の語に入れない(65巡目)。
const TENANT_NOUN = "(賃借人|テナント|借主|借り手|借り主|賃借者|店子|借家人)";
const OWNER_NOUN = "(自身|本人|所有者|オーナー|名義人|売主)";
const NOW = "(現在|現況)?[：:]?";
const OCCUPANCY_ALLOWLIST: Record<"vacant" | "occupied" | "rented", RegExp[]> = {
  vacant: [
    new RegExp(`^${NOW}(空室|空家|空き家)([（(]即入居可[）)])?$`),
    new RegExp(`^${OWNER_NOUN}所有[、,]?${NOW}(空室|空家|空き家)$`),
    /^(誰も(住んでいない|居住していない)|空いている|空室になっている)$/,
  ],
  occupied: [
    new RegExp(`^${NOW}(居住中|自己居住中?)$`),
    new RegExp(`^${OWNER_NOUN}(が|は)?${NOW}(居住|住んで)(中|している|しています|います|いる)$`),
    new RegExp(`^(入居者|居住者)(：|:|は)(所有者|オーナー)本人$`),
    new RegExp(`^${OWNER_NOUN}(・|と)(親族|家族)(が)?(居住中|居住している)$`),
  ],
  rented: [
    new RegExp(`^${NOW}(賃貸中|賃貸している|賃貸で貸している|貸している)$`),
    new RegExp(`^${OWNER_NOUN}は(居住していない|住んでいない)[（(]賃貸中[）)]$`),
    new RegExp(
      `^(本人ではなく|本人以外の|本人所有、|所有者の物件で|所有者はいない。)?${TENANT_NOUN}(本人)?(が|は|も)?${NOW}(入居中|居住中|居住している|入居している|あり|有り|います|いる)$`,
    ),
    new RegExp(`^${NOW}(居住中|入居中)[（(：:]${TENANT_NOUN}[）)]?$`),
    new RegExp(`^${NOW}入居中[（(]賃貸[）)]$`),
    /^賃貸物件として入居中$/,
  ],
};

/** 現況の言い換え → OccupancyStatus。許可リストに合う書き方だけ決める(それ以外は null)。 */
function occupancyFor(raw: string): string | null {
  const judged = occupancyJudge(raw);
  if (judged !== "vacant" && judged !== "occupied" && judged !== "rented") return judged;
  const s = raw.replace(/[\s　]/g, "");
  return OCCUPANCY_ALLOWLIST[judged].some((re) => re.test(s)) ? judged : null;
}

/** 現況の言い換えを判定する(結果は occupancyFor が許可リストで絞る)。 */
function occupancyJudge(raw: string): string | null {
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
      // ⚠間に借り手の語をはさむ「所有者の物件で賃借人が入居中」は本人の居住ではない(25巡目)。
      //   身内・第三者の語をはさむ「所有者に無断で第三者が入居中」も同じ(41巡目)。
      OWNER_RESIDES.test(s) ||
      // 「自身・親族が居住中」「本人と家族が居住」=本人も一緒に住んでいる(並べる言い方は本人の居住)。
      /(本人|自身|オーナー|所有者)(・|と|や|及び|および)[^、。,，．]{0,8}(居住|住ん|入居)(?!者|を|の|権|地|費|料|日|先|予|証|歴|届)/.test(s) ||
      /(入居者|居住者)[^、。,，．]{0,6}(所有者|オーナー)/.test(s)) &&
    // ⚠「入居者本人」「賃借人本人」の本人は借り手のこと=所有者の居住ではない(24巡目)。
    !/(入居者|居住者|賃借人|借主|借り手|借り主|賃借者|店子|テナント|借家人)本人/.test(s) &&
    // ⚠「所有者の家族が居住中」「オーナーの息子が入居中」は所有者以外が住んでいる(26巡目)。
    //   (「自身・親族が居住中」=本人も一緒は除かない)
    !new RegExp(`(本人|自身|オーナー|所有者)の(${RELATIVE_WORDS.join("|")})`).test(s) &&
    // ⚠「所有者の代理人が居住中」など、所有者の**何か**(人)が住んでいる言い方は本人の居住にしない(42巡目)。
    //   (「本人の居住」「所有者の住まい」のように、の のあとが住む語なら除かない)
    !/(本人|自身|オーナー|所有者)の(?!居住|住|入居)/.test(s) &&
    !NOT_OWNER.test(s);
  //   ⚠借り手の語は**住んでいる印**(入居中・居住中・住んでいる・あり・いる)と一緒のときだけ数える
  //   (「入居者未定」「入居者については確認中」は決めない・13巡目)。
  //   ⚠住んでいる印は**借り手の語のすぐ後ろ**だけを見る。「入居者を探している」「入居者がいるか確認中」の
  //   ような探している・確かめている言い回しは数えない(14巡目)。
  //   ⚠親族・家族などが住んでいる言い方は借り手と決めない(「親族が入居者として居住中」・23巡目)。
  const familyWord = has([...RELATIVE_WORDS, "第三者", "社宅", "他人"]);
  //   ⚠「テナントではありません」「賃借人ではない」は借り手の印にしない=決めない(29巡目)。
  //   「賃借人以外」「入居者以外」も同じ(33巡目)。
  if (/(賃借人|借主|借り手|借り主|賃借者|店子|入居者|テナント|借家人)((では|で|じゃ)?(な|無|ありません|ございません)|以外)/.test(s)) return null;
  const tenantEvidence =
    !familyWord &&
    !tenantAbsent &&
    TENANT_PRESENT.test(s) &&
    // 打ち消し(「居住してない」)・過去(「居住していた」「入居していた」)は今住んでいる印にしない(19巡目)。
    !OCCUPIED_NEGATION.test(s) &&
    !has(["ていた", "でいた", "だった", "ていました", "でいました"]) &&
    !has(["探し", "確認中", "未定", "かどうか", "いるか", "あるか"]);
  // ⚠本人の居住と借り手の居住が**両方**言われていれば決めない(「本人が居住中、賃借人も入居中」・29巡目)。
  if (ownerSelf && tenantEvidence) return null;
  const tenantMarker = tenantEvidence && !ownerSelf;
  //   「現在入居中（賃貸）」「賃貸物件として入居中」のように、賃貸が今の入居を説明しているときも賃貸中(30巡目)。
  const rentalQualifiesOccupancy = /賃貸[^、。,，．]{0,8}?(入居|居住)|(入居中|居住中)[（(：:・]{0,2}賃貸/.test(s);
  const explicitRental =
    has(["賃貸中", "賃貸している", "貸している", "賃貸に出している"]) || rentalQualifiesOccupancy;
  const rentedMarker = tenantMarker || explicitRental;
  // ⚠本人の居住と賃貸の語が両方あれば決めない(「本人が居住している、賃貸中」・35巡目)。
  if (ownerSelf && explicitRental) return null;
  // ⚠住んでいる人(主語)が本人でなければ、本人の居住とは決めない(50・51巡目)。
  //   「管理人が居住中」「所有者によると管理人が居住中」。言葉を1つずつ並べず、主語で見る。
  if (!subjectIsOwnerOrTenant(s)) return null;
  // ⚠賃貸の打ち消し(「賃貸中ではない」「貸していない」)は賃貸中と読まない=決めない(@codex PR#512)。
  //   ていねいな打ち消し(「賃貸中ではありません」「貸していません」)も同じ(@codex PR#512 2巡目)。
  if (RENTAL_NEGATION.test(s)) return null;
  // 「賃貸中止」「賃貸中断」「賃貸終了」「契約満了」など、貸すのをやめた言い方も決めない(40巡目)。
  if (has(["中止", "中断", "終了", "解約", "満了", "取りやめ", "とりやめ", "停止"])) return null;
  // ⚠今ではないこと(過去・予定)や、まだ分からないこと(確認中・未定)を言っているなら、
  //   誰についてでも決めない(20巡目)。「本人が居住していた」「自己居住の予定」「居住しているか確認中」など。
  if (
    has(["ていた", "でいた", "だった", "ていました", "でいました", "なかった", "ませんでした", "予定", "以前", "かつて", "元は", "過去", "昔", "前は", "当時", "以前は", "元々", "もともと", "まで", "昨年", "去年", "先月", "先週", "一昨年", "居住歴", "入居歴", "経験", "履歴", "歴あり", "居住権", "入居権", "権利", "今後", "将来"]) ||
    has(["確認中", "未定", "かどうか", "いるか", "あるか", "不明"]) ||
    // 探している・募集中、「…わけではない」の打ち消しも決めない(43巡目)。
    has(["探し", "募集", "わけではな", "わけでは無", "わけではありません", "わけじゃな"]) ||
    // 文のどこかに「…ではない／ではありません／じゃない」があれば、どこを打ち消しているか分からない=決めない(62巡目)。
    //   ⚠「AではなくB」(対比)は打ち消しの対象がはっきりしているので除く(11巡目: 本人ではなく賃借人が入居中=賃貸中)。
    /(では|じゃ)(な(?!く)|無(?!く)|ありません|ございません)/.test(s) ||
    // 「…とは限らない」、入居の前の段階(準備中・入居前・手続き中・待ち)も決めない(44巡目)。
    has(["限らない", "限りません", "とは言え", "準備", "入居前", "居住前", "手続", "待ち"]) ||
    // 「未入居」「未居住」「非居住」も住んでいない側=決めない(45巡目)。
    has(["未入居", "未居住", "非居住", "不住"]) ||
    // 「所有者は別住所に居住」など、ほかの場所に住んでいる言い方も決めない(46巡目)。
    // これからのこと(来月・来週・近々・「入居する」「住む」の言い切り)も今の状態ではない(47巡目)。
    // 断った・反対・できないなど、住むことを否定する言い方も決めない(48巡目)。
    has(["拒否", "断っ", "断り", "反対", "不可", "できない", "出来ない", "できません", "出来ません"]) ||
    has(["来月", "来週", "来年", "翌月", "後日", "近々", "近日", "いずれ", "今度", "入居する", "居住する", "住む", "引っ越", "引越"]) ||
    has(["別住所", "別の住所", "他所", "よそ", "別宅", "別居", "遠方", "県外", "市外", "海外", "実家", "施設", "入院", "転居"]) ||
    // 推測(可能性・かもしれない・らしい・おそらく)も今の状態と決めない(42巡目)。
    has(["可能性", "かもしれ", "かも", "らしい", "はず", "おそらく", "恐らく", "たぶん", "多分", "推定", "と思"]) ||
    // 「…とは考えられない」「疑わしい」なども決めない(53巡目)。
    has(["考えられ", "思え", "思われ", "思いません", "見えな", "見えません", "疑わし", "怪し", "定かでな", "はっきりしな"]) ||
    // 「…との情報」「未確認」「聞いている」など、確かめていない言い方も決めない(61巡目)。
    has(["未確認", "要確認", "との情報", "との話", "と聞", "伝聞", "噂", "うわさ", "らしく", "そうだ", "とのこと"]) ||
    // 「居住可能」「入居できる」など、できる・できそうというだけの言い方も今の状態ではない(58巡目)。
    //   ⚠「空室（即入居可）」は空室のまま=住める状態の言い方は空室の語があれば下で空室になる。
    (has(["居住可", "入居可", "居住でき", "入居でき", "住める", "住むことができ", "住むことも可能"]) &&
      !has(["空室", "空家", "空き家"])) ||
    // 希望・検討などの「これからの意向」も今の状態ではない(39巡目)。
    has(["希望", "検討", "つもり", "見込み", "予約", "申込", "申し込"])
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
    (ownerSelf || occupiedMarker || has(["賃貸", "貸して", "賃借人", "借主", "借り手", "借り主", "賃借者", "店子", "入居者", "テナント", "借家人"]))
  ) {
    return null;
  }
  // 借りている人が「入居中」なら賃貸中(本人の居住を言う語は tenantMarker の時点で外してある)。
  if (tenantMarker) return "rented";
  if (rentalQualifiesOccupancy && !ownerSelf) return "rented";
  // 本人でない人が住んでいる(家族か借り手か分からない)=賃貸の語が無ければ決めない(15巡目)。
  if (NOT_OWNER.test(s) && !explicitRental) return null;
  //   「所有者の代理人が居住中」=所有者の(人)が住んでいる=本人ではない(42巡目)。
  if (/(本人|自身|オーナー|所有者)の(?!居住|住|入居)/.test(s) && !explicitRental) return null;
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
  if (/(入居者|居住者|賃借人|借主|借り手|借り主|賃借者|店子|テナント|借家人)本人/.test(s) && !explicitRental) return null;
  // `所有者は居住していない（賃貸中）` = 本人は住まず人に貸している=賃貸中(10/14 から決められる)。
  if (rentedMarker) return occupiedMarker ? null : "rented";
  if (someoneNotLiving) return null;
  // ⚠ここまでで決まらず、借りる側の語(賃借人・テナント等)がどこかにあるなら、居住中とは決めない
  //   (「現在居住中、入居者は賃借人」のように別の節で借り手と言っている・37巡目)。
  //   別の節の言い方を1つずつ追わず、居住中と取り違える道だけを閉じる(迷ったら人の確認へ)。
  if (/(賃借人|借主|借り手|借り主|賃借者|店子|テナント|借家人)/.test(s)) return null;
  // ⚠「入居中」「居住している」「入居している」だけでは、住んでいるのが本人か借り手か分からない=決めない(38巡目)。
  //   本人の語と結びつくもの(「自身が居住している」タカウル実物)は上の ownerSelf で居住中になっている。
  //   「居住中」「自己居住」は査定の申込で本人の居住を言う決まった書き方なので居住中のまま。
  if (has(["居住中", "自己居住"]) && !OCCUPIED_NEGATION.test(s)) return "occupied";
  if (occupiedMarker) return null;
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
