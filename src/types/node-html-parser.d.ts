/** The HTML parser already bundled with Next.js; only the extraction surface we use. */
declare module "next/dist/compiled/node-html-parser" {
  interface HTMLElement {
    readonly structuredText: string;
    querySelectorAll(selector: string): HTMLElement[];
    remove(): void;
  }
  export function parse(html: string): HTMLElement;
}
