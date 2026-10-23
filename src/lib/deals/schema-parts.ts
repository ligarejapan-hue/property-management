import { z } from "zod";

/** 文字の欄: 前後の空白を落とし、空なら null。 */
export const text = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === "" ? null : v));
export const yenInt = z.number().int().min(0).max(1_000_000_000_000);
