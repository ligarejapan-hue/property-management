import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { createOwnerSchema } from "@/lib/validators";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isPdfBuffer } from "@/lib/pdf-extract";
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES, MAX_FILE_SIZE } from "@/lib/storage";
import {
  assertImportJsonBodySize,
  assertImportMultipartBodySize,
} from "@/lib/import-body-size";
import { PROPERTY_TYPE_VALUES, OCCUPANCY_STATUS_LABELS } from "@/lib/property-types";
import { toHalfWidth, toFullWidth } from "@/lib/paste-import/normalize";
import {
  normalizeBuildingName,
  normalizeUnitOnlyFields,
  BUILDING_NAME_MAX_LENGTH,
  BUILDING_NAME_TOO_LONG_MESSAGE,
} from "@/lib/property-building-name";
import type { PropertyType, OccupancyStatus } from "@/generated/prisma";

// ---------------------------------------------------------------------------
// 入力の検査（全体レビュー I-3）
//
// ⚠確認画面の欄は**全部が自由入力**で、人がその場で直す前提の画面。生の文字列を
//   そのまま Prisma に渡すと、Prisma 側の例外が handleApiError で
//   「サーバーエラーが発生しました」(500) に化け、**どの欄が悪いのか誰にも
//   分からない**まま入力内容が失われる。ここで欄の名前つきで 400 を返す。
// ---------------------------------------------------------------------------

/**
 * 面積として受け付ける形。
 * ⚠**桁数まで見る**。列は `Decimal(8, 2)`＝整数部6桁・小数部2桁が上限。
 *   桁数を見ないと、見出しの取り違えで日付「20250815」が面積欄に入ったまま
 *   ここを通り、PostgreSQL 側があふれて **I-3 で消したはずの汎用500に戻る**。
 */
const AREA_PATTERN = /^\d{1,6}(\.\d{1,2})?$/;

const PROPERTY_TYPE_SET = new Set<string>(PROPERTY_TYPE_VALUES);
/** 現況(OccupancyStatus)の許容値。表示ラベルの定義元と同じ集合を使う。 */
const OCCUPANCY_STATUS_SET = new Set<string>(Object.keys(OCCUPANCY_STATUS_LABELS));

/** 面積の検査。空欄は null（未入力は誤りではない）。 */
function parseAreaInput(raw: string | null | undefined, fieldLabel: string): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (!AREA_PATTERN.test(v)) {
    throw new ApiError(
      400,
      `${fieldLabel}は数字だけで入力してください（例: 70 または 70.5）。単位や「約」は入れず、整数6桁・小数2桁までにしてください`,
      "BAD_REQUEST",
    );
  }
  return v;
}

// ---------- POST /api/import/paste/commit ----------
// 「貼り付けて物件化」の確認画面で人が直した最終値を受け取り、物件・所有者・
// 紐付け・(あれば)添付を1つのトランザクションで確定する。
//
// リクエスト形式:
//   application/json    → CommitBody のみ(PDF なし)
//   multipart/form-data → data: CommitBody を JSON 文字列で・file: PDF(任意)
//                          (取込元の PDF をそのまま物件の添付として保存したい場合)
//
// ⚠この API は「貼った原文」を受け取らない・返さない・監査ログにも書かない。
//   確認画面は Task 7 の下書き(PasteDraft)を人が直した後の**確定値**だけを渡す。

interface CommitBody {
  property: {
    address: string;
    lotNumber: string | null;
    propertyType: string;
    buildingName: string | null;
    roomNo: string | null;
    exclusiveArea: string | null;
    layoutType: string | null;
    occupancyStatus: string | null;
    note: string | null;
  };
  owner: {
    name: string;
    nameKana: string | null;
    phone: string | null;
    email: string | null;
    currentAddress: string | null;
  } | null;
  externalLinkKey: string | null;
  /** 既存の所有者に紐付ける場合。指定があれば新規作成しない。 */
  linkExistingOwnerId?: string | null;
}

/**
 * JSON body の上限（この口専用）。
 * ⚠共有の既定値(64MB)は CSV/XLSX 取込の口に合わせた値で、**この口の実態とは
 *   桁が違う**(@codex PR#414 5巡目)。ここが受け取るのは確認画面で人が直した
 *   最終値だけ。ほとんどの欄は数十〜数百文字だが、**備考(note)は辞書に無かった
 *   見出しをまとめたもの**で、最悪 貼り付け全体(20万文字)に迫りうるため
 *   「数KB」にはできない。
 *   根拠: 20万文字 × 3バイト(日本語 UTF-8) = 600KB を実質の上限とみなし、
 *   異常な入力でも正規の登録を弾かない余裕を見て 2MB(下書き側の半分)。
 */
const MAX_COMMIT_JSON_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    // ⚠取込系 route は例外なく import:write を先に要求する（全体レビュー I-1）。
    //   src/app/api/import/** の他の全 route と同じ順序・同じ文言に揃える。
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    let body: CommitBody;
    let pdfBuffer: Buffer | null = null;
    let pdfFileName = "paste-import.pdf";

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      // ⚠formData() は**ボディ全体をメモリに読み込む**。読み込んだ後で file.size を
      //   見ても、巨大なリクエストでメモリを食い潰せる(@codex PR#414 2巡目 P1)。
      //   registry-pdf-bulk と同じく Content-Length を**先に**見る。
      assertImportMultipartBodySize(request, MAX_FILE_SIZE);
      const form = await request.formData();
      const dataRaw = form.get("data");
      if (typeof dataRaw !== "string") {
        throw new ApiError(400, "登録データがありません", "BAD_REQUEST");
      }
      try {
        body = JSON.parse(dataRaw) as CommitBody;
      } catch {
        throw new ApiError(400, "登録データが不正な JSON です", "BAD_REQUEST");
      }

      const file = form.get("file");
      if (file && typeof file !== "string") {
        // ⚠案内文言と実際の上限を二重管理しない。実効値は validateFile
        //   (@/lib/storage) が使う MAX_FILE_SIZE と同じ定数を直接参照する
        //   (Task 8 レビュー Minor: 10MBと案内しつつ実際は8MBで弾かれていた)。
        if (file.size > MAX_FILE_SIZE) {
          throw new ApiError(
            400,
            `PDFが大きすぎます(${MAX_FILE_SIZE / 1024 / 1024}MBまで)`,
            "BAD_REQUEST",
          );
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        if (!isPdfBuffer(buffer)) {
          throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
        }
        pdfBuffer = buffer;
        pdfFileName = file.name || pdfFileName;
      }
    } else {
      // ⚠request.json() でボディ全体をバッファする前に過大サイズを弾く
      //   (兄弟ルート /api/import/paste と同じ姿勢。Task 8 レビュー Important)。
      assertImportJsonBodySize(request, MAX_COMMIT_JSON_BODY_BYTES);
      body = (await request.json()) as CommitBody;
    }

    if (!body?.property?.address || body.property.address.trim() === "") {
      throw new ApiError(400, "住所がありません", "BAD_REQUEST");
    }
    const wantsOwner = Boolean(body.owner?.name || body.linkExistingOwnerId);
    if (wantsOwner && !hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者を作る権限がありません", "FORBIDDEN");
    }

    // ---- 項目ごとの書き込み権限（@codex PR#414 P1-1） ----
    // ⚠通常の所有者作成 (POST /api/owners) は、**値が入っている項目ごとに**
    //   owner_phone / owner_address / owner_email … の書き込み権限を
    //   hasExplicitWritePerm で確かめている。ここが素通しだと、管理者が
    //   「この担当者には電話を触らせない」と個別に設定していても
    //   **この画面からなら書けてしまう**（既存の制限の迂回路）。
    //   判定は自前で書かず、owners/route.ts と同じヘルパーを同じ形で使う。
    // ⚠owners 側は `value != null` で見るが、この route は値を
    //   `?.trim() || null` に畳んでから書く＝空文字は**何も書かない**。
    //   よって「空白を除いて中身がある」ものだけを対象にする（空欄で403にしない）。
    if (body.owner) {
      const ownerFieldWriteChecks: { value: string | null | undefined; resource: string; label: string }[] = [
        { value: body.owner.name, resource: "owner_name", label: "氏名" },
        { value: body.owner.nameKana, resource: "owner_name_kana", label: "フリガナ" },
        { value: body.owner.phone, resource: "owner_phone", label: "電話番号" },
        { value: body.owner.email, resource: "owner_email", label: "メールアドレス" },
        // ⚠現住所は登記上の住所と同じ機微度＝同じ権限で扱う(owners/route.ts と同じ)。
        { value: body.owner.currentAddress, resource: "owner_address", label: "現住所" },
      ];
      for (const { value, resource, label } of ownerFieldWriteChecks) {
        if ((value ?? "").trim() !== "" && !hasExplicitWritePerm(perms, resource)) {
          throw new ApiError(403, `${label}を書き込む権限がありません`, "FORBIDDEN");
        }
      }

      // ---- メールアドレスの形式（@codex PR#414 3巡目 P2） ----
      // ⚠通常の所有者作成 (createOwnerSchema) は形式を弾いている。ここが無検証だと
      //   **通常のAPIでは作れない所有者をこの経路からは作れて**しまい、DMの送信先
      //   として使えないデータが静かに入る。
      // ⚠自前の正規表現は書かない。**同じスキーマの同じ欄**をそのまま使い、
      //   文言も向こう側の定義から取る(片方だけ直る食い違いを作らない)。
      // ⚠空文字・null は今までどおり「未入力」として通す(必須にはしない)。
      const emailInput = (body.owner.email ?? "").trim();
      if (emailInput !== "") {
        const parsed = createOwnerSchema.shape.email.safeParse(emailInput);
        if (!parsed.success) {
          throw new ApiError(
            400,
            parsed.error.issues[0]?.message ?? "メールアドレスの形式が正しくありません",
            "BAD_REQUEST",
          );
        }
      }
    }
    if (pdfBuffer) {
      const validationError = validateFile(
        pdfBuffer.length,
        "application/pdf",
        ALLOWED_ATTACHMENT_MIMES,
      );
      if (validationError) {
        throw new ApiError(400, validationError, "INVALID_FILE");
      }
    }

    const p = body.property;

    // ---- 値の検査（全体レビュー I-3）。Prisma に渡す前に、欄の名前つきで断る ----
    const exclusiveArea = parseAreaInput(p.exclusiveArea, "専有面積");

    const propertyTypeInput = (p.propertyType ?? "").trim() || "unknown";
    if (!PROPERTY_TYPE_SET.has(propertyTypeInput)) {
      throw new ApiError(400, "物件種別が正しくありません。一覧から選び直してください", "BAD_REQUEST");
    }
    const propertyType = propertyTypeInput as PropertyType;

    const occupancyInput = (p.occupancyStatus ?? "").trim();
    if (occupancyInput !== "" && !OCCUPANCY_STATUS_SET.has(occupancyInput)) {
      throw new ApiError(400, "現況が正しくありません。一覧から選び直してください", "BAD_REQUEST");
    }
    const occupancyStatus = occupancyInput === "" ? null : (occupancyInput as OccupancyStatus);

    // ---- 物件名（建物名）（@codex PR#414 2巡目 P2） ----
    // ⚠**種別に合わないときは必ず null に落とす**。読み取った種別を人が土地や
    //   戸建に直すと画面から建物名の欄が消えるが、値は送られたままになる。
    //   保存すると**画面に出ないデータが DB に残り**、誰も直せないまま CSV 出力や
    //   DM 差込で初めて表に出る。判定は UI・通常の作成/更新と同じ純関数を通す
    //   (src/lib/property-building-name.ts。自前の判定を書かない)。
    // ⚠長さは「整えてから測って、超えていれば断る」(切り詰めない)。
    //   createPropertySchema と同じ上限・同じ文言。
    if ((p.buildingName ?? "").trim().length > BUILDING_NAME_MAX_LENGTH) {
      throw new ApiError(400, BUILDING_NAME_TOO_LONG_MESSAGE, "BAD_REQUEST");
    }
    const buildingName = normalizeBuildingName(propertyType, p.buildingName);

    // ---- 区分マンション専用の欄（@codex PR#414 10巡目） ----
    // ⚠**種別に合わない欄は null に落とす**。物件詳細はこれらを区分のときしか
    //   描かず、通常の編集画面(updatePropertySchema)にも無いので、
    //   種別を土地や戸建に直したのに保存されると**見えず直せないデータ**が残り、
    //   CSV 出力や DM 差込で初めて表に出る。
    // ⚠個別に3つ並べず、判定は1か所(normalizeUnitOnlyFields)に置く。
    //   区分専用の欄が増えたときは UNIT_ONLY_PROPERTY_FIELDS に足すだけで、
    //   この経路が自動的に守られる(走査テストで固定)。
    const unitOnly = normalizeUnitOnlyFields(propertyType, {
      roomNo: p.roomNo?.trim() || null,
      exclusiveArea,
      layoutType: p.layoutType?.trim() || null,
      occupancyStatus,
    });

    // 外部キー（査定ナンバー等）。
    // ⚠**ここで1回だけ正規化し、この先はすべてこの値を使う**
    //   （① 助言ロックの鍵 ② 重複ガードの findFirst ③ property.create に保存する値）。
    //   ⚠ロックの鍵が比較に使う鍵と一致していなければ、鍵がずれた瞬間に直列化が
    //   外れ、二重登録のガードが静かに無効になる。ロックと比較は同じ値でなければ
    //   意味がない。保存する値まで揃えることで「保存した値 == 検索する値 ==
    //   ロックの鍵」が常に成立する。
    //   正規化は既存の toHalfWidth + 前後の空白除去だけ（新しい正規化は増やさない）。
    //   査定ナンバーは元々半角ASCIIなので、実際に保存される文字列は変わらない。
    //   ⚠この route は画面以外からも呼べるので、下書き側(build-draft.ts)で
    //   正規化済みでも**ここでも必ず通す**。
    const externalLinkKeyRaw = body.externalLinkKey ?? null;
    const externalLinkKey =
      externalLinkKeyRaw === null ? null : toHalfWidth(externalLinkKeyRaw).trim() || null;
    // ⚠**検索だけは全角形も見る**(@codex PR#414 2巡目 P2)。CSV取込
    //   (src/app/api/import/csv/route.ts) は externalLinkKey を**生値のまま**保存する
    //   ため、全角で入った既存行は正規化後の完全一致では見つからない。
    //   ⚠助言ロックの鍵は**正規化した値のまま**にする。自分たちが書く値は常に
    //   正規化されるので、直列化はそれで足りる(鍵を増やすと同じ案件が別の鍵で
    //   走り、直列化が外れる)。
    const externalLinkKeySearch =
      externalLinkKey === null
        ? null
        : Array.from(new Set([externalLinkKey, toFullWidth(externalLinkKey)]));
    // 既存の所有者へ紐付ける指定。空文字は「無い」と同じに畳む。
    const linkOwnerId = body.linkExistingOwnerId?.trim() || null;

    // PDF があるときだけ、物件 id を先に確定する。ストレージ保存(外部I/O)を
    // トランザクションの外で行うために、保存先キーへ埋め込む id が要る。
    // PDF が無ければ id は Prisma の既定(uuid)に任せる。
    const pregenPropertyId = pdfBuffer ? randomUUID() : null;

    // ⚠外部ストレージへの保存はトランザクションの外で行う(ロックを持つのは
    //   作成の一瞬だけ・attachment-create-parent-lock.test.ts のコメントと同じ型)。
    let uploadedUrl: string | null = null;
    // ⚠保存先の key を控える。トランザクションが失敗したら消すため
    //   (@codex PR#414 2巡目 P1・発注者判断で見送りを撤回)。
    let uploadedKey: string | null = null;
    if (pdfBuffer && pregenPropertyId) {
      const key = `properties/${pregenPropertyId}/paste-import/${Date.now()}-${randomUUID()}.pdf`;
      const uploaded = await getStorage().upload(pdfBuffer, {
        key,
        mimeType: "application/pdf",
        fileName: pdfFileName,
      });
      uploadedUrl = uploaded.url;
      // ⚠**要求した key ではなく、アダプタが返した最終的な保存先**を控える
      //   (@codex PR#414 4巡目)。server アダプタは実際に保存した key を返すため、
      //   要求と違う場所に保存された場合、要求した key で消しに行くと
      //   **存在しないパスを消して、実物のPDFは孤児のまま残る**。
      uploadedKey = uploaded.key;
    }

    // ⚠トランザクションが失敗したら、**先に保存した PDF を best-effort で消す**。
    //   放置すると Attachment 行を持たない孤児 PDF が storage に残る。孤児は
    //   自動お掃除(添付を辿る)の対象外なので**消えないまま溜まり続ける**うえ、
    //   中身は所有者の個人情報。容量の話ではなく個人情報の話なので見送れない。
    //   二重登録の 409 を新設したことで、この経路は普通に起きるようになった。
    // ⚠削除の失敗は握り潰す(登録の失敗を上書きして原因を隠さない)。
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // ---- 二重登録を**サーバー側で**止める（全体レビュー Critical 1） ----
        // ⚠これまで重複判定は下書き route (/api/import/paste) にしか無く、確定側は
        //   externalLinkKey を無検査で書いていた。Property.externalLinkKey は
        //   @@index であって @@unique ではないため、二重登録を防いでいたのは
        //   画面のボタンの disabled だけだった。同じ査定依頼を2人が貼る／確認画面を
        //   開いたまま同僚が先に登録する、のどちらでも 200 で通り、物件・所有者・
        //   お手紙・有料の謄本取得がもう一式できてしまう。
        //
        // ⚠advisory lock は**省略しない**。素の findFirst だけでは足りない:
        //   READ COMMITTED では、待っている間に別トランザクションが確定させた行は
        //   **先に開始した文からは見えない**（#402 で実測済み）。同じキーの確定を
        //   advisory lock で直列化し、ロックを取った**あとに**存在を確かめる。
        //   xact lock はトランザクション終了時に自動解放される
        //   (src/app/api/import/reception-property/route.ts と同じ型)。
        if (externalLinkKey) {
          // ⚠**$executeRaw + ::bigint**。$queryRaw にしてはいけない。
          //   本番は driver adapter 構成(src/lib/prisma.ts の PrismaPg)で、
          //   $queryRaw は返却列の型 OID を必ず変換する。pg_advisory_xact_lock の
          //   戻り型は void(OID 2278)で変換先が無く、UnsupportedNativeDataType を
          //   投げる = 査定ナンバーのある登録が毎回500になり、このガードは一度も
          //   働かない。$executeRaw は行を返さないので列型の変換を通らない。
          //   (prisma を丸ごとモックするテストでは原理的に検出できない種類の穴。
          //    リポジトリ内の唯一の前例 reception-property/route.ts と同じ形に揃える。)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${externalLinkKey})::bigint)`;
          const already = await tx.property.findFirst({
            where: { externalLinkKey: { in: externalLinkKeySearch }, isArchived: false },
            select: { id: true },
          });
          if (already) {
            throw new ApiError(409, "この案件は登録済みです", "DUPLICATE");
          }
        }

        // ---- 既存の所有者に紐付ける場合の確認（@codex PR#414 P1-2） ----
        // ⚠外部キー制約は「行が存在する」ことしか保証しない。アーカイブ済み
        //   （＝通常の検索から隠されている）所有者にも紐付けられてしまう。
        //   下書きを取ってから登録するまでの間にアーカイブされた場合も同じ。
        // ⚠既存の紐付けルート (POST /api/properties/[id]/owners) と**同じやり方**:
        //   トランザクション内で owner 行に updateMany を発行し isArchived=false を
        //   再確認しつつ PostgreSQL の行ロックを取る。archive 側の updateMany と
        //   競合したら片方が必ずロック待ちになり、後勝ち側が条件不一致で失敗する。
        // ⚠ロックの順序は **Owner → 物件親行 → 子行**（既存の書き込み規約）。
        //   この位置なら、後段の lockPropertyRow(添付用) より必ず先になる。
        //   物件を作る前に確かめるので、断ったときに無駄な行も作らない。
        if (linkOwnerId !== null) {
          const lockRes = await tx.owner.updateMany({
            where: { id: linkOwnerId, isArchived: false },
            data: { updatedAt: new Date() },
          });
          if (lockRes.count === 0) {
            throw new ApiError(
              409,
              "この所有者は使用できません（アーカイブ済み、または削除されています）",
              "OWNER_UNAVAILABLE",
            );
          }
        }

        const property = await tx.property.create({
          data: {
            ...(pregenPropertyId ? { id: pregenPropertyId } : {}),
            address: p.address.trim(),
            lotNumber: p.lotNumber?.trim() || null,
            buildingName,
            propertyType,
            // 区分専用の欄(部屋番号・専有面積・間取り・現況)。種別に合わなければ
            // すべて null になっている。⚠**この展開より後に同じ欄を書かない**
            // (書くと正規化を上書きしてしまう)。
            ...unitOnly,
            externalLinkKey,
            note: p.note?.trim() || null,
            introductionRoute: "web_inquiry",
            caseStatus: "new_case",
            registryStatus: "unconfirmed",
            dmStatus: "hold",
            createdBy: session.id,
          },
        });

        let ownerId: string | null = linkOwnerId;
        let ownerCreated = false;
        if (ownerId === null && body.owner?.name) {
          const owner = await tx.owner.create({
            data: {
              name: body.owner.name.trim(),
              nameKana: body.owner.nameKana?.trim() || null,
              phone: body.owner.phone?.trim() || null,
              email: body.owner.email?.trim() || null,
              // ⚠反響フォームの住所は本人の連絡先住所であり、登記上の住所とは
              //   限らない。address(登記上住所)は空のままにする(設計書 §7・
              //   発注者承認 2026-08-26)。address キー自体を書かない。
              currentAddress: body.owner.currentAddress?.trim() || null,
            },
          });
          ownerId = owner.id;
          ownerCreated = true;
        }

        if (ownerId !== null) {
          await tx.propertyOwner.create({
            data: { propertyId: property.id, ownerId },
          });
        }

        let attachmentId: string | null = null;
        if (pdfBuffer && uploadedUrl) {
          // ⚠添付は親の物件行を FOR UPDATE した同一tx内で作る(リポジトリ全体の
          //   規約。src/lib/__tests__/attachment-create-parent-lock.test.ts が
          //   走査で固定している)。この行は同じ tx で今作ったばかりで他 tx から
          //   はまだ見えないが、経路の型を全箇所で揃えるためロックは省略しない。
          await lockPropertyRow(tx, property.id);
          const attachment = await tx.attachment.create({
            data: {
              targetType: "property",
              targetId: property.id,
              propertyId: property.id,
              type: "general",
              fileName: pdfFileName,
              fileUrl: uploadedUrl,
              fileSize: pdfBuffer.length,
              mimeType: "application/pdf",
              uploadedBy: session.id,
            },
            select: { id: true },
          });
          attachmentId = attachment.id;
        }

        return { propertyId: property.id, ownerId, ownerCreated, attachmentId };
      });
    } catch (txError) {
      if (uploadedKey !== null) {
        try {
          await getStorage().delete(uploadedKey);
        } catch {
          // 消せなくても、登録が失敗したことのほうを利用者に返す。
        }
      }
      throw txError;
    }

    // ⚠監査ログに原文・氏名・電話・メール・住所を入れない。出してよいのは
    //   固定文字列と id・件数のみ(社内の恒久ルール「ログに外部由来の文字を
    //   出すときは許可リスト」)。
    await writeAuditLog({
      userId: session.id,
      action: "paste_import_property_create",
      // ⚠**"properties"（複数形）**。本番の audit_logs は properties が1,334件・
      //   property は0件で、単数形にすると管理画面で「物件」を絞ったときに
      //   **この機能の記録だけが漏れる**(@codex PR#414 4巡目)。
      targetTable: "properties",
      targetId: result.propertyId,
      detail: {
        ownerCreated: result.ownerCreated,
        ownerLinked: result.ownerId !== null,
        attachmentCreated: result.attachmentId !== null,
        hasExternalKey: externalLinkKey !== null,
      },
    });

    return apiResponse({ propertyId: result.propertyId, ownerId: result.ownerId });
  } catch (error) {
    return handleApiError(error);
  }
}
