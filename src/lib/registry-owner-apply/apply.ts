/**
 * 添付済みの謄本(所有者事項)から、その物件の所有者を登録する**共通処理**。
 *
 * 1件ずつのボタン(`/api/properties/[id]/registry-owners`)と、まとめて反映の
 * 裏の処理(`registry-owner-bulk/process-row.ts`)の**両方がここを通る**。
 * ⚠検査と安全策(所有者が空か・確認した謄本が最新か・担当範囲・項目ごとの権限・
 *   物件の項目を書き換えない)を2か所に分けて書くと、片方だけ直す事故が起きる。
 *   レビュー23巡で積み上げた守りなので、**必ずここに集約する**。
 *
 * ⚠**全部事項(certificateType="all")は対象にしない**。全部事項には抹消済みの
 *   旧所有者も載るため、最新の所有者を見分ける規則が別途必要になる。
 */
import prisma from "@/lib/prisma";
import { ApiError, type PermissionEntry } from "@/lib/api-helpers";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { findMissingOwnerFieldWritePerm } from "@/lib/owner-create";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { PDF_READ_TIMEOUT } from "@/lib/pdf-read-timeout";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { REGISTRY_OWNER_BULK_ROW_JOB_LABEL } from "@/lib/registry-owner-bulk/marker";
import { planOwnerReplacement } from "@/lib/registry-owner-check/compare";
import {
  processRegistryPdf,
  type ProcessRegistryPdfArgs,
} from "@/lib/registry-pdf/process";

/** この機能が扱う謄本の種別。全部事項は対象外。 */
export const SUPPORTED_CERTIFICATE_TYPE = "owner";

/**
 * 取込ジョブ・監査記録に残す名前。**添付の生ファイル名は使わない**(PIIを含みうる)。
 * 利用者が見る下見には、別途ほんとうのファイル名を返している。
 */
export const REGISTRY_OWNER_APPLY_AUDIT_LABEL = "添付済みの謄本から所有者を反映";
/** 置き換え(謄本の名義に直す)の取込記録・監査に残す名前。 */
export const REGISTRY_OWNER_REPLACE_AUDIT_LABEL = "謄本の名義に直す";

export interface LoadedRegistry {
  attachmentId: string;
  fileName: string;
  createdAt: Date;
  text: string;
}

/**
 * いちばん新しい所有者事項の添付(削除済みを除く)。
 * ⚠下見・反映の受付・**書き込みのロックの中の見直し**で同じ条件を使う(条件が
 *   ずれると「見直しでは別の添付が最新」になり、正しい操作が 409 になる)。
 */
export function findLatestOwnerRegistryAttachment(
  db: Pick<typeof prisma, "attachment">,
  propertyId: string,
) {
  return db.attachment.findFirst({
    where: {
      propertyId,
      type: "registry",
      isDeleted: false,
      registryCertificateType: SUPPORTED_CERTIFICATE_TYPE,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, fileUrl: true, createdAt: true },
  });
}

export const attachmentChangedError = () =>
  new ApiError(
    409,
    "確認した謄本とは別の謄本が追加されています。開き直してもう一度確認してください",
    "REGISTRY_ATTACHMENT_CHANGED",
  );

/**
 * 添付済みの所有者事項を1件取り出し、文字を抜き出す。
 *
 * @param expectedAttachmentId 下見で見せた添付のID。渡されたときは、いちばん新しい
 *   添付がそれと同じであることを確かめる(違えば 409)。確認画面を開いている間に
 *   別の謄本が添付された場合に、見ていない方の所有者を入れてしまわないため。
 * @param opts.timeoutMs 渡したときだけ、文字の抜き出しをその時間で打ち切る
 *   (超えたら 504 REGISTRY_TEXT_TIMEOUT=読めないとは別。あとで試し直せる)。
 */
export async function loadLatestRegistryText(
  propertyId: string,
  expectedAttachmentId?: string,
  opts: { timeoutMs?: number } = {},
): Promise<LoadedRegistry> {
  const attachment = await findLatestOwnerRegistryAttachment(prisma, propertyId);
  if (!attachment) {
    throw new ApiError(
      404,
      "この物件には所有者事項の謄本が添付されていません",
      "REGISTRY_NOT_FOUND",
    );
  }
  if (expectedAttachmentId && attachment.id !== expectedAttachmentId) {
    throw attachmentChangedError();
  }

  const storage = getStorage();
  const key = storage.keyFromUrl(attachment.fileUrl);
  if (!key) {
    throw new ApiError(404, "謄本の実体が見つかりません", "REGISTRY_FILE_MISSING");
  }
  const file = await storage.read(key);
  if (!file) {
    throw new ApiError(404, "謄本の実体が見つかりません", "REGISTRY_FILE_MISSING");
  }

  let text = "";
  try {
    text =
      opts.timeoutMs === undefined
        ? await extractTextFromPdf(file.body)
        : await extractTextFromPdf(file.body, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === PDF_READ_TIMEOUT) {
      throw new ApiError(504, "謄本の読み取りが時間内に終わりませんでした", "REGISTRY_TEXT_TIMEOUT");
    }
    throw new ApiError(
      422,
      "謄本から文字を読み取れませんでした。手入力で登録してください",
      "REGISTRY_TEXT_UNREADABLE",
    );
  }
  if (!text.trim()) {
    throw new ApiError(
      422,
      "謄本から文字を読み取れませんでした。手入力で登録してください",
      "REGISTRY_TEXT_UNREADABLE",
    );
  }

  return {
    attachmentId: attachment.id,
    fileName: attachment.fileName,
    createdAt: attachment.createdAt,
    text,
  };
}

/**
 * 読み取れた所有者について、**書く項目ごとの**権限を確かめる。
 * ⚠`owner:write` だけでは、氏名や住所を書けない役割でも謄本の値を保存できてしまう。
 *   他の所有者の窓口(`/owners/create-and-link`)と同じ純関数で判定する。
 */
export function assertOwnerFieldWritePerms(
  perms: PermissionEntry[],
  owners: Array<{ name: string; address: string | null }>,
): void {
  for (const owner of owners) {
    const missing = findMissingOwnerFieldWritePerm(perms, {
      name: owner.name,
      address: owner.address,
    });
    if (missing) {
      throw new ApiError(403, `${missing.label} を書き込む権限がありません`, "FORBIDDEN");
    }
  }
}

export interface ApplyRegistryOwnersArgs {
  session: { id: string; role: string };
  perms: PermissionEntry[];
  propertyId: string;
  /**
   * 下見で見せた添付のID。1件ずつのボタンは**必ず渡す**(利用者が見たものを入れる)。
   * まとめて反映は人が中身を見ないので渡さず、実行時点の最新を使う。
   */
  expectedAttachmentId?: string;
  /**
   * 所有者の書き込みと**同じトランザクションの確定直前**に呼ぶ(まとめて反映が取込記録の
   * 行を「成功」にするため)。投げれば所有者の書き込みも巻き戻る。
   * → ProcessRegistryPdfArgs.beforeCommit
   */
  beforeCommit?: ProcessRegistryPdfArgs["beforeCommit"];
  /**
   * まとめて反映の1件分として呼ぶとき true。共通処理が作る取込記録を、履歴の一覧に
   * 並べない名前で残す(→ REGISTRY_OWNER_BULK_ROW_JOB_LABEL)。
   */
  partOfBulk?: boolean;
}

export interface ApplyRegistryOwnersOutcome {
  attachmentId: string;
  /** 読み取れた所有者の人数(行数)。同じ人が2回載っていれば登録は1人にまとまる。 */
  parsedOwners: number;
  result: Awaited<ReturnType<typeof processRegistryPdf>>;
}

/**
 * 1物件ぶんの反映。エラーは `ApiError` で投げる:
 *   404 物件/謄本/実体が無い / 409 すでに所有者がいる・別の謄本が追加された /
 *   422 読み取れない / 403 権限・担当範囲
 */
export async function applyRegistryOwnersToProperty(
  args: ApplyRegistryOwnersArgs,
): Promise<ApplyRegistryOwnersOutcome> {
  const { session, perms, propertyId, expectedAttachmentId, beforeCommit, partOfBulk } = args;

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      assignedTo: true,
      createdBy: true,
      propertyOwners: { select: { id: true }, take: 1 },
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
  }
  // すでに所有者がいる物件は対象外(上書き・二重登録を避ける)。
  // ⚠この判定は受付時点の値。書き込みのロックの中でもう一度見直す
  //   (requireNoExistingOwners)。
  if (property.propertyOwners.length > 0) {
    throw new ApiError(
      409,
      "この物件にはすでに所有者が登録されています",
      "OWNERS_ALREADY_EXIST",
    );
  }

  const registry = await loadLatestRegistryText(propertyId, expectedAttachmentId);
  const owners = parseRegistryOwnerTable(registry.text);
  if (!owners || owners.length === 0) {
    throw new ApiError(
      422,
      "謄本から所有者を読み取れませんでした。手入力で登録してください",
      "REGISTRY_OWNERS_NOT_FOUND",
    );
  }
  assertOwnerFieldWritePerms(perms, owners);

  const result = await processRegistryPdf({
    session,
    text: registry.text,
    propertyId,
    // ⚠生ファイル名ではなく固定ラベル(ImportJob と AuditLog に残るため)
    fileName: partOfBulk ? REGISTRY_OWNER_BULK_ROW_JOB_LABEL : REGISTRY_OWNER_APPLY_AUDIT_LABEL,
    edited: undefined,
    // ⚠必ず null。非 null にすると同じ謄本がもう一度添付されてしまう。
    pdfBuffer: null,
    certificateType: SUPPORTED_CERTIFICATE_TYPE,
    // ⚠上の 409 判定は PDF を読む前の値なので、読んでいる間に別タブが所有者を
    //   紐づけると古くなる。書き込みと同じ物件行ロックの中で見直してもらう。
    requireNoExistingOwners: true,
    // ⚠担当者スコープ(canAccessPropertyRecord)の確認も受付時点の値。書き込みの
    //   ロックまでの間に担当を外されても、ロックと同じ1文で見直して 403 にする。
    enforcePropertyScope: true,
    // ⚠読んだ謄本が最新のままかを、書き込みのロックの中でもう一度確かめる。
    beforeFirstWrite: async (tx) => {
      // ⚠添付の**削除・復元**は物件行を押さえずに isDeleted を書く(添付の新規作成は
      //   物件行で直列化されている)。この物件の謄本の添付行をここで押さえて、
      //   削除・復元の書き込みをこの処理の確定まで待たせる。順序は 物件 → 添付。
      await tx.$queryRaw`
        SELECT id FROM attachments
        WHERE property_id = ${propertyId}::uuid AND type = 'registry'
        FOR UPDATE
      `;
      const latest = await findLatestOwnerRegistryAttachment(tx, propertyId);
      if (!latest || latest.id !== registry.attachmentId) throw attachmentChangedError();
    },
    // ⚠所有者だけを入れる。下見も確認画面も所有者しか見せていないので、
    //   物件の項目(不動産番号・地番・家屋番号・登記状況)は書き換えない。
    ownersOnly: true,
    // 呼び出し元の記録を所有者と一緒に確定させる(まとめて反映のみ渡す)
    beforeCommit,
    // ⚠この経路は「見せたものだけ書く」。取込処理が失敗を記録するときも、
    //   生のエラー文(登記由来の住所を含みうる)を残さない。
    sanitizeFailureDetails: true,
  });

  return {
    attachmentId: registry.attachmentId,
    parsedOwners: owners.length,
    result,
  };
}

/** トランザクションの中の DB の口(processRegistryPdf の beforeCommit と同じ形)。 */
export type ReplaceTx = Parameters<NonNullable<ProcessRegistryPdfArgs["beforeCommit"]>>[0];

/** 置き換えの受付で、確認画面に見せた内容(これと今が違えば 409)。 */
export interface ReplaceRegistryOwnersArgs {
  session: { id: string; role: string };
  perms: PermissionEntry[];
  propertyId: string;
  /** 確認画面で見せた謄本の添付 */
  expectedAttachmentId: string;
  /** 確認画面を開いたときに物件につながっていた所有者(全員) */
  expectedLinkedOwnerIds: string[];
  /** 確認画面で「外れる」と見せた所有者 */
  expectedRemoveOwnerIds: string[];
  /**
   * 外す・足すと同じトランザクションの確定直前に呼ぶ(比べた結果の記録・DM を戻すなど)。
   * 投げれば外した分も足した分も巻き戻る。registryNames=謄本の名義(比べ直しに使う)。
   * registryRows=所有者事項の行(名前・住所・持分。登記上の記載の記録に使う)。
   */
  beforeCommit?: (
    tx: ReplaceTx,
    registryNames: string[],
    registryRows: ReadonlyArray<{ name: string; address: string | null; share: string | null }>,
  ) => Promise<void>;
}

/** 謄本の名義の確認で、システムの所有者を並べる順(確認画面と「謄本の名義に直す」で同じ)。 */
export const REGISTRY_OWNER_REVIEW_ORDER = [
  { isPrimary: "desc" as const },
  { createdAt: "asc" as const },
  { ownerId: "asc" as const },
];

export const ownersChangedError = () =>
  new ApiError(
    409,
    "確認画面を開いたあとに所有者が変わりました。開き直してもう一度確認してください",
    "OWNERS_CHANGED",
  );

function sortedEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/**
 * 「謄本の名義に直す」(置き換え・2026-11-08 発注者決定)。
 * 今の所有者のうち謄本に載っていない人を物件から外し、システムにいない謄本の人を足す。
 * ⚠**外す・足すは1つのトランザクション**(途中で失敗したら何も変わらない)。足す側は
 *   添付済み謄本からの所有者反映と同じ処理(processRegistryPdf)を通る。
 * ⚠外した所有者は変更履歴から元に戻せるように、所有者のID・主所有者か・関係・期間を残す
 *   (所有者の記録そのものは消さない)。物件ごとのメモがある所有者は外さない(履歴に
 *   個人の文を残さないため・先にメモを確かめてもらう)。
 * ⚠名前は照合と同じそろえ方で比べる(表記の違いだけの人は外さない・足さない)。
 */
export async function replaceRegistryOwnersOnProperty(
  args: ReplaceRegistryOwnersArgs,
): Promise<{ removed: number; added: number; result: Awaited<ReturnType<typeof processRegistryPdf>> }> {
  const { session, perms, propertyId, expectedAttachmentId } = args;
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, assignedTo: true, createdBy: true },
  });
  if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
  }

  const registry = await loadLatestRegistryText(propertyId, expectedAttachmentId);
  const registryOwners = parseRegistryOwnerTable(registry.text);
  if (!registryOwners || registryOwners.length === 0) {
    throw new ApiError(
      422,
      "謄本から所有者を読み取れませんでした。手入力で直してください",
      "REGISTRY_OWNERS_NOT_FOUND",
    );
  }
  const registryNames = registryOwners.map((o) => o.name);

  // 受付時点の計画(確認画面と同じか)。⚠ロックの中でもう一度作り直して比べる。
  // ⚠確認画面(GET /api/registry-owner-checks/[propertyId])と同じ順に並べる=外字の組の相手が
  //   並び順で変わらないように(2026-11-11 昼)
  const linkedNow = await prisma.propertyOwner.findMany({
    where: { propertyId },
    select: { ownerId: true, owner: { select: { name: true } } },
    orderBy: REGISTRY_OWNER_REVIEW_ORDER,
  });
  const plan = planOwnerReplacement(
    registryOwners,
    linkedNow.map((l) => ({ ownerId: l.ownerId, name: l.owner.name })),
  );
  if (
    !sortedEqual(linkedNow.map((l) => l.ownerId), args.expectedLinkedOwnerIds) ||
    !sortedEqual(plan.removeOwnerIds, args.expectedRemoveOwnerIds)
  ) {
    throw ownersChangedError();
  }
  if (plan.removeOwnerIds.length === 0 && plan.add.length === 0) {
    throw new ApiError(409, "すでに謄本の名義と同じです", "ALREADY_SAME");
  }
  assertOwnerFieldWritePerms(perms, plan.add);

  let removed = 0;
  const result = await processRegistryPdf({
    session,
    text: registry.text,
    propertyId,
    // ⚠生ファイル名ではなく固定ラベル(ImportJob と AuditLog に残るため)
    fileName: REGISTRY_OWNER_REPLACE_AUDIT_LABEL,
    // ⚠足すのは「システムにいない謄本の人」だけ(確認画面で見せた人)
    edited: { owners: plan.add.map((o) => ({ name: o.name, address: o.address, share: o.share })) },
    // ⚠足す人だけ=書類の行の全部ではない。登記上の記載は記録しない。
    partialOwners: true,
    // ⚠必ず null(添付は既にある)
    pdfBuffer: null,
    certificateType: SUPPORTED_CERTIFICATE_TYPE,
    enforcePropertyScope: true,
    ownersOnly: true,
    sanitizeFailureDetails: true,
    beforeFirstWrite: async (tx) => {
      // 順序は 物件 → 添付(反映と同じ)。読んだ謄本が今も最新か。
      await tx.$queryRaw`
        SELECT id FROM attachments
        WHERE property_id = ${propertyId}::uuid AND type = 'registry'
        FOR UPDATE
      `;
      const latest = await findLatestOwnerRegistryAttachment(tx, propertyId);
      if (!latest || latest.id !== registry.attachmentId) throw attachmentChangedError();
    },
    replaceExistingOwners: async (tx) => {
      const links = await tx.propertyOwner.findMany({
        where: { propertyId },
        select: {
          id: true,
          ownerId: true,
          isPrimary: true,
          relationship: true,
          note: true,
          startDate: true,
          endDate: true,
          owner: { select: { name: true } },
        },
        orderBy: REGISTRY_OWNER_REVIEW_ORDER,
      });
      // ⚠ロックの中で作り直した計画が、確認画面で見せたものと同じか
      const fresh = planOwnerReplacement(
        registryOwners,
        links.map((l) => ({ ownerId: l.ownerId, name: l.owner.name })),
      );
      if (
        !sortedEqual(links.map((l) => l.ownerId), args.expectedLinkedOwnerIds) ||
        !sortedEqual(fresh.removeOwnerIds, args.expectedRemoveOwnerIds) ||
        fresh.add.length !== plan.add.length
      ) {
        throw ownersChangedError();
      }
      const removeSet = new Set(fresh.removeOwnerIds);
      const toRemove = links.filter((l) => removeSet.has(l.ownerId));
      if (toRemove.some((l) => l.note && l.note.trim())) {
        throw new ApiError(
          409,
          "外す所有者に、この物件についてのメモがあります。所有者タブでメモを確かめてから直してください",
          "OWNER_LINK_HAS_NOTE",
        );
      }
      // ⚠所有者が何百人もつながった物件でも、トランザクションの持ち時間に収まるように
      //   外す・履歴はまとめて1回ずつ書く(1人ずつ書くと人数ぶん往復する=2026-11-09 の 200人超)。
      if (toRemove.length > 0) {
        await tx.propertyOwner.deleteMany({ where: { id: { in: toRemove.map((l) => l.id) } } });
        // ⚠元に戻せるように、つながりの中身を残す(形は「外す」ボタンと同じ印+関係・期間)。
        //   氏名・メモは入れない(所有者のIDから引ける)。
        await tx.changeLog.createMany({
          data: toRemove.flatMap((link) => {
            const base = {
              targetTable: "property_owners",
              targetId: link.id,
              newValue: null,
              source: "manual" as const,
              changedBy: session.id,
              propertyId,
            };
            return [
              { ...base, fieldName: "_unlinked_from_property", oldValue: link.ownerId },
              { ...base, fieldName: "isPrimary", oldValue: String(link.isPrimary) },
              ...(link.relationship ? [{ ...base, fieldName: "relationship", oldValue: link.relationship }] : []),
              ...(link.startDate ? [{ ...base, fieldName: "startDate", oldValue: link.startDate.toISOString().slice(0, 10) }] : []),
              ...(link.endDate ? [{ ...base, fieldName: "endDate", oldValue: link.endDate.toISOString().slice(0, 10) }] : []),
            ];
          }),
        });
      }
      removed = toRemove.length;
    },
    beforeCommit: args.beforeCommit
      ? async (tx) => args.beforeCommit!(tx, registryNames, registryOwners)
      : undefined,
  });

  return { removed, added: plan.add.length, result };
}
