/**
 * 貼り付けて物件化で、**コメント・ご要望などの自由記述を所有者の備考へ**入れる(2026-10-24 従業員の指摘)。
 *
 * ⚠なぜ物件の備考ではなく所有者の備考か:
 *   自由記述は何が書かれるか分からないので、物件の備考(物件を見られる人全員に出る)へは入れない
 *   (owner-personal-info.ts の withheld)。所有者の備考は owner_note の表示レベルで守られる欄で、
 *   Excel の顧客管理表の取込もコメント・見込度などをここへ入れている(composeLeadOwnerNote)。
 * ⚠入れるのは次を**すべて**満たすものだけ(安全なものだけで組み立てる=許可リスト):
 *   ①伏せた理由が unclassified(見出し・値の形で電話/メール/住所/氏名などと分かったものではない)
 *   ②**見出しが自由記述の欄だと分かる**(コメント・ご要望・理由…の語を含む)。
 *     unclassified は「安全と確定できなかった」だけで「コメントだ」とは言っていない
 *     (`姓： Jonathan Smith` も unclassified になる・@codex PR#576 P1)。
 *   ③文の中に電話番号・メールアドレスを含まない(内部レビュー P2)
 *   それ以外は今までどおり画面に出して人が移す。
 * ⚠ Prisma / next を import しない(純関数)。
 */
import type { PasteDraft } from "./types";

/** 所有者の備考の1行目(どこから入ったかを示す)。 */
export const PASTE_IMPORT_OWNER_NOTE_PREFIX = "貼り付け取込:";

/**
 * 自動で組み立てる所有者の備考の上限(文字数)。確定 API も同じ値で断る。
 * これを超えるときは組み立ての側で切り詰めて印を付ける(取込そのものを止めない・@codex PR#576 P2)。
 */
export const MAX_PASTE_OWNER_NOTE_LENGTH = 20000;
const TRUNCATED_MARK = "…(長いため以下を省きました。元の文面は取込元をご覧ください)";

/**
 * 自由記述の欄だと分かる見出しの語(正規化後に含むか)。
 * ⚠ここに足してよいのは「その欄には文章が書かれる」と言い切れる語だけ。
 *   人名・住所・番号の欄を指しうる語(名・姓・先・番号…)は足さない。
 */
const FREE_TEXT_LABEL_WORDS: readonly string[] = [
  "コメント",
  "要望",
  "理由",
  "セールスポイント",
  "備考",
  "質問",
  "相談内容",
  "問い合わせ内容",
  "お問い合わせ内容",
  "メッセージ",
  "自由記入",
  "自由記述",
  "特記事項",
  "伝達事項",
  "その他",
];

type Withheld = PasteDraft["withheldFromNote"][number];

function normalizeLabel(label: string): string {
  return label.normalize("NFKC").replace(/[\s　]/g, "").toUpperCase();
}

function isFreeTextLabel(label: string): boolean {
  const n = normalizeLabel(label);
  return FREE_TEXT_LABEL_WORDS.some((w) => n.includes(normalizeLabel(w)));
}

/**
 * 文の中に電話番号(区切りを挟んで数字10桁以上)やメールアドレス(@)を含むか。
 * ⚠値の形の判定(looksLikePhoneNumber など)は値**全体**が電話・メールのときだけ当たるので、
 *   「折り返しは090-1234-5678まで」のような文は unclassified になる(内部レビュー P2)。
 *   所有者の備考は見られても電話・メールは見られない人がいるので、そういう文は自動で入れず人が移す。
 */
function containsContact(value: string): boolean {
  const v = value.normalize("NFKC");
  if (v.includes("@")) return true;
  return /[0-9](?:[\s\-‐−ー().]*[0-9]){9,}/.test(v);
}

/** 所有者の備考へ入れる項目か(上の①〜③をすべて満たすもの)。 */
export function goesToOwnerNote(w: Withheld): boolean {
  return w.reason === "unclassified" && isFreeTextLabel(w.label) && !containsContact(w.value);
}

/**
 * 所有者の備考に入れる文を組み立てる。入れる項目が無ければ null。
 * 形: 1行目 `貼り付け取込:`、続けて `見出し: 値` を1項目1行。上限を超えたら切り詰めて印を付ける。
 */
export function composePasteOwnerNote(draft: Pick<PasteDraft, "withheldFromNote">): string | null {
  const lines = draft.withheldFromNote
    .filter(goesToOwnerNote)
    .map((w) => `${w.label}: ${w.value.trim()}`)
    .filter((l) => !l.endsWith(": "));
  if (lines.length === 0) return null;
  const note = [PASTE_IMPORT_OWNER_NOTE_PREFIX, ...lines].join("\n");
  if (note.length <= MAX_PASTE_OWNER_NOTE_LENGTH) return note;
  return note.slice(0, MAX_PASTE_OWNER_NOTE_LENGTH - TRUNCATED_MARK.length) + TRUNCATED_MARK;
}
