/** Display only. Never transforms persisted draft content or identity. */
export function offlineLocale(cookie, languages) {
  const explicit = /(?:^|;\s*)sb_locale=(ko|en)(?:;|$)/.exec(cookie)?.[1];
  if (explicit) return explicit;
  return /^ko(?:-|$)/i.test(languages[0] ?? "") ? "ko" : "en";
}

const formats = new Map();
function formatter(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(locale, options));
  return formats.get(key);
}

/** Matches the application's formatDateTime, without an application bundle. */
export function offlineDate(value, locale, { timeZone } = {}) {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(time)) return "";
  if (locale === "ko") {
    const parts = formatter("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
    const part = type => parts.find(entry => entry.type === type)?.value ?? "";
    const clock = formatter("ko-KR", { timeZone, hour: "numeric", minute: "2-digit" }).format(time);
    return `${part("year")}-${part("month")}-${part("day")} ${clock}`;
  }
  return formatter("en-US", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(time);
}

export const OFFLINE_COPY = {
  en: {
    pageTitle: "Offline capture | Aro", heading: "Offline capture", brand: "Aro",
    navigation: "Online navigation", open: "Open app", login: "Log in",
    intro: "Save a thought here. Send it to your inbox when you're online.",
    preparing: "Preparing the offline page...", legend: "New local draft",
    thought: "Thought", thoughtLimit: "(up to 20,000 characters)", title: "Title", link: "Link", optional: "(optional)",
    consent: "I agree to save these drafts unencrypted in this browser. Anyone with access to this browser profile can read them, including after logout. Avoid secrets. Browser cleanup can erase drafts.",
    limits: "Limit: 50 drafts, 512 KiB total. Nothing is saved until you choose Save locally. Saved drafts are immutable; delete and save a new draft to change one.",
    save: "Save locally", help: "Installation and offline limits",
    helpBody: "To install, use your browser's Install app or Add to Home Screen menu after the offline page is ready. HTTPS or localhost is required. This page supports offline capture only, not offline note editing or live sync.",
    drafts: "Local drafts", order: "Oldest drafts send first. Deleting removes only the local copy; a draft whose response was lost may already be in your inbox.",
    prepare: "Review owner before sending", sendQuestion: "Send these local drafts to this owner now? Login changes stop sending. Queued capture does not call AI or fetch link contents.",
    send: "Confirm and send queued drafts", cancel: "Cancel", empty: "No local drafts yet.", savedLink: "Saved link", review: "Review draft",
    remove: "Delete local draft", deleteTitle: "Delete this local draft?", deleteBody: "This removes only this browser's copy. A draft whose response was lost may already be in your inbox.",
    deleted: "Local draft deleted.", saved: "Saved locally, unencrypted. Nothing was sent.",
    owner: (id, count) => `Authenticated owner: ${id}. ${count} drafts ready for review.`,
    reviewOwner: "Check the owner above. Sending requires another explicit confirmation.",
    sending: "Sending oldest drafts first...", sent: count => `${count} drafts sent to the inbox and removed locally.`,
    offline: "Offline. You can save locally; sending requires an online login and confirmation.",
    ready: "Offline page ready on this device. Drafts stay local until you confirm sending.",
    installFailed: "Offline page installation failed. Keep this page open; do not rely on offline reopening yet.",
    unavailable: "Offline reopening is unavailable here. Use HTTPS or localhost and a browser with service workers.",
    locks: "Safe cross-tab draft storage is unavailable in this browser. Use a browser with Web Locks on HTTPS or localhost.",
    locked: "Another tab is saving or sending drafts. Wait for it to finish, then try again.",
    failed: "Operation failed. Drafts were kept.", storage: "Draft storage is invalid or exceeds 50 drafts. Existing data was not changed.",
    invalid: "Draft data is invalid. Existing data was not changed.", full: "Local drafts exceed 512 KiB. Delete a draft before saving more.",
    read: "Cannot read local drafts. Browser storage may be blocked or damaged; existing data was not changed.",
    write: "Could not save locally. Storage may be full or blocked. Keep this page open and copy your text.",
    emptySend: "No drafts to send.", auth: "Log in online, then prepare sending again.",
    identity: "Could not verify the current owner. Nothing was sent.", confirmation: "Drafts changed. Review and confirm sending again.",
    ambiguous: "Connection lost. This draft may already be in the inbox. Prepare and confirm again to retry safely.",
    unreadable: "Unreadable response. Draft kept; confirm again to retry the same request safely.",
    unverified: "Unverified response. Draft kept; confirm again to retry safely.",
    http: status => `Sending stopped (HTTP ${status}). Remaining drafts were kept. Log in if needed, then review and confirm again.`,
  },
  ko: {
    pageTitle: "오프라인 캡처 | 아로", heading: "오프라인 캡처", brand: "아로",
    navigation: "온라인 메뉴", open: "앱 열기", login: "로그인",
    intro: "생각을 여기에 저장하세요. 온라인으로 돌아오면 인박스에 보낼 수 있어요.",
    preparing: "오프라인 페이지 준비 중...", legend: "새 로컬 초안",
    thought: "생각", thoughtLimit: "(최대 20,000자)", title: "제목", link: "링크", optional: "(선택)",
    consent: "이 브라우저에 초안을 암호화하지 않고 저장하는 데 동의합니다. 로그아웃 후에도 이 브라우저 프로필에 접근할 수 있는 사람은 초안을 읽을 수 있어요. 비밀 정보는 넣지 마세요. 브라우저 데이터를 지우면 초안이 사라질 수 있어요.",
    limits: "최대 50개, 합계 512 KiB까지 저장해요. 로컬에 저장을 눌러야 저장돼요. 저장한 초안은 수정할 수 없으므로 바꾸려면 삭제 후 새로 저장하세요.",
    save: "로컬에 저장", help: "설치 방법과 오프라인 제한",
    helpBody: "오프라인 페이지가 준비되면 브라우저의 앱 설치 또는 홈 화면에 추가 메뉴를 사용하세요. HTTPS 또는 localhost가 필요해요. 이 페이지는 오프라인 캡처만 지원하며 노트 편집이나 실시간 동기화는 지원하지 않아요.",
    drafts: "로컬 초안", order: "먼저 저장한 초안부터 보내요. 삭제는 로컬 사본만 지워요. 응답이 끊긴 초안은 이미 인박스에 있을\u00a0수\u00a0있어요.",
    prepare: "보내기 전 소유자 확인", sendQuestion: "이 소유자에게 로컬 초안을 지금 보낼까요? 로그인 상태가 바뀌면 전송을 멈춰요. 대기 중인 캡처는 AI를 호출하거나 링크 내용을 가져오지 않아요.",
    send: "확인하고 대기 초안 보내기", cancel: "취소", empty: "아직 로컬 초안이 없어요.", savedLink: "저장한 링크", review: "초안 확인",
    remove: "로컬 초안 삭제", deleteTitle: "이 로컬 초안을 삭제할까요?", deleteBody: "이 브라우저의 사본만 지워요. 응답이 끊긴 초안은 이미 인박스에 있을 수 있어요.",
    deleted: "로컬 초안을 삭제했어요.", saved: "암호화하지 않고 로컬에 저장했어요. 전송한 내용은 없어요.",
    owner: (id, count) => `로그인한 소유자: ${id}. 초안 ${count}개를 확인할 수 있어요.`,
    reviewOwner: "위의 소유자를 확인하세요. 전송하려면 한 번 더 명시적으로 확인해야 해요.",
    sending: "먼저 저장한 초안부터 보내는 중...", sent: count => `초안 ${count}개를 인박스에 보내고 로컬에서 지웠어요.`,
    offline: "오프라인이에요. 로컬 저장은 가능해요. 보내려면 온라인 로그인과 확인이 필요해요.",
    ready: "이 기기에서 오프라인 페이지가 준비됐어요. 보내기를 확인하기 전까지 초안은 로컬에만 있어요.",
    installFailed: "오프라인 페이지를 설치하지 못했어요. 이 페이지를 열어 두세요. 아직 오프라인에서 다시 열 수 있다고 보장할 수 없어요.",
    unavailable: "여기서는 오프라인으로 다시 열 수 없어요. HTTPS 또는 localhost와 서비스 워커를 지원하는 브라우저를 사용하세요.",
    locks: "이 브라우저에서는 여러 탭의 초안을 안전하게 저장할 수 없어요. HTTPS 또는 localhost에서 Web Locks를 지원하는 브라우저를 사용하세요.",
    locked: "다른 탭이 초안을 저장하거나 보내고 있어요. 완료된 뒤 다시 시도하세요.",
    failed: "작업을 완료하지 못했어요. 초안은 유지했어요.", storage: "초안 저장소가 올바르지 않거나 50개를 넘었어요. 기존 데이터는 바꾸지 않았어요.",
    invalid: "초안 데이터가 올바르지 않아요. 기존 데이터는 바꾸지 않았어요.", full: "로컬 초안이 512 KiB를 넘었어요. 저장하려면 초안을 하나 삭제하세요.",
    read: "로컬 초안을 읽을 수 없어요. 저장소가 차단됐거나 손상됐을 수 있어요. 기존 데이터는 바꾸지 않았어요.",
    write: "로컬에 저장하지 못했어요. 저장소가 가득 찼거나 차단됐을 수 있어요. 페이지를 열어 두고 입력한 내용을 복사하세요.",
    emptySend: "보낼 초안이 없어요.", auth: "온라인에서 로그인한 뒤 보내기를 다시 준비하세요.",
    identity: "현재 소유자를 확인하지 못했어요. 전송한 내용은 없어요.", confirmation: "초안이 바뀌었어요. 다시 확인하고 보내세요.",
    ambiguous: "연결이 끊겼어요. 이 초안은 이미 인박스에 있을 수 있어요. 보내기를 다시 준비하고 확인하면 안전하게 재시도할 수 있어요.",
    unreadable: "응답을 읽지 못했어요. 초안은 유지했어요. 같은 요청을 안전하게 재시도하려면 다시 확인하세요.",
    unverified: "응답을 검증하지 못했어요. 초안은 유지했어요. 안전하게 재시도하려면 다시 확인하세요.",
    http: status => `전송을 멈췄어요 (HTTP ${status}). 남은 초안은 유지했어요. 필요하면 로그인한 뒤 다시 확인하고 보내세요.`,
  },
};

export function draftErrorText(error, copy) {
  const key = error?.displayKey;
  if (key === "http") return copy.http(error.status);
  return typeof copy[key] === "string" ? copy[key] : copy.failed;
}
