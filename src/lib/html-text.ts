import { parse } from "node-html-parser";

/** Extract readable blocks and decode references once, shared by intake and legacy previews. */
export function htmlText(raw: string): string {
  const document = parse(raw.replace(/<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>/gi, ""));
  for (const element of document.querySelectorAll("head,script,style,nav,noscript")) element.remove();
  return document.structuredText;
}
