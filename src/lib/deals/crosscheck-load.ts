import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { registryIdentityOf } from "@/lib/registry-basic-info";
import { isFullCertificateText, summarizeRegistryRights, type RegistryRightsSummary } from "@/lib/registry-strike";
import type { BasePropertyKind } from "./constants";
import {
  LANDED_REQUIRED_SIDES, foldNameVariants, isLandedKind, normalizeName, parseShare,
  type RegistryFacts, type RegistrySide, type RegistryUncertain,
} from "./crosscheck";
import { expectedParcels, parcelCoverage, placeCertificate, type CertificateParcel, type ExpectedParcel } from "./parcel-coverage";
import { dealParcelOptions, selectedParcelKeys } from "./target-parcels";
import { readRegistryPdf } from "./registry-rights-load";

/** 見る添付の数(新しい順)。全部事項と所有者事項が混ざるので、登記の現況より少し多めに見る。 */
const CANDIDATES = 8;
/** 土地のある物件で見る添付の上限。全筆を見るため途中で止められない。超えたら「確認できない」に倒す。 */
const LANDED_CANDIDATES = 20;

type Owner = { name: string; share: string | null };

/** 土地・建物の1筆(1棟)ぶんの最新の全部事項。⚠summary に氏名が入る。 */
export interface LandedCertificate {
  side: RegistrySide;
  identity: string;
  createdAt: string;
  summary: RegistryRightsSummary | null;
}

export interface LandedCertificates {
  /** 謄本の添付が1通でもあったか。 */
  hasRows: boolean;
  /** 何か1通でも読めたか。 */
  readAny: boolean;
  certs: LandedCertificate[];
  /** 所有者事項(新しい順)。identity が null=どの物件のものか読めない。⚠list に氏名が入る。 */
  ownerCerts: { identity: string | null; createdAt: string; list: Owner[]; confirmed: boolean }[];
  missing: RegistrySide[];
  /** 2筆以上・2棟以上の物件で、謄本が無い筆(棟)(「土地 1番2」)。それ以外の物件は空。 */
  missingParcels: string[];
  uncertain: RegistryUncertain | null;
}

/**
 * 土地か建物か。表題部(権利部より前)の見出しで決める。
 * ⚠全文を見ない: 土地の謄本でも、共同担保目録に建物の「家屋番号」が載っていることが多い。
 */
function sideOf(text: string, p: ReturnType<typeof parseRegistryText>): RegistrySide | null {
  const title = text.split(/権\s*利\s*部/)[0];
  if (/家\s*屋\s*番\s*号/.test(title)) return "建物";
  if (/地\s*番|地\s*積/.test(title)) return "土地";
  // 表題部の見出しを読めないときだけ、読み取れた値から決める。
  if (p.buildingFloorArea) return "建物";
  if (p.landAreaRegistry || p.lotNumber) return "土地";
  return p.buildingNumber ? "建物" : null;
}

/** 同じ物件かを見分ける鍵。不動産番号が無ければ所在と、その種類の番号(地番か家屋番号)。 */
function identityOf(p: ReturnType<typeof parseRegistryText>, side: RegistrySide | null, text: string): string | null {
  if (p.realEstateNumber) return `no:${p.realEstateNumber}`;
  // 番号は表の欄全体から読めればそれ(parseRegistryText は「1番1の2」と「1番1の3」をどちらも「1番1」に切り、
  // 別の筆の謄本を同じ筆として捨ててしまう・@codex P2)。読めなければ今までどおり。
  const id = registryIdentityOf(text);
  const number = side === "建物" ? (id.buildingNumber ?? p.buildingNumber) : side === "土地" ? (id.lotNumber ?? p.lotNumber) : null;
  // 土地の地番と建物の家屋番号は同じ「1番」になることがあるので、種類も鍵に入れる。
  return p.address && number ? `at:${side}:${p.address}|${number}` : null;
}

/** 1つの PDF に別々の不動産番号がある=複数の筆(棟)をまとめた PDF。 */
function hasSeveralProperties(text: string): boolean {
  const numbers = [...text.normalize("NFKC").matchAll(/不動産番号[:\s]*([0-9\- ]{10,20})/g)].map((m) => m[1].replace(/\D/g, ""));
  return new Set(numbers).size > 1;
}

/**
 * 土地のある物件(戸建・土地・一棟)の謄本を集める。筆(棟)ごとに最新の全部事項を1通ずつ。
 * 抜けた筆を見落とさないよう、読めない謄本・土地か建物か判定できない謄本があれば uncertain を返す。
 * ⚠結果には氏名が入る。ログ・監査に出さない。includeOwners=false なら所有者事項の氏名を持たない。
 */
/** 照合の読み方。targetParcels=この取引の土地・建物(null・省略=全部=今までどおり)。 */
interface LoadOptions { kindBase: BasePropertyKind; includeOwners: boolean; targetParcels?: readonly string[] | null }

/**
 * この取引の土地・建物を選んでいるとき、要る種類。選べる行のある種類で1つも選ばなかったものは要らない
 * (土地だけを売る取引で「建物の謄本が無い」と出さない)。選べる行の無い種類は今までどおり要る。
 */
function scopedSides(property: Parameters<typeof dealParcelOptions>[0], keys: readonly string[], base: readonly RegistrySide[]): RegistrySide[] {
  const options = dealParcelOptions(property, { always: true });
  return base.filter((side) => {
    const ofSide = options.filter((x) => (x.kind === "land" ? "土地" : "建物") === side);
    return !ofSide.length || ofSide.some((x) => keys.includes(x.key));
  });
}

export async function loadLandedCertificates(propertyId: string, o: LoadOptions): Promise<LandedCertificates> {
  const [rows, property] = await Promise.all([
    prisma.attachment.findMany({
      where: { propertyId, type: "registry", isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: LANDED_CANDIDATES + 1,
      select: { fileUrl: true, registryCertificateType: true, createdAt: true },
    }),
    prisma.property.findUnique({ where: { id: propertyId }, select: { address: true, lotNumber: true, buildingNumber: true, extraParcels: true } }),
  ]);
  const keys = property ? selectedParcelKeys(property, o.targetParcels ?? null) : null;
  const required = property && keys ? scopedSides(property, keys, LANDED_REQUIRED_SIDES[o.kindBase] ?? []) : LANDED_REQUIRED_SIDES[o.kindBase] ?? [];
  // 2筆以上・2棟以上の物件だけ、筆(棟)ごとに謄本があるかも見る。
  // ⚠この取引の土地・建物を選んでいても、謄本の行き先は物件の全部の筆・棟で決め、抜けだけを選んだものに絞る
  //   (先に絞ると、同じ番号の別の筆の謄本が選んだ筆のものに見える・@codex P1)。
  const expected = property ? expectedParcels(property, required) : [];
  // 選ばなかった筆(棟)の謄本は、担保・名義・抜けの判定に使わない(どの筆か決められない謄本は今までどおり使う)。
  const everyParcel: ExpectedParcel[] = property && keys ? expectedParcels(property, ["土地", "建物"]) : [];
  // 番号は表の欄から読めればそれ、読めなければ全文から(identityOf と同じ)。
  const outOfDeal = (side: RegistrySide | null, text: string, p: ReturnType<typeof parseRegistryText>) => {
    if (!keys || !side) return false;
    const id = registryIdentityOf(text);
    const number = side === "建物" ? (id.buildingNumber ?? p.buildingNumber) : (id.lotNumber ?? p.lotNumber);
    const hit = placeCertificate({ side, number, realEstateNumber: p.realEstateNumber, address: p.address }, everyParcel);
    return !!hit && !keys.includes(hit.key);
  };
  const certParcels: CertificateParcel[] = [];
  const certs: LandedCertificate[] = [];
  const ownerCerts: LandedCertificates["ownerCerts"] = [];
  const seen = new Set<string>();
  let unreadable = false;
  let unclassified = false;
  let readAny = false;
  /** 所有者事項で存在が分かった筆(棟)。全部事項が無ければ担保を確かめられていない。 */
  const ownerOnly = new Set<string>();

  for (const a of rows.slice(0, LANDED_CANDIDATES)) {
    const at = a.createdAt.toISOString();
    const pdf = await readRegistryPdf(a.fileUrl);
    if (!pdf) {
      // 所有者事項でも、読めなければどの筆のものか分からない(抜けた筆かもしれない)。
      unreadable = true;
      if (a.registryCertificateType === "owner" && o.includeOwners) ownerCerts.push({ identity: null, createdAt: at, list: [], confirmed: false });
      continue;
    }
    const full = isFullCertificateText(pdf.text);
    if (!full) {
      const list = parseRegistryOwnerTable(pdf.text);
      if (!list?.length && a.registryCertificateType !== "owner") {
        // 全部事項とも所有者事項とも読めない謄本は、抜けた筆かもしれないので読み飛ばさない。
        unreadable = true;
        continue;
      }
      readAny = true;
      const parsedOwner = parseRegistryText(pdf.text);
      const ownerSide = sideOf(pdf.text, parsedOwner);
      const ownerIdentity = identityOf(parsedOwner, ownerSide, pdf.text);
      if (outOfDeal(ownerSide, pdf.text, parsedOwner)) continue;
      if (hasSeveralProperties(pdf.text)) unclassified = true;
      // ⚠読めるのに物件を特定できない所有者事項では止めない(表だけの所有者事項で、いつまでも確認できなくなるため)。
      if (ownerIdentity && ownerSide && required.includes(ownerSide)) ownerOnly.add(ownerIdentity);
      // 要らない種類と判定できた所有者事項(土地の取引の建物など)は、名義に入れない。
      if (o.includeOwners && (!ownerSide || required.includes(ownerSide))) {
        ownerCerts.push({
          identity: ownerIdentity, createdAt: at,
          list: (list ?? []).map((x) => ({ name: x.name, share: x.share })), confirmed: !!list?.length,
        });
      }
      continue;
    }
    readAny = true;
    const parsed = parseRegistryText(pdf.text);
    const side = sideOf(pdf.text, parsed);
    const identity = identityOf(parsed, side, pdf.text);
    if (!side || !identity || hasSeveralProperties(pdf.text)) {
      unclassified = true;
      continue;
    }
    if (!required.includes(side) || seen.has(identity) || outOfDeal(side, pdf.text, parsed)) continue;
    seen.add(identity);
    if (expected.length) {
      // 番号は表の欄から(parseRegistryText は「1番1の2」を「1番1」に切る・@codex P2)。
      const id = registryIdentityOf(pdf.text);
      certParcels.push({
        side, number: side === "建物" ? id.buildingNumber : id.lotNumber, realEstateNumber: parsed.realEstateNumber, address: parsed.address,
      });
    }
    certs.push({
      side, identity, createdAt: at,
      summary: await summarizeRegistryRights({ pdf: pdf.body, text: pdf.text }),
    });
  }

  const coverage = parcelCoverage(expected, certParcels, keys ?? undefined);
  const uncertain: RegistryUncertain | null = rows.length > LANDED_CANDIDATES ? "too_many"
    : unreadable ? "unreadable" : unclassified ? "unclassified"
      : [...ownerOnly].some((id) => !seen.has(id)) ? "no_full_certificate"
        : coverage.unplaced ? "unplaced_parcel" : null;
  return {
    hasRows: rows.length > 0, readAny, certs, ownerCerts,
    missing: required.filter((s) => !certs.some((c) => c.side === s)), missingParcels: coverage.missing, uncertain,
  };
}

const ownerKey = (list: Owner[]) => list
  .map((x) => {
    const share = parseShare(x.share);
    return `${normalizeName(x.name)}:${share ? `${share.num}/${share.den}` : "-"}`;
  })
  .sort().join("\n");

function ownersFacts(data: LandedCertificates): Extract<RegistryFacts, { status: "ok" }>["owners"] {
  if (!data.certs.length) return null;
  const oldest = data.certs.reduce((m, c) => (c.createdAt < m ? c.createdAt : m), data.certs[0].createdAt);
  const usedOwnerCerts = new Set<LandedCertificates["ownerCerts"][number]>();
  // ownerCerts は新しい順なので、同じ物件で最初に当たったものが最新。
  const sets = data.certs.map((c) => {
    const newer = data.ownerCerts.find((x) => x.identity === c.identity && x.createdAt > c.createdAt);
    if (newer) {
      usedOwnerCerts.add(newer);
      return { list: newer.list, confirmed: newer.confirmed };
    }
    return {
      list: (c.summary?.currentOwners ?? []).map((x) => ({ name: x.name, share: x.share })),
      confirmed: !!c.summary && c.summary.hasKouku && c.summary.ownersConfirmed,
    };
  });
  // どの全部事項のものか結びつかない新しい所有者事項は、黙って捨てず名義に足す(違えば不一致に出る)。
  for (const x of data.ownerCerts) {
    if (x.createdAt > oldest && !data.certs.some((c) => c.identity === x.identity)) {
      usedOwnerCerts.add(x);
      sets.push({ list: x.list, confirmed: x.confirmed });
    }
  }
  const merged = new Map<string, Owner>();
  for (const s of sets) for (const x of s.list) if (!merged.has(foldNameVariants(x.name))) merged.set(foldNameVariants(x.name), x);
  const dates = [...data.certs.map((c) => c.createdAt), ...[...usedOwnerCerts].map((x) => x.createdAt)];
  return {
    list: [...merged.values()],
    confirmed: sets.every((s) => s.confirmed),
    attachmentCreatedAt: oldest,
    newestCreatedAt: dates.reduce((m, d) => (d > m ? d : m), dates[0]),
    differsAcross: new Set(sets.map((s) => ownerKey(s.list))).size > 1,
  };
}

async function loadLandedFacts(propertyId: string, o: LoadOptions): Promise<RegistryFacts> {
  const data = await loadLandedCertificates(propertyId, o);
  if (!data.hasRows) return { status: "none" };
  if (!data.readAny) return { status: "unreadable" };
  const { certs } = data;
  const oldest = certs.length ? certs.reduce((m, c) => (c.createdAt < m ? c.createdAt : m), certs[0].createdAt) : null;
  return {
    status: "ok",
    missing: data.missing,
    ...(data.missingParcels.length ? { missingParcels: data.missingParcels } : {}),
    uncertain: data.uncertain,
    certificates: certs.map((c) => ({ side: c.side, createdAt: c.createdAt })),
    rights: oldest ? {
      activeRights: certs.reduce((n, c) => n + (c.summary?.activeRights.length ?? 0), 0),
      readable: certs.every((c) => !!c.summary?.hasKouku),
      attachmentCreatedAt: oldest,
    } : null,
    owners: o.includeOwners ? ownersFacts(data) : null,
  };
}

/**
 * 照合に使う謄本の値を集める(読み取りの部品は変えず、呼ぶだけ)。
 * - 土地のある物件(戸建・土地・一棟)は、土地と建物それぞれの全筆を読む(loadLandedCertificates)。
 * - それ以外の担保は全部事項だけ(所有者事項には載らない)。担保は登記の現況と同じ「全部事項の最新の1件」。
 * - 売主名と比べる所有者は、いちばん新しい謄本から。読み取りが怪しければ confirmed=false(比べない)。
 * ⚠結果には氏名が入る。ログ・監査に出さない(例外の中身も出さない)。includeOwners=false なら氏名を持たない。
 */
export async function loadCrosscheckRegistry(
  propertyId: string, o: { kindBase: BasePropertyKind | null; includeOwners: boolean; targetParcels?: readonly string[] | null },
): Promise<RegistryFacts> {
  if (isLandedKind(o.kindBase)) return loadLandedFacts(propertyId, { kindBase: o.kindBase, includeOwners: o.includeOwners, targetParcels: o.targetParcels });

  const rows = await prisma.attachment.findMany({
    where: { propertyId, type: "registry", isDeleted: false },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: { fileUrl: true, registryCertificateType: true, createdAt: true },
  });
  if (!rows.length) return { status: "none" };

  let rights: Extract<RegistryFacts, { status: "ok" }>["rights"] = null;
  let owners: Extract<RegistryFacts, { status: "ok" }>["owners"] = null;
  let readAny = false;

  const done = () => rights !== null && (!o.includeOwners || owners !== null);

  for (const a of rows) {
    const at = a.createdAt.toISOString();
    const pdf = await readRegistryPdf(a.fileUrl);
    const full = !!pdf && isFullCertificateText(pdf.text);
    if (!full && a.registryCertificateType === "all") {
      // 全部事項と分かっている添付が読めない=登記の現況と同じく判定できない。
      rights ??= { activeRights: 0, readable: false, attachmentCreatedAt: at };
      if (o.includeOwners) owners ??= { list: [], confirmed: false, attachmentCreatedAt: at };
      readAny = true;
      if (done()) break;
      continue;
    }
    if (!pdf) {
      // 所有者事項と分かっている添付が読めないのに古い謄本で比べない。種別が空なら次を見る。
      if (a.registryCertificateType === "owner" && o.includeOwners) owners ??= { list: [], confirmed: false, attachmentCreatedAt: at };
      continue;
    }
    readAny = true;
    if (full) {
      if (rights === null || (o.includeOwners && owners === null)) {
        const summary = await summarizeRegistryRights({ pdf: pdf.body, text: pdf.text });
        rights ??= summary
          ? { activeRights: summary.activeRights.length, readable: summary.hasKouku, attachmentCreatedAt: at }
          : { activeRights: 0, readable: false, attachmentCreatedAt: at };
        if (o.includeOwners) {
          owners ??= {
            list: summary ? summary.currentOwners.map((x) => ({ name: x.name, share: x.share })) : [],
            confirmed: !!summary && summary.hasKouku && summary.ownersConfirmed,
            attachmentCreatedAt: at,
          };
        }
      }
    } else if (o.includeOwners && owners === null) {
      const list = parseRegistryOwnerTable(pdf.text);
      // 種別が空で所有者の表も無い添付は謄本として扱わない(次を見る)。
      if (list?.length || a.registryCertificateType === "owner") {
        owners = { list: (list ?? []).map((x) => ({ name: x.name, share: x.share })), confirmed: !!list?.length, attachmentCreatedAt: at };
      }
    }
    if (done()) break;
  }

  if (!readAny) return { status: "unreadable" };
  return {
    status: "ok",
    rights,
    owners,
  };
}
