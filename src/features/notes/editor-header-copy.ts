import { defineCopy } from "@/lib/i18n/copy";

export const EDITOR_HEADER_COPY = defineCopy({
  ko: {
    more: "노트 더보기", addTag: "태그 추가", removeTag: (tag: string) => `${tag} 태그 삭제`,
    aliases: (count: number) => `별칭 ${count}`, updated: "마지막 수정",
    outgoing: (count: number) => `연결 ${count}`, backlinks: (count: number) => `백링크 ${count}`,
    format: "본문 서식", heading: "제목 단계 변경", bullet: "글머리 목록", task: "할 일",
    code: "인라인 코드", wiki: "노트 연결",
  },
  en: {
    more: "More note actions", addTag: "Add tag", removeTag: (tag: string) => `Remove tag ${tag}`,
    aliases: (count: number) => `Aliases ${count}`, updated: "Last edited",
    outgoing: (count: number) => `Links ${count}`, backlinks: (count: number) => `Backlinks ${count}`,
    format: "Body formatting", heading: "Cycle heading level", bullet: "Bullet list", task: "Task item",
    code: "Inline code", wiki: "Link a note",
  },
});
