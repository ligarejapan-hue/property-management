import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession, getUserPermissions, getOwnerDisplayConfig, handleApiError, ApiError, parseJsonBody,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockOwnersForShare, lockPropertiesForShare, type RawTx } from "@/lib/dm-batch/locks";
import { hasPermission } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import { buildPropertyListWhere, buildPropertyListOrderBy, propertyVisibilityScopeWhere } from "@/lib/property-list-query";
import { isPlainOwnerLevel, type DmRowPropertyOwner } from "@/lib/dm-export";
import { saleDmCampaignBodySchema } from "@/lib/validators-sale-dm";
import { buildRecipientsFromProperties, capRecipientsByProperty } from "@/lib/sale-dm-letter/recipients";
import { resolveSender, isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { generateLetters, isSaleDmConfigured, MAX_GENERATE_ITEMS, DEFAULT_CONCURRENCY, AI_CALL_TIMEOUT_MS, AI_MAX_RETRIES, resolveLetterModel, resolveProvider } from "@/lib/sale-dm-letter";
import { resolveTrackingBaseUrl, resolveLpUrl } from "@/lib/sale-dm-letter/tracking";
import { loadSaleDmConfig } from "@/lib/sale-dm-letter/config-store";
import { SaleDmError } from "@/lib/sale-dm-letter/types";
import { randomBytes } from "crypto";

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート(副作用なし)。dm-export と同一の4種。
    if (!hasPermission(permissions, "property", "read")) throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "csv_export", "read")) throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "csv_export_personal", "read")) throw new ApiError(403, "個人情報を含む出力の権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "owner", "read")) throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    // AI生成は課金 + オーナーPII を外部AIへ送るため、専用権限 sale_dm:generate を必須化(謄本自動取得と同方針)。
    // read系/CSV権限だけで誰でも有料生成を実行できないようにする(admin が明示付与する高リスク操作)。
    if (!hasPermission(permissions, "sale_dm", "generate")) throw new ApiError(403, "AIによるDM生成の権限がありません", "FORBIDDEN");

    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (!isPlainOwnerLevel(ownerDisplayConfig.name) || !isPlainOwnerLevel(ownerDisplayConfig.zip) || !isPlainOwnerLevel(ownerDisplayConfig.address)) {
      throw new ApiError(403, "DM作成に必要な所有者情報(氏名・郵便番号・住所)の表示権限がありません", "FORBIDDEN");
    }

    // 売却DM 設定は DB→env で解決(管理画面で設定された値を反映)。未設定なら fail-closed(503)。DB に何も書かない。
    const saleDmCfg = await loadSaleDmConfig();
    if (!isSaleDmConfigured(saleDmCfg)) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    // 印刷の郵送QRには絶対URL(追跡URL / LP URL)が必須。これらが未設定/不正だと、生成(課金)しても印刷 route が
    // 503 で出力できず、印刷不能な下書きに課金されるだけになる。有料生成の前に印刷必須URLも確認し、揃っていなければ
    // 生成を始めずに fail-closed(503)する(印刷 route と同じ前提)。
    if (!resolveTrackingBaseUrl(saleDmCfg) || !resolveLpUrl(saleDmCfg)) {
      throw new ApiError(503, "印刷に必要なURL(SALE_DM_TRACKING_BASE_URL / SALE_DM_LP_URL)が未設定です", "PRINT_URL_NOT_CONFIGURED");
    }

    // 不正JSON は parseJsonBody で 400(request.json() の素の 500 を避ける。他 mutation route と統一)。
    const body = saleDmCampaignBodySchema.parse(await parseJsonBody(request));
    // 課金確認: 最大50通の有料AI呼び出し + オーナーPII の外部送信を伴うため、明示確認(confirmed:true)を要求。
    // 謄本自動取得の confirmed ゲートと同方針(UI は実行前に確認ダイアログを出してから true を送る)。
    if (body.confirmed !== true) {
      throw new ApiError(400, "AI生成には課金確認(confirmed:true)が必要です", "SALE_DM_CONFIRMATION_REQUIRED");
    }
    // 差出人は env 既定(SALE_DM_SENDER_NAME/CONTACT)のみを使う。印刷・再生成も resolveSender(env)を使い、
    // body 指定の差出人は保存されず印刷で env 既定にズレる(不整合)ため、body の抜け道は塞ぎ env を必須にする。
    // 未設定なら使えない手紙を有料生成しないよう生成前に fail-closed(503・印刷URL チェックと同方針・Codex R33)。
    if (!isSenderConfigured(saleDmCfg)) {
      throw new ApiError(503, "差出人情報(差出人名 / 連絡先)が未設定です", "SENDER_NOT_CONFIGURED");
    }
    // 冪等性: client が作成試行ごとに安定生成したキー。同キーで既に作成済みなら、有料生成を再実行せず
    // 既存 campaign を返す(再送信/別タブ/連打での二重課金・二重作成を防ぐ)。キー未指定なら従来通り。
    const idempotencyKey = body.idempotencyKey;
    if (idempotencyKey) {
      const existing = await prisma.dmCampaign.findUnique({ where: { idempotencyKey }, select: { id: true, createdBy: true, status: true, createdAt: true } });
      if (existing) {
        if (existing.createdBy !== session.id) throw new ApiError(409, "この作成キーは既に使用されています", "IDEMPOTENCY_CONFLICT");
        // status!=="draft"(=ready 以降)= 生成+保存が完了済み → そのまま返す(冪等)。
        if (existing.status !== "draft") {
          return NextResponse.json({ campaignId: existing.id, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
        }
        // status==="draft" = クレーム後・保存完了前。並行生成中(ライブ)か、プロセス死の孤児か区別が要る。
        // 生成時間を大きく超えて古い(STALE_MS 超)draft のみ孤児として削除し作り直す。
        // まだ新しい draft は並行生成中とみなし削除せず 409(再試行を促す。完了すれば ready で冪等返却)。ライブの
        // クレームを消すと同キーの2リクエストが二重に有料生成し冪等性が破れる(Codex 指摘)ため、必ず新旧を判定する。
        //
        // ⚠STALE_MS は生成の worst-case から**導出**する（総点検P3）。固定値(旧10分)だと、
        // provider の timeout/リトライ設定と乖離した瞬間に「生成中のライブなクレームを孤児と
        // 誤判定→削除→同キーで再生成＝AI 課金が二重」になる。worst-case =
        // ワーカーあたりの直列呼び出し数 (MAX_GENERATE_ITEMS / DEFAULT_CONCURRENCY)
        // × 1呼び出しの上限 (AI_CALL_TIMEOUT_MS × 試行回数(AI_MAX_RETRIES+1))。余裕×2。
        const STALE_MS =
          (MAX_GENERATE_ITEMS / DEFAULT_CONCURRENCY) *
          AI_CALL_TIMEOUT_MS *
          (AI_MAX_RETRIES + 1) *
          2;
        if (Date.now() - new Date(existing.createdAt).getTime() < STALE_MS) {
          throw new ApiError(409, "同じ作成キーの処理が進行中です。少し待って再試行してください", "CAMPAIGN_PROCESSING");
        }
        // ⚠孤児削除は status=draft 条件付きで行う（総点検P3）。無条件 delete だと、
        // この読み取りと削除のすき間に生成側の保存 tx が ready を確定した場合に、
        // **完成済みキャンペーンを下書きごとカスケード削除**してしまう(variant/draft は
        // onDelete: Cascade)。count=0 = 削除の瞬間に draft でなくなっていた(または
        // 他リクエストが先に孤児を回収した)ので、読み直して完了済みなら冪等返却、
        // それ以外は 409 で再試行を促す。
        const del = await prisma.dmCampaign.deleteMany({ where: { id: existing.id, status: "draft" } });
        if (del.count === 0) {
          const settled = await prisma.dmCampaign.findUnique({ where: { id: existing.id }, select: { status: true } });
          if (settled && settled.status !== "draft") {
            return NextResponse.json({ campaignId: existing.id, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
          }
          throw new ApiError(409, "同じ作成キーの処理が進行中です。少し待って再試行してください", "CAMPAIGN_PROCESSING");
        }
      }
    }
    // 対象の決め方: (A) チェックで選んだ propertyIds があればそれを対象にする(明示選択優先)。無ければ
    // (B) 従来どおり絞り込み条件(filters)から送付可(send)物件を対象にする(後方互換)。手紙を作れるのは
    // 所有者に住所がある物件のみ(共通の mailableOwner)。
    const mailableOwner = { propertyOwners: { some: { owner: { isArchived: false, address: { not: "" } } } } };
    // 生成(課金)は物件単位で最大 MAX_GENERATE_ITEMS(=50)通に抑える(下の capRecipientsByProperty)。物件を途中で
    // 分断しないので、共有者多数の1物件が数百通に膨らむ同期生成の暴走(Codex R9-P1)も、宛先が欠けたまま保存され
    // 再バッチで二重生成される事故(Codex R8)も防ぐ。上限は両経路で共通。
    // 明示選択(propertyIds)は take せず全件取得して「対象外(住所なし/送付可でない等)」件数を正確に数える。
    // filters 経路は該当が数千件になり得るので take:MAX+1 で取得を絞る。
    const explicitSelection = !!(body.propertyIds && body.propertyIds.length > 0);
    // whereClause は buildPropertyListWhere の where と同型(既存実装に合わせ緩い型)。mgmt短絡時は null。
    let whereClause: Awaited<ReturnType<typeof buildPropertyListWhere>>["where"] | null;
    let orderBy: ReturnType<typeof buildPropertyListOrderBy> = { updatedAt: "desc" };
    if (body.propertyIds && body.propertyIds.length > 0) {
      // チェックで選んだ物件が対象。field_staff の可視スコープは適用する。DM は「送付可(send)」の物件にのみ生成する
      // (filters 経路と同じ不変条件＝アプリのDMモデル)。一覧は全ステータス表示ゆえ、未判断(hold)/送付不可(no_send)を
      // うっかり選んでも、有料AI生成+オーナーPII送信はしない(Codex R2/R6)。対象外は結果的に外れ、件数を UI で通知する。
      whereClause = { id: { in: body.propertyIds }, isArchived: false, dmStatus: "send", ...mailableOwner };
      const scope = propertyVisibilityScopeWhere(session);
      if (scope) whereClause.AND = [scope];
    } else {
      const query = propertyListQuerySchema.parse(body.filters ?? {});
      // 絞り込みが明示的に send 以外(hold/no_send)を指すなら黙って send へ上書きせず 400
      // (確認ダイアログの対象と実際の生成対象のズレを防ぐ)。
      if (query.dmStatus !== undefined && query.dmStatus !== "send") {
        throw new ApiError(400, "送付可(dmStatus=send)以外の絞り込みではDMを作成できません", "INVALID_DM_STATUS_FILTER");
      }
      const { where, mgmtShortCircuitEmpty, mgmtOverflowed } =
        await buildPropertyListWhere(query, session);
      // ⚠管理ID の一致が上限を超えて切り捨てられているときは、AI 生成 (課金) の
      // 前に止める (@codex #330 R3)。ここは並べ替えたうえで先頭 50 件を選ぶが、
      // その母集団が「取込行の並び順で先頭 10,000 件」に化けているため、
      // **本来選ばれるべきでない宛先に有料で文面を作って送る**ことになる。
      if (mgmtOverflowed) {
        throw new ApiError(
          400,
          "管理IDに一致する物件が多すぎます（上限10,000件）。管理IDをより具体的に指定するか、他の条件で絞り込んでください。",
          "MGMT_ID_LIMIT_EXCEEDED",
        );
      }
      orderBy = buildPropertyListOrderBy(query);
      if (mgmtShortCircuitEmpty) {
        whereClause = null;
      } else {
        where.dmStatus = "send";
        where.isArchived = false;
        whereClause = { ...where, AND: [...(where.AND ?? []), mailableOwner] };
      }
    }

    const properties = whereClause === null ? [] : await prisma.property.findMany({
      where: whereClause,
      select: {
        id: true, address: true, propertyType: true, roomNo: true,
        propertyOwners: {
          where: { owner: { isArchived: false } },
          select: { isPrimary: true, relationship: true, owner: { select: { id: true, name: true, nameKana: true, zip: true, address: true, corporateNumber: true } } },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
      },
      orderBy,
      // 明示選択(propertyIds)は take せず全件取得(対象外件数を正確に数えるため・生成は下で max=50 に切詰)。
      // filters 経路は該当多数になり得るので take:MAX+1(+1 は truncated 検出用)。
      take: explicitSelection ? undefined : MAX_GENERATE_ITEMS + 1,
    });

    // 明示選択は UI が「表示していた順」で propertyIds を送る。findMany は orderBy(既定=updatedAt desc)で返すため、
    // 上限超で物件単位に切り詰める際、ユーザーが見ていた並びの末尾でなく別の物件が落ちてしまう。propertyIds の順へ
    // 並べ替え、切り詰め対象を「選択リストの並び」に一致させる(Codex R13)。filters 経路は orderBy のままでよい。
    let orderedProperties = properties;
    if (explicitSelection && body.propertyIds) {
      const rank = new Map(body.propertyIds.map((id, i) => [id, i] as const));
      orderedProperties = [...properties].sort(
        (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }

    const { recipients, meta } = buildRecipientsFromProperties(
      orderedProperties as never,
      ownerDisplayConfig,
    );

    // 対象になった物件数 = 実際に宛先を1件以上作れた物件の数。DBの address:{not:""} は空白のみの住所を通すが、
    // groupPropertyOwnersByAddress は trim して空をスキップするため、そういう物件は recipient 0=対象外として数える
    // (properties.length だと過大計上=UIの「対象外」通知が出ず空キャンペーンに飛ぶ・Codex R9-P2)。
    const matchedProperties = new Set(meta.map((m) => m.propertyId)).size;
    // 物件単位で最大 MAX_GENERATE_ITEMS 通に抑える(物件を分断しない・R8/R9-P1)。切詰めは truncated で通知。
    const capped = capRecipientsByProperty(recipients, meta, MAX_GENERATE_ITEMS);

    // 差出人は env 既定(SALE_DM_SENDER_NAME/CONTACT)のみ。印刷・再生成も resolveSender(env)を使うため、
    // 生成も env 差出人で揃える(body 指定は非永続ゆえ使わない=印刷とのズレを防ぐ・Codex R33)。
    const sender = resolveSender(saleDmCfg);
    const genOptions = {
      ...body.options,
      senderName: sender.senderName,
      senderContact: sender.senderContact,
    };

    // 生成(課金)の前に campaign をクレーム(idempotencyKey の一意制約で同キーの二重生成を弾く)。
    // 並行リクエストは P2002 で1つに収束し、敗者は生成せず既存を返す(二重課金の防止)。
    let claimed: { id: string };
    try {
      claimed = await prisma.dmCampaign.create({
        data: { name: body.name, createdBy: session.id, filterSnapshot: body.filters ?? {}, idempotencyKey: idempotencyKey ?? null },
        select: { id: true },
      });
    } catch (e) {
      if (idempotencyKey && e && typeof e === "object" && (e as { code?: unknown }).code === "P2002") {
        const won = await prisma.dmCampaign.findUnique({ where: { idempotencyKey }, select: { id: true, createdBy: true, status: true } });
        if (won) {
          if (won.createdBy !== session.id) throw new ApiError(409, "この作成キーは既に使用されています", "IDEMPOTENCY_CONFLICT");
          // 完了済み(ready 以降)なら冪等返却。status==="draft"=並行勝者が生成中(未完)→ 勝者の生成を壊さない
          // よう削除せず、少し待っての再試行を促す(完了すれば ready で冪等返却される・R34)。
          if (won.status !== "draft") {
            return NextResponse.json({ campaignId: won.id, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
          }
          throw new ApiError(409, "同じ作成キーの処理が進行中です。少し待って再試行してください", "CAMPAIGN_PROCESSING");
        }
      }
      throw e;
    }

    // クレーム確保後に生成+保存。途中で失敗(生成の総失敗 / 保存トランザクション失敗=対象物件の削除・FK・DB
    // エラー等)したらクレームを削除し、孤児 campaign(空)を残さない。UI は失敗後に同じ idempotencyKey で再試行
    // するため、空 campaign が残ると壊れた空キャンペーンに遷移してしまう。削除すれば再クレーム→再生成できる(R33)。
    let drafts: Awaited<ReturnType<typeof generateLetters>>["drafts"];
    let truncated: boolean;
    // リンク切れスキップの実数(@codex #364 R2): 黙って落とすと「生成成功」の見かけのまま
    // 手紙がDBに無い状態になる。実保存数を応答・監査に載せ、全滅なら 409 で再試行させる。
    let persistedCount = 0;
    let skippedByUnlinkCount = 0;
    try {
      const result = await generateLetters(capped.recipients.map((r) => ({ recipient: r, options: genOptions })), { provider: resolveProvider(saleDmCfg) });
      drafts = result.drafts;
      truncated = capped.truncated; // 切詰めは物件単位 cap で判定(generateLetters には既に cap 済みの list を渡す)

      // 既定型 A(1つ)+ 宛先下書きを、クレーム済み campaign 配下に保存(生成成功分のみ body 入り。失敗分は空+メモ)。
      // 複数型(B/C)の追加と再割当は variants / assign route で行う。生成 route は「初期1型」を保証するのみ。
      // A/B 純度は割り当てられた variantId 基準(個別 override は本文の微修正で集計に影響しない)。
      await prisma.$transaction(async (tx) => {
        // PR-A(設計§2.2・R49 P2): 宛先生成 tx も順序規約に従い Owner(FOR SHARE・id順)→
        // 物件親行(FOR SHARE・id順)を取得し、保持したまま PropertyOwner リンクを再検証してから
        // draft+共有者連関を INSERT する。リンクの付け外しは親行ロック規約で書かれるため、
        // これで「所有者でなくなった相手への draft」が生成後の印刷検査をすり抜ける穴を塞ぐ。
        const rawTx = tx as unknown as RawTx;
        const sliced = capped.meta.slice(0, drafts.length);
        await lockOwnersForShare(rawTx, sliced.flatMap((m) => m.groupOwnerIds));
        await lockPropertiesForShare(rawTx, sliced.map((m) => m.propertyId));
        const currentLinks = await tx.propertyOwner.findMany({
          where: { propertyId: { in: [...new Set(sliced.map((m) => m.propertyId))] } },
          select: { propertyId: true, ownerId: true },
        });
        const linkSet = new Set(
          currentLinks.map((l) => `${l.propertyId}\u0000${l.ownerId}`),
        );
        const variant = await tx.dmVariant.create({
          data: {
            campaignId: claimed.id, label: "A",
            designTemplate: body.options.designTemplate, tone: body.options.tone,
            length: body.options.length, appeal: body.options.appeal,
            strength: body.options.strength, extraInstruction: body.options.extraInstruction ?? null,
          },
        });
        for (let i = 0; i < sliced.length; i++) {
          const d = drafts[i];
          const m = sliced[i];
          // ロック保持中の再検証: グループの誰かがこの物件の所有者でなくなっていたら生成しない。
          if (
            m.groupOwnerIds.length > 0 &&
            !m.groupOwnerIds.every((oid) => linkSet.has(`${m.propertyId}\u0000${oid}`))
          ) {
            skippedByUnlinkCount += 1;
            continue;
          }
          const createdDraft = await tx.dmRecipientDraft.create({
            data: {
              campaignId: claimed.id, variantId: variant.id, propertyId: m.propertyId,
              representativeOwnerId: m.representativeOwnerId,
              recipientName: m.recipientName, recipientZip: m.recipientZip,
              recipientAddress: m.recipientAddress, honorific: m.honorific,
              coOwnerCount: m.coOwnerCount,
              body: d.body ?? "", model: resolveLetterModel(saleDmCfg),
              outcomeNote: d.error ? `生成失敗(${d.error})` : null,
              trackingToken: randomBytes(8).toString("base64url"),
              generatedBy: session.id,
            },
            select: { id: true },
          });
          // 共有者グループ全員を連関に保存(mark-sent がログの連関へコピーする元。設計§2.2)。
          if (m.groupOwnerIds.length > 0) {
            await tx.dmRecipientDraftOwner.createMany({
              data: m.groupOwnerIds.map((ownerId) => ({
                draftId: createdDraft.id,
                ownerId,
              })),
              skipDuplicates: true,
            });
          }
          persistedCount += 1;
        }
        // 全宛先がリンク切れで保存できなかった=空のキャンペーンを ready にしない。
        // tx を巻き戻し、外側の catch がクレームを削除する(再試行で作り直せる)。
        if (persistedCount === 0 && sliced.length > 0) {
          throw new ApiError(
            409,
            "宛先の所有者情報が変わりました。もう一度お試しください",
            "RECIPIENTS_CHANGED",
          );
        }
        // 生成+保存が完了したのでキャンペーンを ready にする(drafts と同一トランザクションでアトミックに確定)。
        // idempotency の pre-check / P2002 はこの完了マーカーで「冪等返却(ready)」と「孤児削除→作り直し(draft)」
        // を区別する。途中でプロセスが落ちれば status は draft のままで孤児として検出・回収される(R34)。
        await tx.dmCampaign.update({ where: { id: claimed.id }, data: { status: "ready" } });
      });
    } catch (e) {
      // 生成 or 保存の失敗 → クレームを削除(孤児の空 campaign を残さない。再試行で再クレームできる)。
      await prisma.dmCampaign.delete({ where: { id: claimed.id } }).catch(() => {});
      throw e;
    }

    // AuditLog は非PIIメタのみ(本文・宛名・住所は残さない)。
    await writeAuditLog({
      userId: session.id, action: "sale_dm_campaign_create", targetTable: "dm_campaigns",
      detail: { campaignId: claimed.id, requested: recipients.length, generated: drafts.length, saved: persistedCount, skippedByUnlink: skippedByUnlinkCount, failed: drafts.filter((d) => d.error).length, truncated, createdAt: new Date().toISOString() },
    });

    return NextResponse.json(
      // requested=生成する手紙数(共有者ぶんで物件数より多くなり得る)。matchedProperties=対象になった物件数
      // (=選択のうち住所ありで生成対象になった物件)。UI の「対象外」通知は物件単位で出すため両方返す。
      { campaignId: claimed.id, requested: recipients.length, matchedProperties, generated: drafts.length, saved: persistedCount, skippedByUnlink: skippedByUnlinkCount, failed: drafts.filter((d) => d.error).length, truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SaleDmError && error.code === "NOT_CONFIGURED") {
      return handleApiError(new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED"));
    }
    return handleApiError(error);
  }
}
