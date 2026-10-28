import { z } from "zod";
import { text } from "../../schema-parts";
import type { FormDef, FormValues } from "./types";
import { formItems } from "./values";

/**
 * 項目の表から、発行のときの値の形を作る。無い鍵は空欄として読む。
 * 知らない鍵・知らない値は断る(前回の入力は捨てて初期値に・発行は 422)。
 */
export function formValuesSchema(f: FormDef): z.ZodType<FormValues> {
  const shape: Record<string, z.ZodType> = {};
  for (const it of formItems(f)) {
    if (it.choices?.length) {
      const one = z.enum(it.choices.map((c) => c.value) as [string, ...string[]]);
      shape[it.key] = it.multiple ? z.array(one).max(it.choices.length).default([]) : one.nullable().default(null);
    }
    for (const fl of it.fields ?? []) shape[fl.key] = text(fl.max).default(null);
  }
  return z.object(shape).strict() as unknown as z.ZodType<FormValues>;
}
