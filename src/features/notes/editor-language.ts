import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { parseWikiLinks } from "@/lib/wikilinks";

/** Consume wiki tokens before CommonMark's bracket stack can treat them as links. */
export function editorLanguage() {
  return markdown({
    base: markdownLanguage,
    extensions: {
      defineNodes: ["WikiLink"],
      parseInline: [{
        name: "WikiLink",
        before: "Link",
        parse(context, next, from) {
          if (next !== 91 || context.char(from + 1) !== 91) return -1;
          for (let to = from + 2; to < context.end; to++) {
            const char = context.char(to);
            if (char === 10 || char === 91) return -1;
            if (char !== 93) continue;
            if (context.char(to + 1) !== 93 || !parseWikiLinks(context.slice(from, to + 2)).length) return -1;
            return context.addElement(context.elt("WikiLink", from, to + 2));
          }
          return -1;
        },
      }],
    },
  });
}
