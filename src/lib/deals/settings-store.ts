import prisma from "@/lib/prisma";
import { DEAL_SETTINGS_ID, resolveDealSettings, type DealSettingsView } from "./settings";

export async function loadDealSettings(): Promise<DealSettingsView> {
  const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
  return resolveDealSettings(row);
}
