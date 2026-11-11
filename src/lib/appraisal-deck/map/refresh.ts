/**
 * 「査定のご報告」に周辺地図を入れる・作り直す(2026-11-11)。
 *
 * - 物件の GPS 座標(properties.gps_lat / gps_lng)を中心に、国土地理院ベクトルタイルを取って地図のデータを作る。
 * - 下書きを作った直後(自動・地図がまだないときだけ)と、確認画面の「地図を作り直す」(手動)から呼ぶ。
 * - 手動で作り直したら、確認済みの資料も下書きに戻す(新しい地図を確かめてから表示する)。
 * ⚠AuditLog・ログに緯度経度・地図のデータは残さない(件数と結果だけ)。
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { buildMapFromTiles, fetchGsiTiles, isUsableLocation, MAP_DATA_VERSION, type DeckMapData, type FetchLike } from "./build";
import { geocodeAddress } from "./geocode";

export type MapRefreshResult =
  | { ok: true; buildings: number }
  | { ok: false; reason: "not_found" | "no_location" | "fetch_failed" | "already_has_map" | "not_draft" };

type Deps = {
  fetchImpl?: FetchLike;
  now?: () => Date;
};

export async function refreshDeckMap(
  input: { deckId: string; propertyId: string; userId: string; mode: "auto" | "manual" },
  deps: Deps = {},
): Promise<MapRefreshResult> {
  const deck = await prisma.appraisalDeck.findFirst({
    where: { id: input.deckId, propertyId: input.propertyId },
    select: { id: true, status: true },
  });
  if (!deck) return { ok: false, reason: "not_found" };
  if (input.mode === "auto") {
    // 自動は下書きだけ(確認済みの資料の中身を、確かめないまま変えない・@codex #701)。
    if (deck.status !== "draft") return { ok: false, reason: "not_draft" };
    // 自動は「まだ地図がない」ときだけ(担当者が作り直した地図を上書きしない)。
    const has = await prisma.appraisalDeck.count({ where: { id: deck.id, mapData: { not: Prisma.DbNull } } });
    if (has > 0) return { ok: false, reason: "already_has_map" };
  }
  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: { gpsLat: true, gpsLng: true, address: true },
  });
  const lat = property?.gpsLat == null ? null : Number(property.gpsLat);
  const lng = property?.gpsLng == null ? null : Number(property.gpsLng);
  // GPS 座標がなければ住所から求める(2026-11-11 発注者指示・物件の GPS 座標には保存しない)。
  let center: { lat: number; lng: number } | null = isUsableLocation(lat, lng) ? { lat, lng: lng as number } : null;
  let loc: "gps" | "address" = "gps";
  if (!center) {
    center = await geocodeAddress(property?.address, deps.fetchImpl);
    loc = "address";
  }
  if (!center) {
    await audit(input, { result: "no_location" });
    return { ok: false, reason: "no_location" };
  }
  let map: DeckMapData;
  try {
    const built = buildMapFromTiles(center, await fetchGsiTiles(center, deps.fetchImpl), deps.now?.() ?? new Date());
    // 住所から求めた位置は目安なので、近くの建物を「物件の建物」として塗らない(違う建物を塗らない)。
    map = loc === "address" ? { ...built, p: -1, loc } : { ...built, loc };
  } catch {
    console.warn("[appraisal-deck] 周辺地図を作れませんでした", { deckId: input.deckId });
    await audit(input, { result: "fetch_failed" });
    return { ok: false, reason: "fetch_failed" };
  }
  const data =
    input.mode === "manual"
      ? { mapData: map as object, updatedBy: input.userId, status: "draft", confirmedBy: null, confirmedAt: null }
      : { mapData: map as object };
  const updated = await prisma.appraisalDeck.updateMany({
    // 自動は、取りに行っている間に手動で作られていたら上書きしない。
    // また、取りに行っている間に確認済みにされた資料には足さない(確かめていない地図を表示しない・@codex #701)。
    where: input.mode === "auto" ? { id: deck.id, status: "draft", mapData: { equals: Prisma.DbNull } } : { id: deck.id },
    data,
  });
  // 自動で 0 件=取りに行っている間に地図が作られた・確認済みにされた(どちらも足さない)。
  if (updated.count !== 1) return { ok: false, reason: input.mode === "auto" ? "not_draft" : "not_found" };
  await audit(input, { result: "ok", buildings: map.b.length, loc });
  return { ok: true, buildings: map.b.length };
}

async function audit(input: { deckId: string; propertyId: string; userId: string; mode: string }, detail: Record<string, unknown>) {
  await writeAuditLog({
    userId: input.userId,
    action: "appraisal_deck_map_build",
    targetTable: "appraisal_decks",
    targetId: input.deckId,
    detail: { propertyId: input.propertyId, mode: input.mode, ...detail },
  });
}

/** 資料に入れる前に形を確かめる(壊れたデータで資料を出さない)。 */
const delta = z.array(z.number().int()).max(200_000);
export const deckMapDataSchema = z
  .object({
    version: z.literal(MAP_DATA_VERSION),
    builtAt: z.string().max(40),
    ex: z.number().positive().max(5000),
    ey: z.number().positive().max(5000),
    b: z.array(delta).max(100_000),
    p: z.number().int().min(-1),
    r: z.array(delta).max(100_000),
    w: z.array(delta).max(100_000),
    v: z.array(delta).max(100_000),
    t: z.array(z.array(z.union([z.number(), z.string().max(20)]))).max(100_000),
    bh: z.array(delta).max(100_000).default([]),
    loc: z.enum(["gps", "address"]).optional(),
    wh: z.array(delta).max(100_000).default([]),
  })
  .strict();

export function parseDeckMapData(v: unknown): DeckMapData | null {
  if (v == null) return null;
  const r = deckMapDataSchema.safeParse(v);
  return r.success ? (r.data as DeckMapData) : null;
}
