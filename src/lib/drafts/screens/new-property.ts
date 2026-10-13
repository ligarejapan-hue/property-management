/** 新規物件登録の小窓の控え(設計書 §2 S6)。 */
import { z } from "zod/v4";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import { buildingChoiceSchema } from "./building-choice";

export interface NewPropertyDraft {
  propertyType: string;
  postalCode: string;
  address: string;
  addressEdited: boolean;
  lotNumber: string;
  buildingName: string;
  roomNo: string;
  introductionRoute: string;
  note: string;
  buildingChoice: BuildingChoice;
}

export const EMPTY_NEW_PROPERTY_DRAFT: NewPropertyDraft = {
  propertyType: "",
  postalCode: "",
  address: "",
  addressEdited: false,
  lotNumber: "",
  buildingName: "",
  roomNo: "",
  introductionRoute: "",
  note: "",
  buildingChoice: { kind: "auto" },
};

const schema = z.object({
  propertyType: z.string(),
  postalCode: z.string(),
  address: z.string(),
  addressEdited: z.boolean(),
  lotNumber: z.string(),
  buildingName: z.string(),
  roomNo: z.string(),
  introductionRoute: z.string(),
  note: z.string(),
  buildingChoice: buildingChoiceSchema,
});

export function parseNewPropertyDraft(d: unknown): NewPropertyDraft | null {
  const r = schema.safeParse(d);
  return r.success ? r.data : null;
}

/**
 * 入力が大きすぎて控えられないときに、送信中の印だけを残すための中身(空)。
 * 戻ったときは「登録されたか確かめて」の帯だけが出る(入力は戻らない)。
 */
export function compactNewPropertyDraftForPending(): NewPropertyDraft {
  return EMPTY_NEW_PROPERTY_DRAFT;
}

export function isNewPropertyDraftEmpty(d: NewPropertyDraft): boolean {
  return (
    d.propertyType === "" &&
    d.postalCode === "" &&
    d.address === "" &&
    d.lotNumber === "" &&
    d.buildingName === "" &&
    d.roomNo === "" &&
    d.introductionRoute === "" &&
    d.note === "" &&
    d.buildingChoice.kind === "auto"
  );
}
