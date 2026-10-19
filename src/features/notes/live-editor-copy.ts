import { defineCopy } from "@/lib/i18n/copy";

export const LIVE_EDITOR_COPY = defineCopy({
  ko: {
    raw: "원문",
    rawLabel: "원문 보기",
    linkActions: "링크 작업",
    openLink: "열기",
    editLink: "수정",
    editSource: (text: string) => `${text} · 원문 편집`,
    wikiLabel: (label: string, target: string) => `${label}, ${target}에 연결 · 원문 편집`,
  },
  en: {
    raw: "Source",
    rawLabel: "View source",
    linkActions: "Link actions",
    openLink: "Open",
    editLink: "Edit",
    editSource: (text) => `${text} · Edit source`,
    wikiLabel: (label, target) => `${label}, links to ${target} · Edit source`,
  },
});
