/**
 * 「画面に出ている名前で検索しても当たる」ようにするための、検索語の読み替え。
 *
 * 添付ファイル検索は、打った文字を**DBに保存されている生のファイル名**に対して探す。
 * 一方、自動取得で入った謄本の一覧表示は「謄本(所有者事項)_2026-08-25.pdf」という
 * **組み立てた名前**で出している。そのままだと
 *   - 昔からある `registry-auto-…` の行は「謄本」で探しても出てこない
 *   - 画面の名前をそのまま貼り付けても当たらない
 * という食い違いが残る（@codex #412 P2）。
 *
 * ここでは検索語を見て、「組み立てた名前の一部を打っている」と判断できるときだけ、
 * 種別と登録日という**保存されている材料の条件**へ読み替える。呼び出し側はこれを
 * 生のファイル名検索と OR で足す＝**取りこぼしを減らすだけで、絞り込みは強めない**。
 *
 * ⚠この読み替えが引き受ける範囲（それ以上は主張しない）:
 *   (1) 「謄本」「所有者事項」「全部事項」など、組み立てた名前の**連続した一部**であること
 *   (2) 日付は YYYY-MM-DD の形で、実在する日付であること
 *   (3) 上の2つの組み合わせ（画面の名前をそのまま貼り付けた場合を含む）
 *   それ以外の語（例「世田谷区」「registry-auto-2024」）は null を返し、
 *   従来どおり生のファイル名の検索だけが効く。
 */
import { isRealCalendarDate } from "@/lib/calendar-date";

export interface RegistryNameSearchPlan {
  /** 対象にする請求種別。種別を特定できないときは両方。 */
  certificateTypes: ("owner" | "all")[];
  /** 日本時間の日付（YYYY-MM-DD）。指定が無ければ null。 */
  jstDate: string | null;
}

/** 組み立てた名前の、日付と拡張子を除いた部分。ここに無い形は受け付けない。 */
const NAME_STEMS: ReadonlyArray<{ stem: string; types: ("owner" | "all")[] }> = [
  { stem: "謄本(所有者事項)", types: ["owner"] },
  { stem: "謄本(全部事項)", types: ["all"] },
  { stem: "謄本", types: ["owner", "all"] },
];

const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;

export function planRegistryNameSearch(
  term: string | null | undefined,
): RegistryNameSearchPlan | null {
  const raw = (term ?? "").trim();
  if (!raw) return null;

  // 日付らしき部分を1つだけ取り出す。実在しない日付（2026-02-31 等）は日付扱いしない。
  const dateHit = raw.match(DATE_PATTERN);
  if (dateHit && !isRealCalendarDate(dateHit[0])) return null;
  const jstDate = dateHit ? dateHit[0] : null;

  // 残りが「組み立てた名前の一部」かどうかだけを見る。
  // 日付・区切りの `_`・拡張子は組み立ての決まりごとの側なので取り除く。
  let rest = raw;
  if (dateHit) rest = rest.replace(dateHit[0], "");
  rest = rest.replace(/\.pdf$/i, "").replace(/_/g, "").trim();

  if (!rest) {
    // 日付だけを打った場合。種別は絞らない。
    return jstDate ? { certificateTypes: ["owner", "all"], jstDate } : null;
  }

  // 「連続した一部」だけを受け付ける（"謄本X" のような無関係な語を拾わない）。
  // ⚠**当てはまる形を全部集めて合わせる**。「謄本」は所有者事項にも全部事項にも
  //   当てはまるので、最初に見つけた1つで打ち切ると片方を取りこぼす。
  const matched = NAME_STEMS.filter(({ stem }) => stem.includes(rest));
  if (matched.length === 0) return null;
  const certificateTypes = (["owner", "all"] as const).filter((t) =>
    matched.some(({ types }) => types.includes(t)),
  );
  return { certificateTypes: [...certificateTypes], jstDate };
}

/**
 * 日本時間の1日を、保存されている時刻（UTC基準の Date）の範囲へ直す。
 * ⚠実行環境のローカル時刻に頼らない。JST は UTC+9 固定なので、UTC の前日15時〜当日15時。
 */
export function jstDayRangeUtc(
  jstDate: string,
): { gte: Date; lt: Date } | null {
  if (!isRealCalendarDate(jstDate)) return null;
  const [y, m, d] = jstDate.split("-").map(Number);
  const startUtcMs = Date.UTC(y, m - 1, d) - 9 * 60 * 60 * 1000;
  return {
    gte: new Date(startUtcMs),
    lt: new Date(startUtcMs + 24 * 60 * 60 * 1000),
  };
}
