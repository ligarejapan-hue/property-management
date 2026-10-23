import { linesFromPlainText, type StrikeLine } from "../lines";

/** 【…】で囲んだ文字＝下線あり（抹消事項）。PDF から読んだときと同じ形の行にする。 */
export function marked(src: string): StrikeLine[] {
  return src
    .trim()
    .split("\n")
    .map((raw) => {
      const text: string[] = [];
      const struck: boolean[] = [];
      let on = false;
      for (const ch of Array.from(raw)) {
        if (ch === "【") on = true;
        else if (ch === "】") on = false;
        else {
          text.push(ch);
          struck.push(on && ch.trim() !== "");
        }
      }
      return { page: 1, text: text.join(""), struck };
    });
}

/** 下線を落とした（テキスト貼り付けと同じ）形 */
export function plain(src: string): StrikeLine[] {
  return linesFromPlainText(src.trim().replace(/[【】]/g, ""));
}

export const HEADER = `
┃順位番号 │ 登 記 の 目 的 │受付年月日・受付番号 │ 権 利 者 そ の 他 の 事 項 ┃
┠─────┼────────────────┼───────────┼─────────────────────┨`;

/** 甲区の表で包む */
export const kouWith = (rows: string) => `
┃ 権 利 部 （ 甲 区 ） （所 有 権 に 関 す る 事 項） ┃
┠─────┬────────────────┬───────────┬─────────────────────┨${HEADER}
${rows.trim()}
┗━━━━━┷━━━━━━━━━━━━━━━━┷━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━┛`;

/** 乙区の表で包む */
export const otsuWith = (rows: string) => `
┃ 権 利 部 （ 乙 区 ） （所 有 権 以 外 の 権 利 に 関 す る 事 項） ┃
┠─────┬────────────────┬───────────┬─────────────────────┨${HEADER}
${rows.trim()}
┗━━━━━┷━━━━━━━━━━━━━━━━┷━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━┛`;
