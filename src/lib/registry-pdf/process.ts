/**
 * 謄本PDF取込の中核処理（手動取込・将来の自動取得連携で共有する）。
 *
 * route.ts（POST handler）から「認証・入力受け口（multipart/text）」を除いた
 * 残り全部 ＝ parse → ImportJob 作成 → Mode A/B 物件特定 → 所有者反映
 * → silent fail / success finalize（ImportJobRow・Attachment(type="registry")保存・
 * AuditLog）→ レスポンス body 生成 を `processRegistryPdf` に集約する。
 *
 * PR1（無挙動リファクタ）: 既存 route.ts の挙動・レスポンス・ステータスコード・
 * ImportJob/ImportJobRow・Attachment 保存・Mode A/B・所有者反映・AuditLog・warning は
 * 一切変更しない。route.ts からロジックを移しただけ。
 *
 * 入力 text は呼び出し側（route の multipart→extractTextFromPdf / text 貼り付け）で
 * 抽出済みのものを受け取る。pdfBuffer は multipart のときのみ非 null（Attachment 保存用）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { lockPropertyRecordForWrite, lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { ApiError } from "@/lib/api-helpers";
import { safeErrorSummary } from "@/lib/safe-error-summary";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { normalizeName, normalizeAddress } from "@/lib/normalize";
import { pickReusableAddresslessOwner } from "@/lib/registry-pdf/owner-reuse";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { buildErrorRawDataExtras } from "@/lib/import-error-display";
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES } from "@/lib/storage";
import {
  decideCorporateImport,
  emptyCorporateImportSummary,
  tallyCorporateDecision,
  corporateImportMessage,
  appendImportMessage,
  type CorporateImportDecision,
} from "@/lib/owner-corporate-import";

// 確定取込で UI が編集した結果（A-2a）。サーバ再 parse より優先する。
// クライアント送信値は無検証で信用せず zod で型・件数を検証する。
export const editedImportSchema = z.object({
  fields: z
    .object({
      realEstateNumber: z.string().nullish(),
      address: z.string().nullish(),
      lotNumber: z.string().nullish(),
      buildingNumber: z.string().nullish(),
      landCategory: z.string().nullish(),
      area: z.string().nullish(),
    })
    .optional(),
  owners: z
    .array(
      z.object({
        name: z.string(),
        address: z.string().nullish(),
        share: z.string().nullish(),
      }),
    )
    .max(100, "所有者が多すぎます")
    .optional(),
});
export type EditedImport = z.infer<typeof editedImportSchema>;

export const registryPdfJsonSchema = z.object({
  /** Extracted text from the PDF (テキスト貼り付けモード) */
  text: z.string().min(1, "テキストは必須です"),
  /** Optional: property ID to update instead of creating new */
  propertyId: z.string().uuid().optional().nullable(),
  /** File name for audit purposes */
  fileName: z.string().optional(),
  /** UI で編集した確定データ（任意）。再 parse 結果より優先して反映する。 */
  edited: editedImportSchema.optional(),
});

/** processRegistryPdf に渡す認証済みセッション（最小形）。 */
export interface RegistryPdfSession {
  id: string;
  role: string;
}

export interface ProcessRegistryPdfArgs {
  /** 認証済みセッション（route の getApiSession の結果）。 */
  session: RegistryPdfSession;
  /** PDF/貼り付けから抽出済みのテキスト。 */
  text: string;
  /** Mode A 指定の物件ID（null なら Mode B）。 */
  propertyId: string | null;
  /** 監査用ファイル名。 */
  fileName: string;
  /** UI 編集データ（任意）。 */
  edited: EditedImport | undefined;
  /** multipart(PDF binary) のときのみ非 null。Attachment(type="registry") 保存用。 */
  pdfBuffer: Buffer | null;
  /**
   * 「所有者が空の物件だけに入れる」呼び出し元向け(添付済み謄本からの反映)。
   * 書き込みと同じ物件行ロックの中で0件かを見直し、承認された所有者は
   * 全員ぶんを1つのトランザクションで入れる。既定 false = 従来どおり。
   */
  requireNoExistingOwners?: boolean;
  /**
   * **所有者だけを入れ、物件の項目は書き換えない**(添付済み謄本からの反映)。
   * 既定 false = 従来どおり(空の項目を謄本の値で埋める)。
   */
  ownersOnly?: boolean;
  /**
   * ジョブ作成後の失敗を記録するとき、**生のエラー文を残さない**(種類とコードに丸める)。
   * ⚠データベースや保管庫の例外は、拒否した呼び出しの中身(登記由来の住所など)を
   *   文面に埋め込むことがある。「見せたものだけ書く」経路(添付済み謄本からの反映・
   *   まとめて反映)では必ず指定する。既定 false = 従来どおり(手動取込・自動取得は
   *   担当者の手がかりとして生の文面を残す)。
   */
  sanitizeFailureDetails?: boolean;
  /**
   * **書き込みのロックと同じ1文で担当者スコープを見直す**(添付済み謄本からの反映)。
   * ⚠担当者だけの権限(field_staff)は、route の事前確認を通ったあと書き込みまでの
   *   間に担当を外されうる。素のロックは担当を見直さないので、もう扱えない物件に
   *   所有者が永久に残る。指定すると `lockPropertyRecordForWrite` を使い、ロック時点で
   *   担当外なら 403 で何も書かない。
   * 既定 false = 従来どおり素のロック。⚠有料取得の経路では指定しない
   *   (「課金後は止めない」= 取得を頼んだ担当者がその間に外されても、買った謄本の
   *   結果は保存する)。
   */
  enforcePropertyScope?: boolean;
  /**
   * **物件行のロックを握った状態で、最初の書き込みの直前に呼ぶ**(まとめる経路向け)。
   * 呼び出し元が受付時点で確かめたこと(例: 下見で見せた添付が今も最新か)を、
   * 書き込みと同じロックの中で見直すための入口。投げれば何も書かずに巻き戻る。
   * ⚠requireNoExistingOwners のときだけ呼ばれる(0件の見直しと同じ場所)。
   */
  beforeFirstWrite?: (tx: DbClient) => Promise<void>;
  /**
   * **所有者を全員紐づけ終えたあと、同じトランザクションの確定の直前に呼ぶ**(まとめる経路向け)。
   * 呼び出し元の記録(例: まとめて反映の取込記録の行を「成功」にする)を所有者の書き込みと
   * 一緒に確定させるための入口。投げれば所有者の書き込みも巻き戻る。
   * ⚠確定のあとに別の書き込みで記録すると、その間で止まったとき「所有者は入ったのに
   *   記録は未処理」になり、再開で「すでに所有者あり=飛ばした」と誤って記録される。
   * ⚠requireNoExistingOwners のときだけ呼ばれる(全員を1つのトランザクションで入れる場合)。
   */
  beforeCommit?: (tx: DbClient, summary: { linked: number }) => Promise<void>;
  /**
   * 有料取得の請求種別（owner|all）。有料取得フローからのみ渡る（手動取込は undefined）。
   * ⚠**"all"(全部事項)のときは所有者を物件へ反映しない**。全部事項には抹消された
   * 旧所有者が載り、今の解析は現在/抹消を区別できないため、旧所有者を現在の所有者
   * として登録して DM 宛先などを誤らせる恐れがある。all は PDF 添付のみに留める
   * （安全側の既定・発注者確定の方針）。種別が分かる添付には別途ラベルを付ける。
   */
  certificateType?: "owner" | "all";
}

// parse 結果に UI 編集値をマージ（編集優先）。下流の Mode A/B は
// マージ後の parsed をそのまま使うため、所有者反映・物件更新ロジックは不変。
function applyEditedToParsed(
  parsed: ReturnType<typeof parseRegistryText>,
  edited: EditedImport | undefined,
): ReturnType<typeof parseRegistryText> {
  if (!edited) return parsed;
  const nz = (v: string | null | undefined): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
  };
  if (edited.fields) {
    // 部分編集を許容: 実際に送信されたキーだけ parsed に反映し、未送信キーは
    // parser の元値を保持する（hasOwnProperty で送信有無を判定）。空文字を明示
    // 送信したキーは nz("") → null として既存方針どおり上書きする。
    const f = edited.fields;
    const sent = (k: keyof typeof f) => Object.prototype.hasOwnProperty.call(f, k);
    if (sent("realEstateNumber")) parsed.realEstateNumber = nz(edited.fields.realEstateNumber);
    if (sent("address")) parsed.address = nz(edited.fields.address);
    if (sent("lotNumber")) parsed.lotNumber = nz(edited.fields.lotNumber);
    if (sent("buildingNumber")) parsed.buildingNumber = nz(edited.fields.buildingNumber);
    if (sent("landCategory")) parsed.landCategory = nz(edited.fields.landCategory);
    if (sent("area")) parsed.area = nz(edited.fields.area);
  }
  if (edited.owners) {
    parsed.owners = edited.owners
      .map((o) => ({
        name: (o.name ?? "").trim(),
        address: nz(o.address),
        share: nz(o.share),
      }))
      .filter((o) => o.name.length > 0);
  }
  return parsed;
}

// Prisma の unique constraint 違反 (P2002) を duck-type で判定する（Prisma namespace を
// import せずに判定）。@@unique([propertyId, ownerId]) への同時 insert 競合のみ握って
// PropertyOwner link 作成を冪等化するために使う（Codex P2）。
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

// D10: 所有者の法人番号の空欄補完(既存が null のときだけ)を、所有者の行をロックした
// トランザクション内で「編集中の鍵」の有無を見てから行う。
// ⚠**編集中は書かない**(自動処理が編集画面の入力を黙って上書きしないため)。
// ⚠version を必ず進める(今までは付いておらず、編集画面の古い内容で黙って消えるバグだった)。
async function fillOwnerCorporateNumberIfUnlocked(
  ownerId: string,
  corporateNumber: string,
  /**
   * すでに開いているトランザクション。渡されたときは**新しく開かない**。
   *
   * ⚠まとめて1txで処理する経路(添付済み謄本からの反映)では、外側のtxが
   *   同じ所有者の行を既にロックしている。ここで別のトランザクションを開くと
   *   外側が内側を待ち、内側は外側のロックを待つ=**同時実行が無くても固まる**
   *   (待ち時間いっぱいで全部巻き戻る)。
   */
  outerTx?: DbClient,
): Promise<{ count: number; locked: boolean }> {
  const run = async (tx: DbClient) => {
    await lockOwnerRow(tx, ownerId);
    // ⚠**ロックの後に corporateNumber を読み直す**(レビュー round1 #3)。
    // decideCorporateImport を呼んだ時点(=呼び出し側が existingCorporateNumber を
    // 読んだ時点)から所有者の行をロックするまでの間に、別の書き込みが既に
    // 埋めていることがある。その場合は鍵が有っても無くても書く余地が無いので、
    // 「見送った」フラグを立てない(埋める余地が無ければ見送りにならない・R10 と同じ理屈)。
    const fresh = await tx.owner.findUnique({
      where: { id: ownerId },
      select: { corporateNumber: true },
    });
    if (!fresh || fresh.corporateNumber !== null) {
      // 既に埋まっている、またはロック直後に行が消えた=書く余地が無い。
      return { count: 0, locked: false };
    }
    const locked = await isResourceEditLocked(tx, {
      resourceType: "owner",
      resourceId: ownerId,
    });
    if (locked) return { count: 0, locked: true };
    const updated = await tx.owner.updateMany({
      where: { id: ownerId, corporateNumber: null },
      data: { corporateNumber, version: { increment: 1 } },
    });
    return { count: updated.count, locked: false };
  };
  return outerTx ? run(outerTx) : prisma.$transaction((tx) => run(tx as DbClient));
}

// A-2c: 謄本PDF取込の所有者反映（Owner 突合/作成 + PropertyOwner link）を
// Mode A/B 共通の private 関数に括り出す。中身は従来の Mode A ループを propertyId
// 引数化しただけで挙動は不変（突合/正規化/archive race/法人番号の各方針を維持）。
// 返り値は非PIIの件数サマリ:
//   matched = 既存 active Owner を再利用した件数
//   created = 新規 Owner を作成した件数
//   linked  = 新規に作成した PropertyOwner link の件数
/** 所有者の反映で使うDBの口。prisma そのものと、トランザクションの中の口の両方を指す。 */
type DbClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function reflectParsedOwners(args: {
  propertyId: string;
  owners: ReturnType<typeof parseRegistryText>["owners"];
  recordCorporateDecision: (decision: CorporateImportDecision) => void;
  /** D10: 所有者の鍵で法人番号の補完を見送ったときに呼ぶ。 */
  markOwnerCorporateFillSkipped: () => void;
  /**
   * 「所有者が空の物件だけに入れる」呼び出し元(添付済み謄本からの反映)向け。
   * **最初の書き込みの直前に、物件行のロックの中で 0 件かを見直す**。
   * route 側の事前確認と書き込みの間に別タブが所有者を紐づけると、古い判定の
   * まま通ってしまうため。既定 false = 従来どおり(共有名義の追加を妨げない)。
   *
   * このとき、承認された所有者は**全員ぶんを1つのトランザクション**で入れる
   * (途中で失敗して1人目だけ残り、やり直しもできない状態を作らない)。
   */
  requireNoExistingOwners?: boolean;
  /**
   * 法人番号の判定・書き込みを行わない(添付済み謄本からの反映=ownersOnly)。
   * ⚠下見で見せていない項目を黙って書かないため。氏名や住所に13桁の数字が含まれると
   *   法人番号として新規Ownerに保存・既存Ownerの空欄に補完される経路があるが、
   *   確認画面は氏名・住所(・持分)しか出していない。
   */
  skipCorporateNumber?: boolean;
  /**
   * 渡されたときは、物件行のロックを `lockPropertyRecordForWrite`(ロック+担当者
   * スコープの見直し)で取る。未指定 = 素の `lockPropertyRow`(従来どおり)。
   * → ProcessRegistryPdfArgs.enforcePropertyScope を参照。
   */
  scopedSession?: RegistryPdfSession;
  /** → ProcessRegistryPdfArgs.beforeFirstWrite */
  beforeFirstWrite?: (tx: DbClient) => Promise<void>;
  /** → ProcessRegistryPdfArgs.beforeCommit */
  beforeCommit?: (tx: DbClient, summary: { linked: number }) => Promise<void>;
}): Promise<{ matched: number; created: number; linked: number }> {
  const { propertyId, owners, recordCorporateDecision, markOwnerCorporateFillSkipped } = args;

  /** 親の物件行をロックする。scopedSession があれば同じ1文で担当を見直す(0件=403)。 */
  const lockProperty = (tx: DbClient): Promise<void> =>
    args.scopedSession
      ? lockPropertyRecordForWrite(tx, propertyId, args.scopedSession)
      : lockPropertyRow(tx, propertyId);
  let matchedCount = 0;
  let createdCount = 0;
  let linkedCount = 0;

  /** この実行で自分が紐づけた所有者(見直しの対象から外すために覚えておく)。 */
  const linkedByThisRun: string[] = [];

  /**
   * 物件行のロックを握った状態で「まだ所有者が0件か」を確かめる。
   *
   * ⚠確かめるのは「**書き始める前に空だったか**」だけ。1人でも紐づけたあとに
   *   数え直して中断すると、共有名義の謄本で「1人目だけ入ってエラー」という
   *   中途半端な結果になる。以降に別の人が所有者を足した場合は、共有者が
   *   増えただけ＝正当な操作として受け入れる。
   */
  const assertStillEmpty = async (tx: DbClient) => {
    if (!args.requireNoExistingOwners) return;
    if (linkedByThisRun.length > 0) return;
    const existing = await tx.propertyOwner.count({ where: { propertyId } });
    if (existing > 0) {
      throw new ApiError(409, "この物件にはすでに所有者が登録されています", "OWNERS_ALREADY_EXIST");
    }
    // 呼び出し元が受付時点で確かめたことの見直し(同じロックの中・最初の書き込みの前)
    await args.beforeFirstWrite?.(tx);
  };

  /** 1件のトランザクションでまとめるか(=呼び出し元が空の物件を前提にしているか)。 */
  const asOneBatch = Boolean(args.requireNoExistingOwners);

  /** 法人番号の判定。skipCorporateNumber のときは常に「何もしない」。 */
  const decide: typeof decideCorporateImport = (owner, existing) =>
    args.skipCorporateNumber
      ? { action: "noop", corporateNumber: null }
      : decideCorporateImport(owner, existing);

  /**
   * 所有者の反映本体。`db` は prisma か、まとめる場合は外側のトランザクション。
   * ⚠まとめる場合、中で新しいトランザクションを開いてはいけない(入れ子にできない)。
   */
  const applyAll = async (db: DbClient) => {
    const withTx = <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> =>
      asOneBatch ? fn(db) : prisma.$transaction((tx) => fn(tx as DbClient));

    /**
     * まとめる場合に、物件行より先に押さえた所有者の id。
     * ⚠**物件行を押さえたあとは、ここに無い所有者の行を押さえに行かない**。
     *   先押さえの後に別の処理が同じ氏名・住所の所有者を作って確定すると、以後の
     *   探索で見えるようになるが、それを押さえると順序が「物件 → Owner」になり、
     *   その所有者を押さえて物件を待っている /owners と互いに待ち合う。
     *   まとめる場合は**先に押さえた所有者**と**この処理の中で作った/紐づけた所有者**
     *   だけを使い回す(それ以外は見つけても押さえない=新規作成に回す)。
     *   ⚠自分が作った行は自分のトランザクションが既に持っているので、押さえても
     *     順序の問題は起きない。これを除くと、同じ人が謄本に2回載っているとき
     *     同じ氏名・住所の所有者が2人でき、両方が物件に紐づく。
     *   まとめない場合(従来の経路)は所有者ごとに Owner → 物件の順で押さえるので、
     *   この制限は掛けない。
     */
    const prelockedOwnerIds = new Set<string>();
    /** 使い回してよい候補か(まとめる場合は先押さえ済み or この処理で作った/紐づけた所有者だけ)。 */
    const canReuseOwner = (id: string): boolean =>
      !asOneBatch || prelockedOwnerIds.has(id) || linkedByThisRun.includes(id);

    if (asOneBatch) {
      // ⚠**ロックの順序を「Owner → 物件」にそろえる**。
      //   まとめて1つのトランザクションで処理すると、1人目で物件行を押さえたあとに
      //   2人目で既存の所有者の行を押さえることになり、順序が「物件 → Owner」に
      //   なる。所有者を紐づける他の窓口(/api/properties/[id]/owners)は
      //   「Owner → 物件」の順で押さえるため、同時に走ると互いに待ち合って
      //   PostgreSQL がどちらかを中断する。
      //   そこで、使い回す候補になりうる既存の所有者を**先に・id順で**押さえておく。
      //   (id順=どの処理も同じ順で押さえれば、押さえ合いは起きない)
      const activeWithAddress = await db.owner.findMany({
        where: { address: { not: null }, isArchived: false },
        select: { id: true, name: true, address: true },
      });
      const candidateIds = new Set<string>();
      for (const info of owners) {
        if (!info.name || !info.address) continue;
        const normName = normalizeName(info.name);
        const normAddr = normalizeAddress(info.address);
        for (const c of activeWithAddress) {
          if (normalizeName(c.name) === normName && normalizeAddress(c.address!) === normAddr) {
            candidateIds.add(c.id);
          }
        }
      }
      for (const id of [...candidateIds].sort()) {
        // 行を押さえるだけ(updatedAt を今の時刻にする=既存の再利用経路と同じ手)
        await db.owner.updateMany({
          where: { id, isArchived: false },
          data: { updatedAt: new Date() },
        });
        prelockedOwnerIds.add(id);
      }
    }

    for (const ownerInfo of owners) {
      if (!ownerInfo.name) continue;

      // ── 住所が無い所有者：**この物件に既に紐づいている**同名の所有者を再利用する ──
      // なぜ要るか（@codex #394 R6 P2）: 謄本PDFの保存は取込処理の最後にあり、失敗しても
      // 取込は成功扱い（警告のみ）。「PDFだけ入らなかったのでやり直す」が現実に起き、
      // 再利用しないとそのたびに同じ人が物件に並ぶ。
      // ⚠**グローバルな名前だけの統合は従来どおり禁止**（別の物件の同姓同名は別人であり得る）。
      // ⚠**照会・作成・リンクを1つのトランザクションに閉じ、先に物件行をロックする**
      //   （@codex #396）。ロックの外で照会すると、同じ物件への取込が同時に走ったときに
      //   両方が「既存なし」と判定し、それぞれ別の Owner を作ってしまう。PropertyOwner の
      //   一意制約は (propertyId, ownerId) なので、**別 id の2本は制約でも止められない**。
      // ⚠**ループの外に出さない**: 1件の謄本に同名・住所なしが2回出てきたとき、
      //   直前に作った所有者を2件目が再利用できる必要がある。
      if (!ownerInfo.address) {
        const outcome = await withTx(async (tx) => {
          await lockProperty(tx);
          await assertStillEmpty(tx);
          const linked = await tx.propertyOwner.findMany({
            where: { propertyId },
            select: {
              owner: {
                select: {
                  id: true,
                  name: true,
                  address: true,
                  isArchived: true,
                  corporateNumber: true,
                },
              },
            },
          });
          const reusable = pickReusableAddresslessOwner(
            linked.map((l) => l.owner).filter((o): o is NonNullable<typeof o> => !!o),
            ownerInfo.name,
          );
          if (reusable) {
            // 既にこの物件に紐づいている＝リンクは作らない。
            // ⚠**この tx で既存の Owner 行に触らない**（@codex #396 R2）。住所ありの経路は
            //   「Owner → 物件」の順でロックするため、ここで物件を握ったまま Owner を
            //   掴むと**ロック順序が逆**になり、同時実行で互いに待ち合って
            //   PostgreSQL がどちらかを中断する（正常な取込が失敗する）。
            //   法人番号の穴埋めは tx の外で行う（空のときだけ埋める条件付き更新なので
            //   直列化は要らない）。
            return {
              reused: true as const,
              ownerId: reusable.id,
              existingCorporateNumber: reusable.corporateNumber,
            };
          }
          const decision = decide({ name: ownerInfo.name, address: null }, null);
          const created = await tx.owner.create({
            data: {
              name: ownerInfo.name,
              ...(decision.action === "save" && decision.corporateNumber
                ? { corporateNumber: decision.corporateNumber }
                : {}),
            },
            select: { id: true },
          });
          // ⚠自分が入れた分として記録する。これが漏れると、次の所有者の見直しで
          //   **自分が今入れた紐付けを数えて 409** になり、承認した全員が巻き戻る。
          linkedByThisRun.push(created.id);
          await tx.propertyOwner.create({
            data: {
              propertyId,
              ownerId: created.id,
              relationship: ownerInfo.share ? "共有者" : "所有者",
            },
          });
          return { reused: false as const, decision };
        });
        if (outcome.reused) {
          matchedCount++;
          // tx の外で法人番号を穴埋めする（空のときだけ・既存値は自動で上書きしない）。
          const decision = decide(
            { name: ownerInfo.name, address: null },
            outcome.existingCorporateNumber,
          );
          if (decision.action === "save" && decision.corporateNumber) {
            const filled = await fillOwnerCorporateNumberIfUnlocked(
              outcome.ownerId,
              decision.corporateNumber,
              // まとめる場合は開いているtxで実行する(新しく開くと固まる)
              asOneBatch ? db : undefined,
            );
            if (filled.locked) {
              markOwnerCorporateFillSkipped();
              recordCorporateDecision({ action: "noop", corporateNumber: null });
            } else {
              recordCorporateDecision(
                filled.count === 0 ? { action: "noop", corporateNumber: null } : decision,
              );
            }
          } else {
            recordCorporateDecision(decision);
          }
        } else {
          createdCount++;
          linkedCount++;
          recordCorporateDecision(outcome.decision);
        }
        continue;
      }

      // address あり → normalizeName + normalizeAddress で既存 Owner 検索
      // address なし → name のみでの自動統合はしない（同姓同名の別人を誤統合しないため）
      // archived owner は通常の取込候補から除外（Phase 2-A）。
      let candidateOwnerId: string | null = null;
      // Phase D: 既存 Owner ヒット時の corporateNumber 競合判定に使う
      let candidateCorporateNumber: string | null = null;

      if (ownerInfo.address) {
        const normName = normalizeName(ownerInfo.name);
        const normAddr = normalizeAddress(ownerInfo.address);
        const candidates = await db.owner.findMany({
          where: { address: { not: null }, isArchived: false },
          select: { id: true, name: true, address: true, corporateNumber: true },
        });
        const hit = candidates.find(
          (c) =>
            canReuseOwner(c.id) &&
            normalizeName(c.name) === normName &&
            normalizeAddress(c.address!) === normAddr,
        );
        candidateOwnerId = hit?.id ?? null;
        candidateCorporateNumber = hit?.corporateNumber ?? null;
      }

      // 既存 owner を使うパス: lookup と PropertyOwner.create の間に concurrent
      // archive が走った場合に archived owner に link してしまうのを防ぐ。
      // transaction 内で owner 行を updateMany でロック + isArchived=false 再確認 →
      // PropertyOwner 作成までを 1 つの tx に閉じる。count=0 ならフォールバックで
      // 新規 active Owner を作成する。
      let resolvedOwnerId: string | null = null;
      if (candidateOwnerId) {
        // Codex P2: 同時実行で別 tx が先に同じ (propertyId, ownerId) を link 済みだと、
        // tx 内 create が @@unique([propertyId, ownerId]) 違反(P2002)で reject する。
        // その場合は「既にリンク済み」として扱い job 全体は失敗させない（reused 扱い・
        // linkCreated=false で linkedCount を二重に増やさない）。P2002 以外のエラーは
        // 従来どおり throw して失敗させる。
        let reuseResult: { reused: boolean; linkCreated: boolean };
        try {
          reuseResult = await withTx(async (tx) => {
            const lock = await tx.owner.updateMany({
              where: { id: candidateOwnerId!, isArchived: false },
              data: { updatedAt: new Date() },
            });
            if (lock.count === 0) {
              return { reused: false, linkCreated: false };
            }
            // 親の物件行をロック(Owner→親の順・書き込み規約+#364 R10)。
            await lockProperty(tx);
            await assertStillEmpty(tx);
            const existingLink = await tx.propertyOwner.findFirst({
              where: { propertyId, ownerId: candidateOwnerId! },
              select: { propertyId: true },
            });
            let linkCreated = false;
            if (!existingLink) {
              linkedByThisRun.push(candidateOwnerId!);
              await tx.propertyOwner.create({
                data: {
                  propertyId,
                  ownerId: candidateOwnerId!,
                  relationship: ownerInfo.share ? "共有者" : "所有者",
                },
              });
              linkCreated = true;
            }
            return { reused: true, linkCreated };
          });
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
          // 同時実行で相手が先に link 済み → 既にリンク済み扱い（linkedCount は増やさない）。
          reuseResult = { reused: true, linkCreated: false };
        }
        if (reuseResult.reused) {
          resolvedOwnerId = candidateOwnerId;
          matchedCount++;
          if (reuseResult.linkCreated) linkedCount++;
        }
        // 競合検出時は resolvedOwnerId=null のまま下のフォールバックへ
      }

      // Phase D: reuse 成功判定。
      // `resolvedOwnerId === candidateOwnerId` だけだと両方 null のとき true になり、
      // (a) updateMany が id:null で実行されてしまう
      // (b) recordCorporateDecision が reuse 側と create 側の二重で呼ばれてしまう
      // 上記 2 件の Codex P1/P2 を防ぐため、両方 non-null かつ等しいことを要求する。
      const reusedExistingOwner =
        resolvedOwnerId !== null &&
        candidateOwnerId !== null &&
        resolvedOwnerId === candidateOwnerId;

      // reuse 成功時のみ既存 corporateNumber と比較、それ以外は existing=null として計算。
      const cnDecision = decide(
        { name: ownerInfo.name, address: ownerInfo.address ?? null },
        reusedExistingOwner ? candidateCorporateNumber : null,
      );

      // reuse 成功時: 既存 owner が corporateNumber 空ならここで埋める。
      // where 条件で corporateNumber: null を要求し、race 時は count=0 で自動上書きを防ぐ。
      if (reusedExistingOwner && cnDecision.action === "save" && cnDecision.corporateNumber) {
        const cnFilled = await fillOwnerCorporateNumberIfUnlocked(
          candidateOwnerId!,
          cnDecision.corporateNumber,
          // まとめる場合は開いているtxで実行する(新しく開くと固まる)
          asOneBatch ? db : undefined,
        );
        if (cnFilled.locked) {
          markOwnerCorporateFillSkipped();
          recordCorporateDecision({ action: "noop", corporateNumber: null });
        } else {
          recordCorporateDecision(
            cnFilled.count === 0 ? { action: "noop", corporateNumber: null } : cnDecision,
          );
        }
      } else if (reusedExistingOwner) {
        // reuse 成功 + save 以外（noop / multi / conflict / none） → そのまま集計
        recordCorporateDecision(cnDecision);
      }

      if (!resolvedOwnerId) {
        // 新規 Owner 作成 + link（dedup ヒットなし、または archive race で fallback）。
        // 新規 owner は他 tx から見えないため archive 競合はない。
        // archive race fallback の場合も「新規 owner なので existing=null」で再評価する。
        const cnDecisionForCreate =
          candidateOwnerId === null
            ? cnDecision
            : decide(
                { name: ownerInfo.name, address: ownerInfo.address ?? null },
                null,
              );
        // ⚠**作成と紐付けを同じトランザクションで行う**。分けると、作成が確定した
        //   あとに紐付け側の見直しで中断したとき、**どこにも紐付かない所有者**が残る。
        //   あわせて、ロックを取ったあとに**もう一度**同じ人を探す(同時に走った
        //   もう一方が先に作っていれば、それを使って二重作成を避ける)。
        const ownerIdsBefore = [...linkedByThisRun];
        let resolved: { id: string; created: boolean; linked: boolean };
        try {
          resolved = await withTx(async (tx) => {
            // ⚠**再探索と所有者の行の押さえは、物件行を押さえる前に行う**(順序
            //   「Owner → 物件」)。所有者を紐づける他の窓口(/api/properties/[id]/owners)も
            //   この順で押さえるため、逆順にすると互いに待ち合って片方が中断される。
            //   ⚠まとめる経路では物件行を先に押さえてしまっているので、ここで新たに
            //     押さえてよいのは**既に自分が握っている行だけ**(canReuseOwner)。
            let ownerId: string | null = null;
            if (ownerInfo.address) {
              const normName = normalizeName(ownerInfo.name);
              const normAddr = normalizeAddress(ownerInfo.address);
              const rows = await tx.owner.findMany({
                where: { address: { not: null }, isArchived: false },
                select: { id: true, name: true, address: true, isArchived: true },
              });
              const raced = rows.find(
                (c) =>
                  // ⚠さっき使えないと判断した候補は拾い直さない(同時にアーカイブ
                  //   された候補に紐づけ直してしまうため)。
                  c.id !== candidateOwnerId &&
                  canReuseOwner(c.id) &&
                  !c.isArchived &&
                  normalizeName(c.name) === normName &&
                  normalizeAddress(c.address!) === normAddr,
              );
              if (raced) {
                // ⚠通常の再利用の経路と同じく、「アーカイブされていない」条件で
                //   行を押さえてから使う。押さえられなければ(その瞬間にアーカイブ
                //   された)、新規作成に回す。
                const held = await tx.owner.updateMany({
                  where: { id: raced.id, isArchived: false },
                  data: { updatedAt: new Date() },
                });
                if (held.count > 0) ownerId = raced.id;
              }
            }

            await lockProperty(tx);
            await assertStillEmpty(tx);

            const isNew = ownerId === null;
            if (ownerId === null) {
              const row = await tx.owner.create({
                data: {
                  name: ownerInfo.name,
                  ...(ownerInfo.address ? { address: ownerInfo.address } : {}),
                  // Phase D: 候補 1 件のみ採用、複数 / 競合は乗せない
                  ...(cnDecisionForCreate.action === "save" && cnDecisionForCreate.corporateNumber
                    ? { corporateNumber: cnDecisionForCreate.corporateNumber }
                    : {}),
                },
                select: { id: true },
              });
              ownerId = row.id;
            }

            const existingLink = await tx.propertyOwner.findFirst({
              where: { propertyId, ownerId },
            });
            let linked = false;
            if (!existingLink) {
              linkedByThisRun.push(ownerId);
              await tx.propertyOwner.create({
                data: {
                  propertyId,
                  ownerId,
                  relationship: ownerInfo.share ? "共有者" : "所有者",
                },
              });
              linked = true;
            }
            return { id: ownerId, created: isNew, linked };
          });
        } catch (err) {
          // ⚠tx ごと巻き戻るので、この実行で積んだ ownerId も元に戻す。
          linkedByThisRun.length = 0;
          linkedByThisRun.push(...ownerIdsBefore);
          // ⚠まとめる場合は握りつぶさない(1つのtxの中で失敗を握って続けられない)。
          if (asOneBatch) throw err;
          // Codex P2: 新規 owner は一意な ID のため通常 link 衝突しないが、防御的に
          // P2002 を握って冪等化する(相手が先に link 済みなら既存扱い)。
          if (!isUniqueConstraintError(err)) throw err;
          continue;
        }

        resolvedOwnerId = resolved.id;
        if (resolved.created) {
          createdCount++;
          recordCorporateDecision(cnDecisionForCreate);
        } else {
          matchedCount++;
        }
        if (resolved.linked) linkedCount++;
      }
    }
  };

  if (asOneBatch) {
    // ⚠全員ぶんを1つのトランザクションで。途中で失敗したら全部取り消す
    //   (1人目だけ入って、やり直しもできない状態を作らない)。
    //   所有者ごとに全Ownerを走査するので、既定の5秒では足りないことがある。
    //
    // ロックの順序は applyAll の冒頭で候補の所有者を先に押さえることで
    // 「Owner → 物件」にそろえている(他の窓口と同じ順)。
    await prisma.$transaction(
      async (tx) => {
        await applyAll(tx as DbClient);
        // 呼び出し元の記録を、所有者と一緒に確定させる(→ ProcessRegistryPdfArgs.beforeCommit)
        await args.beforeCommit?.(tx as DbClient, { linked: linkedCount });
      },
      {
        timeout: 30_000,
        maxWait: 10_000,
      },
    );
  } else {
    await applyAll(prisma as unknown as DbClient);
  }

  return { matched: matchedCount, created: createdCount, linked: linkedCount };
}

/**
 * 謄本PDF取込の中核処理。route.ts の認証・入力受け口を除いた残り全部。
 * 戻り値は API レスポンス body（呼び出し側が apiResponse(result, 201) で返す）。
 * ハードエラーは ApiError / Prisma 例外を throw し、呼び出し側 catch → handleApiError へ。
 */
export async function processRegistryPdf(
  args: ProcessRegistryPdfArgs,
): Promise<Record<string, unknown>> {
  const { session, text, propertyId, fileName, edited, pdfBuffer } = args;

  // ⚠**全部事項(all)は所有者を反映しない**。抹消された旧所有者を現在の所有者として
  // 登録する事故を防ぐ安全既定(所有者事項=owner・手動取込=undefined は従来どおり反映)。
  const reflectOwners = args.certificateType !== "all";

  // Parse the registry text（UI 編集値があれば再 parse より優先してマージ）
  const parsed = applyEditedToParsed(parseRegistryText(text), edited);
  /**
   * 取込の記録の行に残す、読み取った物件の項目。
   * ⚠所有者だけを入れる経路(ownersOnly)では**残さない**。読み取りは物件の所在が
   *   読めないと、最初に出てきた都道府県つきの行(=所有者の住所のことがある)を
   *   「住所」として拾うため、取込の履歴から所有者の住所が見えてしまう
   *   (@codex 第6R P1)。この経路は物件の項目を書かないので、記録にも要らない。
   */
  const recordedParsed = args.ownersOnly
    ? { address: null, realEstateNumber: null, lotNumber: null, buildingNumber: null }
    : {
        address: parsed.address,
        realEstateNumber: parsed.realEstateNumber,
        lotNumber: parsed.lotNumber,
        buildingNumber: parsed.buildingNumber,
      };

  // Create import job record
  const job = await prisma.importJob.create({
    data: {
      jobType: "property_pdf",
      fileName: fileName,
      status: "processing",
      totalRows: 1,
      executedBy: session.id,
      startedAt: new Date(),
    },
  });

  let resultAction: "created" | "updated" | "matched" = "matched";
  let targetPropertyId: string | null = null;
  // Phase D: 法人番号自動検出のサマリ + 行 errorMessage 集約
  const corporateSummary = emptyCorporateImportSummary();
  let rowCorporateMessage: string | null = null;
  const recordCorporateDecision = (decision: CorporateImportDecision) => {
    tallyCorporateDecision(corporateSummary, decision);
    const msg = corporateImportMessage(decision);
    if (msg) {
      rowCorporateMessage = appendImportMessage(rowCorporateMessage, msg);
    }
  };
  // A-2c: owner 反映件数（非PII）。Mode A/B 共通関数の返り値を集計する。
  let ownersMatched = 0;
  let ownersCreated = 0;
  let ownersLinked = 0;
  // A-2c: Mode B で field_staff スコープにより owner 反映をスキップしたフラグ。
  let ownerScopeSkipped = false;
  // PR#88: Mode B で弱い住所一致のため owner 反映をスキップしたフラグ。
  let ownerWeakMatchSkipped = false;
  // D10: 編集中の鍵のため、物件の空欄補完(地番・家屋番号・不動産番号)/所有者の法人番号
  // 補完を見送ったフラグ。実際に埋まるはずだった欄があるときだけ true にする(@codex R10 P2)。
  let propertyFillSkippedByEditLock = false;
  let ownerCorporateFillSkippedByEditLock = false;
  const markOwnerCorporateFillSkipped = () => {
    ownerCorporateFillSkippedByEditLock = true;
  };
  // 失敗理由（silent fail-through 用と、catch ブロックでの recovery 用）。
  // null のままなら成功扱い。
  let failureReason: string | null = null;

  try {
    if (propertyId) {
      // ---- Mode A: Update existing property ----
      const existing = await prisma.property.findUnique({
        where: { id: propertyId },
      });

      if (!existing) {
        throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
      }

      // field_staff スコープ: 担当外/未作成の物件を propertyId 直指定で更新させない。
      // admin / office_staff は全件可。UI だけでなく API 直アクセスもここで遮断する。
      if (!canAccessPropertyRecord(session, existing)) {
        throw new ApiError(403, "この物件にアクセスする権限がありません", "FORBIDDEN");
      }

      // D10: 空欄補完(realEstateNumber/lotNumber/buildingNumber)は「編集中の鍵」が
      // あれば見送る。⚠**registryStatus の unconfirmed→obtained だけは鍵の間も必ず
      // 進める**(@codex R6 P1)。PDFが添付されるのに未確認のまま残るほうが害が大きい
      // ためのD10の例外。確認(鍵の有無)と書き込みは同じトランザクション・同じ物件行
      // ロックの中で行う(順序: トランザクション開始→行ロック→鍵の確認→条件つき更新)。
      // ⚠ownersOnly の呼び出し元(添付済み謄本からの反映)は、物件の項目に触らない。
      //   下見でも確認画面でも所有者しか見せていないのに、見ていない項目が黙って
      //   変わるのは筋が通らない。とくに**不動産番号が入るとその物件は謄本の
      //   所在検索が使えなくなる**(「不動産番号は今後も作らない」という方針に反する)。
      const wouldFillProperty =
        !args.ownersOnly &&
        ((!existing.realEstateNumber && !!parsed.realEstateNumber) ||
          (!existing.lotNumber && !!parsed.lotNumber) ||
          (!existing.buildingNumber && !!parsed.buildingNumber));
      const wouldAdvanceStatus =
        !args.ownersOnly && existing.registryStatus === "unconfirmed" && !!parsed.realEstateNumber;

      // ⚠**何も書く見込みが無ければ、鍵の確認自体をしない**(行ロックを取らない)。
      // 埋める欄も進める状態も無ければ、鍵の有無に関わらず結果は変わらない。
      // (毎回の取込のたびに無条件で行ロックを取ると、実質 no-op の再取込でも
      //  他の編集を待たせてしまう。既存の挙動(条件が無ければ何もしない)も保つ。)
      // ⚠**recordChanges の oldValues もトランザクション内で読み直した値
      // (fresh)から作る**(レビュー round1 #2 の再点検 M1)。newValues(merged)は
      // fresh 基準で組み立てているのに、oldValues だけ外側の stale な `existing`
      // を使うと、鍵の持ち主がロック取得までの間にその項目を変えていた場合、
      // 変更履歴の「変更前」が実際の変更前と食い違う。
      type PropertyTxResult = {
        merged: Record<string, unknown>;
        fresh: Record<string, unknown> | null;
      };
      const { merged: updates, fresh: freshForChangeLog }: PropertyTxResult =
        wouldFillProperty || wouldAdvanceStatus
          ? await prisma.$transaction(async (tx) => {
              await lockPropertyRow(tx, propertyId);

              // ⚠**バージョン/現在値は行ロックの後に読み直す**(レビュー round1 #2)。
              // 外側で読んだ `existing` は、行ロックを取るまでの間に鍵の持ち主が
              // 保存していれば既に古い。古い version のまま where 条件に使うと
              // updateMany が0件になり、実際には何も書けていないのに merged を
              // 非空のまま返して recordChanges に「書いたことになっている」嘘の
              // 記録を残してしまう(取得状況の前進を保証するはずが、ここで抜ける)。
              // ⚠この `select` は `merged`(= statusUpdates + fieldUpdates)に入りうる
              //   キーを**すべて**含めること。`fresh` はそのまま `recordChanges` の
              //   `oldValues`(freshForChangeLog)としても使われるため、ここに無い
              //   キーを `merged` に足すと、そのキーの「変更前」が undefined のまま
              //   変更履歴に記録される(=空の "before" で残る)。新しい項目の
              //   補完/前進をこの関数に足すときは、まずここに列を足すこと
              //   (Task 7レビュー Minor 9・持ち越し)。
              const fresh = await tx.property.findUnique({
                where: { id: propertyId },
                select: {
                  version: true,
                  registryStatus: true,
                  realEstateNumber: true,
                  lotNumber: true,
                  buildingNumber: true,
                },
              });
              // ロック直後に取れない=行ロックとfindUniqueの間で削除された。
              // 何も書かず終える(既存の404判定は入口で既に済んでいる)。
              if (!fresh) return { merged: {}, fresh: null };

              const propertyLocked = await isResourceEditLocked(tx, {
                resourceType: "property",
                resourceId: propertyId,
              });

              // 以降の判定は全て fresh(読み直した現在値)基準にする。
              const freshWouldFillProperty =
                (!fresh.realEstateNumber && !!parsed.realEstateNumber) ||
                (!fresh.lotNumber && !!parsed.lotNumber) ||
                (!fresh.buildingNumber && !!parsed.buildingNumber);
              const freshWouldAdvanceStatus =
                fresh.registryStatus === "unconfirmed" && !!parsed.realEstateNumber;

              // (a) 取得状況の前進。鍵の有無に関わらず必ず実行する
              //     (@codex R6 P1・PDFが添付されるのに未確認のまま残るほうが害が大きい)。
              const statusUpdates: Record<string, unknown> = {};
              if (freshWouldAdvanceStatus) {
                statusUpdates.registryStatus = "obtained";
              }

              // (b) 3項目の補完。鍵が無いときだけ実行する。
              const fieldUpdates: Record<string, unknown> = {};
              if (!propertyLocked) {
                if (!fresh.realEstateNumber && parsed.realEstateNumber) {
                  fieldUpdates.realEstateNumber = parsed.realEstateNumber;
                }
                if (!fresh.lotNumber && parsed.lotNumber) {
                  fieldUpdates.lotNumber = parsed.lotNumber;
                }
                if (!fresh.buildingNumber && parsed.buildingNumber) {
                  fieldUpdates.buildingNumber = parsed.buildingNumber;
                }
              } else if (freshWouldFillProperty) {
                // 実際に埋まるはずだった欄があるときだけフラグを立てる(@codex R10 P2)。
                propertyFillSkippedByEditLock = true;
              }

              // 鍵が無いときは(a)(b)を1回の updateMany にまとめる。鍵があるときは
              // fieldUpdates が常に空なので、実質(a)だけの1回になる。
              const merged = { ...statusUpdates, ...fieldUpdates };
              if (Object.keys(merged).length === 0) return { merged: {}, fresh };

              const written = await tx.property.updateMany({
                where: { id: propertyId, version: fresh.version },
                data: { ...merged, version: { increment: 1 } },
              });
              // fresh 基準で条件を作ったので通常 count>0 のはずだが、findUnique と
              // updateMany の間でさらに割り込まれた場合は 0 件もあり得る。
              // その場合は「何も書けていない」を正直に返す(recordChanges へ
              // 嘘を渡さない)。
              return { merged: written.count > 0 ? merged : {}, fresh };
            })
          : { merged: {}, fresh: null };

      if (Object.keys(updates).length > 0) {
        await recordChanges({
          targetTable: "properties",
          targetId: propertyId,
          changedBy: session.id,
          // ⚠oldValues はトランザクション内で読み直した fresh を使う(上記コメント)。
          // updates が非空の時点で fresh は必ず non-null(空を返す全経路は
          // merged も空にしている)。
          oldValues: (freshForChangeLog ?? existing) as unknown as Record<string, unknown>,
          newValues: updates,
          trackedFields: PROPERTY_TRACKED_FIELDS,
          source: "pdf_import",
        });

        resultAction = "updated";
      }

      targetPropertyId = propertyId;

      // A-2c: owner 反映を Mode A/B 共通関数へ委譲（挙動は従来の Mode A と同一）。
      // Mode A は L239 で canAccessPropertyRecord による 403 を通過済みのため、
      // ここに到達する時点でアクセス権は確認済み。
      // ⚠全部事項(all)は所有者を反映しない（旧所有者混入の防止・上記）。
      if (reflectOwners) {
        const modeAOwners = await reflectParsedOwners({
          propertyId,
          requireNoExistingOwners: args.requireNoExistingOwners,
          skipCorporateNumber: args.ownersOnly,
          scopedSession: args.enforcePropertyScope ? session : undefined,
          beforeFirstWrite: args.beforeFirstWrite,
          beforeCommit: args.beforeCommit,
          owners: parsed.owners,
          recordCorporateDecision,
          markOwnerCorporateFillSkipped,
        });
        ownersMatched = modeAOwners.matched;
        ownersCreated = modeAOwners.created;
        ownersLinked = modeAOwners.linked;
      }
    } else {
      // ---- Mode B: Try to match or create new ----
      let matchedProperty = null;
      // PR#88: owner 反映は「強い/決定的な物件一致」のときのみ許可する。
      //  - realEstateNumber 一致（一意性が高い）
      //  - 正規化住所の完全一致
      //  - 新規 Property 作成
      // address contains の部分一致 fallback は弱い一致のため owner を反映しない
      // （誤った物件に Owner/PropertyOwner を恒久紐づけしないため）。取込本体の物件
      // match 挙動自体は従来どおり維持し、owner 反映だけを skip する。
      let canReflectOwners = false;

      if (parsed.realEstateNumber) {
        matchedProperty = await prisma.property.findFirst({
          where: { realEstateNumber: parsed.realEstateNumber },
          select: { id: true, address: true, realEstateNumber: true },
        });
        if (matchedProperty) {
          // realEstateNumber 一致は決定的とみなす。
          canReflectOwners = true;
        }
      }

      if (!matchedProperty && parsed.address) {
        matchedProperty = await prisma.property.findFirst({
          where: { address: { contains: parsed.address } },
          select: { id: true, address: true, realEstateNumber: true },
        });
        if (matchedProperty) {
          // 正規化住所が完全一致する場合のみ決定的とみなす。contains による部分一致
          // （完全一致でない）は弱い fallback なので owner 反映を許可しない。
          canReflectOwners =
            matchedProperty.address != null &&
            normalizeAddress(matchedProperty.address) === normalizeAddress(parsed.address);
        }
      }

      if (matchedProperty) {
        targetPropertyId = matchedProperty.id;
        resultAction = "matched";
      } else if (parsed.address) {
        // Create new property
        const newProp = await prisma.property.create({
          data: {
            address: parsed.address,
            lotNumber: parsed.lotNumber,
            buildingNumber: parsed.buildingNumber,
            realEstateNumber: parsed.realEstateNumber,
            propertyType: parsed.buildingNumber ? "building" : "land",
            registryStatus: parsed.realEstateNumber ? "obtained" : "unconfirmed",
            dmStatus: "hold",
            createdBy: session.id,
          },
        });
        targetPropertyId = newProp.id;
        resultAction = "created";
        // 新規作成した物件は自分が createdBy なので owner 反映可。
        canReflectOwners = true;
      }

      // A-2c: Mode B でも owner を反映する（targetPropertyId 確定後）。
      // PR#88: ただし強い/決定的な物件一致(canReflectOwners)のときのみ。弱い住所部分
      // 一致は誤紐づけ防止のため反映せず skip + warning（取込本体 matched は成功維持）。
      // field_staff スコープ: 反映する場合は担当外/作成外の物件には反映しない
      // （A-2b Attachment と同じく skip + warning）。created は createdBy=session.id の
      // ため常にアクセス可。owner 反映が例外を投げた場合は Mode A と同じく innerErr
      // catch に伝播し job failed になる（ハード失敗。best-effort warning ではない）。
      // owners が無ければ書き込み対象が無いため反映関連はすべてスキップする。
      // ⚠全部事項(all)は所有者を反映しない（旧所有者混入の防止・上記）。
      if (reflectOwners && targetPropertyId && parsed.owners.length > 0) {
        if (!canReflectOwners) {
          // 弱い住所 fallback で物件を特定 → owner 反映しない（取込本体は維持）。
          ownerWeakMatchSkipped = true;
        } else {
          const targetProp = await prisma.property.findUnique({
            where: { id: targetPropertyId },
            select: { createdBy: true, assignedTo: true },
          });
          if (!targetProp || !canAccessPropertyRecord(session, targetProp)) {
            ownerScopeSkipped = true;
          } else {
            const modeBOwners = await reflectParsedOwners({
              propertyId: targetPropertyId,
              requireNoExistingOwners: args.requireNoExistingOwners,
              skipCorporateNumber: args.ownersOnly,
              scopedSession: args.enforcePropertyScope ? session : undefined,
              beforeFirstWrite: args.beforeFirstWrite,
              beforeCommit: args.beforeCommit,
              owners: parsed.owners,
              recordCorporateDecision,
              markOwnerCorporateFillSkipped,
            });
            ownersMatched = modeBOwners.matched;
            ownersCreated = modeBOwners.created;
            ownersLinked = modeBOwners.linked;
          }
        }
      }
    }

    // Silent fail-through 検出: ジョブは作成済みだが
    //  Mode A/B のどちらでも targetPropertyId が立たなかった = 物件操作なし。
    // これまでは status="completed" / errorCount=1 のまま行を残さず返していたが、
    // status="failed" + ImportJobRow(error) を残し、詳細画面で原因を追えるようにする。
    if (!targetPropertyId) {
      failureReason = !parsed.address
        ? "PDFから住所を抽出できませんでした。OCRに失敗したか、想定外のフォーマットの可能性があります。"
        : "PDFから抽出した内容では既存物件と一致せず、新規作成にも至りませんでした。";
    }
  } catch (innerErr) {
    // ジョブ作成後に発生したエラー (Mode A の NOT_FOUND / Prisma 例外 等)。
    // ImportJob を "failed" で finalize し、ImportJobRow も error で1件残す。
    // 失敗の詳細は元のエラーから取り出して errorMessage に格納する。
    failureReason = args.sanitizeFailureDetails
      ? // ⚠この経路は生のエラー文を残さない(登記由来の住所を含みうる)
        `取込中にエラーが発生しました (${safeErrorSummary(innerErr)})`
      : innerErr instanceof Error
        ? innerErr.message
        : "PDF取込中に不明なエラーが発生しました";

    // ベストエフォートで finalize。recovery 自体が失敗しても元のエラーを優先する。
    try {
      await prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          successCount: 0,
          errorCount: 1,
          completedAt: new Date(),
        },
      });
      await prisma.importJobRow.create({
        data: {
          jobId: job.id,
          rowNumber: 1,
          status: "error",
          rawData: {
            fileName,
            reason: failureReason,
            extractedAddress: recordedParsed.address ?? null,
            extractedRealEstateNumber: recordedParsed.realEstateNumber ?? null,
            targetPropertyId,
            ...buildErrorRawDataExtras(failureReason, null),
          },
          errorMessage: failureReason,
          createdId: null,
        },
      });
    } catch {
      // finalize 失敗はサイレント（元のエラーを下で再 throw）
    }

    // 元のエラーを再 throw して handleApiError に正規の HTTP ステータスを返させる
    throw innerErr;
  }

  // ---- Finalize: success / silent-fail で分岐 ----
  if (failureReason) {
    // Path 3: silent fail-through。API 自体は 201 を返しつつ、ジョブとしては
    // failed + error 行で記録する。propertyId は null。
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        successCount: 0,
        errorCount: 1,
        completedAt: new Date(),
      },
    });
    await prisma.importJobRow.create({
      data: {
        jobId: job.id,
        rowNumber: 1,
        status: "error",
        rawData: {
          fileName,
          reason: failureReason,
          extractedAddress: recordedParsed.address ?? null,
          extractedRealEstateNumber: recordedParsed.realEstateNumber ?? null,
          targetPropertyId: null,
          ...buildErrorRawDataExtras(failureReason, null),
        },
        errorMessage: failureReason,
        createdId: null,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "pdf_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        jobId: job.id,
        action: "failed",
        reason: failureReason,
        confidence: parsed.confidence,
        fileName: fileName,
      },
    });

    return {
      jobId: job.id,
      action: resultAction,
      propertyId: null,
      parsed,
    };
  }

  // 成功パス（既存動作）
  // ⚠ここから先は**所有者の登録が既に確定している**。取込ジョブの記録が
  //   失敗しても、それをエラー応答にしてはいけない(実際には入っているのに
  //   「失敗」と伝わり、やり直すと「既に所有者がいる」で弾かれる)。
  //   記録の失敗はログに残して、応答は成功のまま返す。
  const bookkeeping = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      // ⚠**生のエラー文は出さない**。Prisma の検証エラーは拒否した呼び出しのデータ
      //   (rawData の住所など)を message に埋め込む。出してよいのは許可リストの
      //   「エラーの種類(クラス名)」と「コード(英数字)」だけ。ジョブIDと種別は非PII。
      const kind = err instanceof Error ? err.name : typeof err;
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code =
        typeof rawCode === "string" && /^[A-Za-z0-9_]{1,32}$/.test(rawCode) ? rawCode : "-";
      console.error(
        `[registry-pdf] 取込ジョブの記録に失敗(${label}) jobId=${job.id} kind=${kind} code=${code}`,
      );
    }
  };

  await bookkeeping("job-completed", () =>
    prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        successCount: 1,
        errorCount: 0,
        completedAt: new Date(),
      },
    }),
  );

  await bookkeeping("job-row", () =>
    prisma.importJobRow.create({
      data: {
        jobId: job.id,
        rowNumber: 1,
        status: "success",
        rawData: {
          realEstateNumber: recordedParsed.realEstateNumber,
          address: recordedParsed.address,
          lotNumber: recordedParsed.lotNumber,
          buildingNumber: recordedParsed.buildingNumber,
          // PR#88: owner 名(PII)は rawData に残さない。件数のみ保持する。
          ownerCount: parsed.owners.length,
          // A-2c: owner 反映の非PII件数（名前・住所は載せない）。
          ownersMatched,
          ownersCreated,
          ownersLinked,
        },
        // Phase D: 法人番号スキップ情報のみ追記（生値・会社名・住所は含めない）。
        errorMessage: appendImportMessage(null, rowCorporateMessage),
        createdId: targetPropertyId,
      },
    }),
  );

  // A-2b: 謄本PDF本体を Attachment(type="registry") として保存する。
  //  - multipart(PDF binary) のみ。text 貼り付けは pdfBuffer=null でスキップ。
  //  - Mode A/B 問わず targetPropertyId 確定後（このパスでは必ず非 null）に保存。
  //  - 保存失敗は取込本体を失敗扱いにせず warning として返す（部分成功）。
  //  - audit/レスポンスに載せるのは attachmentId（UUID）のみ。
  //    fileUrl 全文・PDF 本文・抽出テキスト・所有者名・住所は載せない。
  let attachmentId: string | null = null;
  let attachmentWarning: string | null = null;
  if (pdfBuffer && targetPropertyId) {
    // P1: Attachment を書き込む直前に、対象 property へのアクセス権を必ず確認する。
    // Mode B は地番/住所マッチで既存物件に targetPropertyId が決まり得るため、
    // Mode A と同じ field_staff スコープ（canAccessPropertyRecord）をここでも適用し、
    // 担当外/作成外の物件に PDF を添付させない（attachments endpoint と同等の制御）。
    // admin / office_staff は従来どおり全件許可。
    const target = await prisma.property.findUnique({
      where: { id: targetPropertyId },
      select: { createdBy: true, assignedTo: true },
    });
    if (!target || !canAccessPropertyRecord(session, target)) {
      // 権限が無い対象には upload も attachment.create も実行しない（最優先要件）。
      // 取込本体（matched/created）は既存仕様どおり成功扱いのまま warning を返す。
      attachmentWarning = "対象物件へのアクセス権が無いため、謄本PDFは保存されませんでした。";
    } else {
      // upload 成功後に attachment.create が失敗した場合、storage 上に孤児 PDF が
      // 残らないよう uploaded.key を保持し、catch で best-effort 削除する。
      let uploadedKey: string | null = null;
      try {
        const validationError = validateFile(
          pdfBuffer.length,
          "application/pdf",
          ALLOWED_ATTACHMENT_MIMES,
        );
        if (validationError) {
          throw new Error(validationError);
        }
        // key を一意化する（Codex P2）。Date.now() だけだと同一ミリ秒の
        // 並行取込で衝突し、後続 PDF が同一 key を上書きして複数 Attachment が
        // 同じ実体を指す恐れがあるため、randomUUID を suffix に付与する。
        const key = `properties/${targetPropertyId}/registry/${Date.now()}-${randomUUID()}.pdf`;
        const uploaded = await getStorage().upload(pdfBuffer, {
          key,
          mimeType: "application/pdf",
          fileName,
        });
        uploadedKey = uploaded.key;
        // ⚠**親の物件行をロックしてから作る**(@codex #399 R7 P2 → #402)。
        //   有料取得の二重課金ガード(duplicate-guard)は購入ロックの where で
        //   「謄本PDFが無いこと」を検査する。ロック無しの単独 create だと、
        //   **作成が確定する直前のミリ秒**に検査が通り二重課金の余地が残る。
        //   ストレージへの保存は上(ロック外)で完了済み=ロックは作成の一瞬だけ。
        //   順序は常に**親→子**(デッドロック回避・書き込み規約 #364)。
        const attachment = await prisma.$transaction(async (tx) => {
          await lockPropertyRow(tx, targetPropertyId);
          return tx.attachment.create({
            data: {
              targetType: "property",
              targetId: targetPropertyId,
              propertyId: targetPropertyId,
              type: "registry",
              // 有料取得の種別（owner|all）。手動取込(undefined)は null=種別不明のまま。
              registryCertificateType: args.certificateType ?? null,
              fileName,
              fileUrl: uploaded.url,
              fileSize: pdfBuffer.length,
              mimeType: "application/pdf",
              uploadedBy: session.id,
            },
            select: { id: true },
          });
        });
        attachmentId = attachment.id;
      } catch (err) {
        // 取込本体は成功扱いのまま継続し、保存失敗のみ warning として返す。
        console.error("Failed to save registry PDF attachment:", err);
        // upload は成功したが attachment.create 等で失敗した場合、謄本=機微ファイルが
        // Attachment row 無しで storage に残ると通常の削除/cleanup から到達できない
        // 孤児ファイルになる。best-effort で削除する（upload 自体が失敗した場合は
        // uploadedKey=null のため削除対象なし）。
        if (uploadedKey) {
          try {
            await getStorage().delete(uploadedKey);
          } catch (delErr) {
            // 削除失敗でも取込本体は失敗させない（記録のみ）。
            console.error("Failed to delete orphaned registry PDF after attachment error:", delErr);
          }
        }
        attachmentWarning = "謄本は取込されましたが、PDF本体の保存に失敗しました。";
      }
    }
  }

  // A-2c: field_staff スコープで owner 反映をスキップした場合の warning を、
  // A-2b の attachment warning と合わせて 1 つの warning 文字列にまとめて返す
  // （両方発生し得るため。取込本体は成功扱いのまま）。
  const warningParts: string[] = [];
  if (ownerWeakMatchSkipped) {
    warningParts.push("住所の部分一致で物件を特定したため、所有者情報は反映されませんでした。");
  }
  if (ownerScopeSkipped) {
    warningParts.push("対象物件へのアクセス権が無いため、所有者情報は反映されませんでした。");
  }
  if (attachmentWarning) {
    warningParts.push(attachmentWarning);
  }
  const warning = warningParts.length > 0 ? warningParts.join(" ") : null;

  await writeAuditLog({
    userId: session.id,
    action: "pdf_import",
    targetTable: "properties",
    targetId: targetPropertyId ?? undefined,
    detail: {
      jobId: job.id,
      action: resultAction,
      confidence: parsed.confidence,
      fileName: fileName,
      // Phase D: 法人番号自動検出のサマリ。生値・会社名・住所・候補リストは含めない。
      corporateNumber: corporateSummary,
      // A-2c: owner 反映の非PII件数（名前・住所は載せない）。
      ownersMatched,
      ownersCreated,
      ownersLinked,
      // A-2b: 保存できた場合のみ attachmentId（UUID）を載せる。
      ...(attachmentId ? { attachmentId } : {}),
    },
  });

  return {
    jobId: job.id,
    action: resultAction,
    propertyId: targetPropertyId,
    parsed,
    // A-2c: owner 反映件数（非PII）。
    ownersMatched,
    ownersCreated,
    ownersLinked,
    // A-2b: 保存成功時は attachmentId。owner反映/PDF保存のスキップは warning。
    ...(attachmentId ? { attachmentId } : {}),
    ...(warning ? { warning } : {}),
    // D10: 編集中の鍵のため見送った補完(取込画面の警告・自動取得の監査detailで使う)。
    propertyFillSkippedByEditLock,
    ownerCorporateFillSkippedByEditLock,
  };
}
