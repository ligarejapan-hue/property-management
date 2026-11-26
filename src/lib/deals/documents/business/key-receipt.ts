import { z } from "zod";
import { isoDate } from "../../schema-parts";
import { html } from "../html";
import { documentHtml } from "../layout";
import { DocOptionError } from "./receipts";
import { DEFAULT_MAILBOX } from "../../mailbox";
import { dealKeysSchema } from "../../deal-keys";
import { addresseeOf, dateJa, headTable, namesOf, partiesOf, propertyLabel, signBox, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 鍵の行は取引の鍵の記録と同じ形(番号・種類は空でもよい・src/lib/deals/deal-keys.ts)。 */
export const keyReceiptOptionsSchema = z.object({
  /** 受領者 = "self"(自社)か自社でない買主の当事者 ID。 */
  receiver: z.string().min(1).max(40),
  keys: dealKeysSchema,
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
 * 集合ポスト(取引の物件タブ・2026-11-26 発注者): 「なし」でなければ解除番号と解除方法の欄を出す。入っていない欄は手で書く空欄。
 */
export function buildKeyReceipt(c: BusinessDocContext, o: KeyReceiptOptions): { html: string; rows: ValueRow[] } {
  let receiver: { name: string; address: string | null };
  if (o.receiver === "self") receiver = { name: c.company.nameJa, address: c.company.address || null };
  else {
    const p = partiesOf(c.deal, "buyer").find((x) => x.id === o.receiver && !x.isSelf);
    if (!p) throw new DocOptionError("受け取る人を選び直してください");
    receiver = { name: p.name, address: p.address };
  }
  const sellers = addresseeOf(partiesOf(c.deal, "seller"));
  const handwritten = o.keys.length === 0;
  const total = o.keys.reduce((a, k) => a + k.count, 0);
  const mailbox = c.deal.mailbox ?? DEFAULT_MAILBOX;
  const showMailbox = mailbox.status !== "none";

  const body = html`
<h1>鍵受領書</h1>
<div class="meta"><div class="customer">${sellers}</div><div class="right">${o.receivedOn ? dateJa(o.receivedOn) : "　　年　　月　　日"}</div></div>
${headTable([["物件", propertyLabel(c.deal)]])}
<h2>受け取った鍵</h2>
<table>
<tr><th>鍵の番号・種類</th><th class="num" style="width:25%">本数</th></tr>
${handwritten
    ? Array.from({ length: BLANK_KEY_ROWS }, () => html`<tr class="blank"><td>　</td><td class="num">本</td></tr>`)
    : o.keys.map((k) => html`<tr><td>${k.label || "　"}</td><td class="num">${k.count}本</td></tr>`)}
<tr class="total"><th>合計</th><td class="num">${handwritten ? "合計　　　本" : `合計 ${total}本`}</td></tr>
</table>
${showMailbox ? html`<h2>集合ポスト</h2>
<table>
<tr class="${mailbox.code ? "" : "blank"}"><th style="width:25%">解除番号</th><td>${mailbox.code ?? "　"}</td></tr>
<tr class="${mailbox.method ? "" : "blank"}"><th>解除方法</th><td>${mailbox.method ?? "　"}</td></tr>
</table>` : ""}
<p>${showMailbox ? "上記の鍵と集合ポストの解除番号・解除方法を、確かに受け取りました。" : "上記の鍵を、確かに受け取りました。"}</p>
<h2>受領者</h2>
${headTable([["住所", receiver.address], ["氏名(名称)", receiver.name]])}
${signBox("署名・押印")}`;
  return {
    html: documentHtml({ title: "鍵受領書", font: "mincho", body, css: KEY_RECEIPT_CSS }),
    rows: [
      { label: "書類", value: "鍵受領書" }, { label: "宛先", value: namesOf(partiesOf(c.deal, "seller")) }, { label: "物件", value: propertyLabel(c.deal) },
      { label: "受領日", value: o.receivedOn },
      ...(handwritten
        ? [{ label: "鍵の番号・本数", value: `手書きの欄(${BLANK_KEY_ROWS}行)` }]
        : [...o.keys.map((k) => ({ label: k.label || "(番号なし)", value: k.count })), { label: "合計本数", value: total }]),
      ...(showMailbox
        ? [{ label: "集合ポストの解除番号", value: mailbox.code ?? "手書きの欄" }, { label: "集合ポストの解除方法", value: mailbox.method ?? "手書きの欄" }]
        : []),
      { label: "受領者", value: receiver.name },
    ],
  };
}
