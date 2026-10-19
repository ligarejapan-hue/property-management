/**
 * カード (UIの統一と押した手応え 第2回・2026-10-19)。
 *
 * 規約: 枠 gray-200 + 角丸 lg + 白(dark: gray-900)。
 * interactive = 押せるカード(一覧の1件など)。乗せる/キーボードで選ぶと 1px 上がり、
 * 枠が藍に・影が付く。押せないカードには付けない(動くのに押せないと迷う)。
 * <Link> や <button> をカードにするときは cardClassName(true) を直接貼る。
 */
import type { HTMLAttributes } from "react";

const BASE = "rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900";
const INTERACTIVE =
  "transition-[translate,box-shadow,border-color] duration-180 ease-out-soft hover:-translate-y-px hover:border-indigo-400 hover:shadow-md focus-visible:border-indigo-400 focus-visible:shadow-md motion-reduce:hover:translate-y-0 dark:hover:border-indigo-500";

export function cardClassName(interactive = false): string {
  return interactive ? `${BASE} ${INTERACTIVE}` : BASE;
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive = false, className, ...rest }: CardProps) {
  return <div className={`${cardClassName(interactive)}${className ? ` ${className}` : ""}`} {...rest} />;
}
