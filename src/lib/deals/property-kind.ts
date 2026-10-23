import type { BasePropertyKind } from "./constants";

/**
 * 物件の種類(PropertyType)を、取引の物件種別に当てる。当てられない種類(店舗・駐車場など)は null
 * =画面で選んでもらう。旧値の building/unit も当てる(既存データに残っている)。
 */
const MAP: Record<string, BasePropertyKind> = {
  apartment_unit: "unit",
  unit: "unit",
  house: "house",
  land: "land",
  apartment_building: "building",
  apartment_block: "building",
  building: "building",
};

export function propertyKindFromPropertyType(t: string): BasePropertyKind | null {
  return MAP[t] ?? null;
}
