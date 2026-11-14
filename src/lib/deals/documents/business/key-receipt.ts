import { z } from "zod";
import { isoDate } from "../../schema-parts";
import { html } from "../html";
import { documentHtml } from "../layout";
import { DocOptionError } from "./receipts";
import { dateJa, headTable, namesOf, partiesOf, propertyLabel, signBox, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 番号・種類は空でもよい(番号が分からないことがある・2026-11-14 発注者)。 */
const keyRow = z.object({ label: z.string().trim().max(50), count: z.number().int().min(1).max(99) }).strict();
export const keyReceiptOptionsSchema = z.object({
  /** 受領者 = "self"(自社)か自社でない買主の当事者 ID。 */
  receiver: z.string().min(1).max(40),
  keys: z.array(keyRow).max(30),
  receivedOn: isoDate.nullable(),
}).strict();
export type KeyReceiptOptions = z.output<typeof keyReceiptOptionsSchema>;

/** 選べる受領者と初期値(自社の買主がいれば自社、なければ最初の買主・計画の読み替え 2)。 */
export function keyReceiverChoices(c: BusinessDocContext): { choices: Choice[]; initial: string } {
  const buyers = partiesOf(c.deal, "buyer");
  const others = buyers.filter((p) => !p.isSelf);
  return {
    choices: [{ value: "self", label: `${c.company.nameJa}(自社)` }, ...others.map((p) => ({ value: p.id, label: p.name }))],
    initial: buyers.some((p) => p.isSelf) || !others.length ? "self" : others[0].id,
  };
}

/** 鍵の行が無いときに出す、手で書く空の行の数(2026-11-14 発注者「デフォルトで5つ」)。 */
export const BLANK_KEY_ROWS = 5;
/** 手で書く行の高さ(空の行がつぶれないように)。 */
const KEY_RECEIPT_CSS = "tr.blank td { height: 2.4em; }";

/**
 * 鍵受領書(依頼書 4.3)。宛先は売主。受領者の署名・押印の欄は空欄で、自社が受け取るときも角印は付けない。
 * 鍵の行が無いときは、番号と本数を手で書く空の行を BLANK_KEY_ROWS 行出す(合計の本数も空ける)。
 */
export function buildKeyReceipt(c: BusinessDocContext, o: KeyReceiptOptions): { html: string; rows: ValueRow[] } {
  let receiver: { name: string; address: string | null };
  if (o.receiver === "self") receiver = { name: c.company.nameJa, address: c.company.address || null };
  else {
    const p = partiesOf(c.deal, "buyer").find((x) => x.id === o.receiver && !x.isSelf);
    if (!p) throw new DocOptionError("受け取る人を選び直してください");
    receiver = { name: p.name, address: p.address };
  }
  const sellers = namesOf(partiesOf(c.deal, "seller"));
  const handwritten = o.keys.length === 0;
  const total = o.keys.reduce((a, k) => a + k.count, 0);

  const body = html`
<h1>鍵受領書</h1>
<div class="meta"><div class="customer">${sellers ?? ""} 様</div><div class="right">${o.receivedOn ? dateJa(o.receivedOn) : "　　年　　月　　日"}</div></div>
${headTable([["物件", propertyLabel(c.deal)]])}
<h2>受け取った鍵</h2>
<table>
<tr><th>鍵の番号・種類</th><th class="num" style="width:25%">本数</th></tr>
${handwritten
    ? Array.from({ length: BLANK_KEY_ROWS }, () => html`<tr class="blank"><td>　</td><td class="num">本</td></tr>`)
    : o.keys.map((k) => html`<tr><td>${k.label || "　"}</td><td class="num">${k.count}本</td></tr>`)}
<tr class="total"><th>合計</th><td class="num">${handwritten ? "合計　　　本" : `合計 ${total}本`}</td></tr>
</table>
<p>上記の鍵を、確かに受け取りました。</p>
<h2>受領者</h2>
${headTable([["住所", receiver.address], ["氏名(名称)", receiver.name]])}
${signBox("署名・押印")}`;
  return {
    html: documentHtml({ title: "鍵受領書", font: "mincho", body, css: KEY_RECEIPT_CSS }),
    rows: [
      { label: "書類", value: "鍵受領書" }, { label: "宛先", value: sellers }, { label: "物件", value: propertyLabel(c.deal) },
      { label: "受領日", value: o.receivedOn },
      ...(handwritten
        ? [{ label: "鍵の番号・本数", value: `手書きの欄(${BLANK_KEY_ROWS}行)` }]
        : [...o.keys.map((k) => ({ label: k.label || "(番号なし)", value: k.count })), { label: "合計本数", value: total }]),
      { label: "受領者", value: receiver.name },
    ],
  };
}
