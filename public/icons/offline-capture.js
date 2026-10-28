import { DraftError, LOCK_NAME, LEGACY_STORAGE_KEY, migrateDrafts, readDrafts, writeDrafts, prepareFlush, flushDrafts } from "./offline-capture-queue.js";
import { offlineLocale, offlineDate, OFFLINE_COPY, draftErrorText } from "./offline-capture-display.js";

const element = (id) => document.getElementById(id);
const locale = offlineLocale(document.cookie, navigator.languages);
const copy = OFFLINE_COPY[locale];
document.documentElement.lang = locale;
document.title = copy.pageTitle;
document.querySelectorAll("[data-copy]").forEach(node => { node.textContent = copy[node.dataset.copy]; });
element("online-navigation").setAttribute("aria-label", copy.navigation);
const status = element("status");
let confirmation = null; // Session identity is deliberately never persisted.
let busy = false;
let deleting = null;
const deleteDialog = element("delete-dialog");

function closeDelete() {
  if (busy) return;
  deleting = null;
  deleteDialog.close();
}

function clearConfirmation() {
  confirmation = null;
  element("confirmation").hidden = true;
}

function render() {
  const drafts = readDrafts(localStorage);
  element("count").textContent = `${drafts.length} / 50`;
  const list = element("drafts");
  list.replaceChildren();
  if (!drafts.length) list.textContent = copy.empty;
  for (const draft of drafts) {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = draft.title || draft.text.split("\n")[0].slice(0, 120) || copy.savedLink;
    const date = document.createElement("p");
    date.className = "secondary";
    date.textContent = offlineDate(draft.createdAt, locale);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = copy.review;
    const text = document.createElement("pre");
    text.textContent = draft.text;
    const url = document.createElement("p");
    url.textContent = draft.url;
    details.append(summary, text, url);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = copy.remove;
    remove.addEventListener("click", () => {
      if (busy) return;
      clearConfirmation();
      deleting = draft.requestId;
      element("delete-name").textContent = title.textContent;
      element("delete-error").textContent = "";
      deleteDialog.showModal();
      element("delete-cancel").focus();
    });
    article.append(title, date, details, remove);
    list.append(article);
  }
  element("prepare").disabled = busy || drafts.length === 0;
}

const fetcher = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });

async function run(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  element("editor").disabled = true;
  try {
    if (!navigator.locks) throw new DraftError("locks", copy.locks);
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new DraftError("locked", copy.locked);
      await navigator.locks.request(LEGACY_STORAGE_KEY, async () => migrateDrafts(localStorage));
      await action();
    });
  } catch (error) {
    clearConfirmation();
    status.textContent = draftErrorText(error, copy);
    if (deleting) element("delete-error").textContent = status.textContent;
  } finally {
    busy = false;
    element("editor").disabled = false;
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    try { render(); } catch (error) {
      element("prepare").disabled = true;
      status.textContent = draftErrorText(error, copy);
    }
  }
}

element("capture-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!element("consent").checked) return;
  run(async () => {
    clearConfirmation();
    const drafts = readDrafts(localStorage);
    const draft = {
      requestId: crypto.randomUUID(), createdAt: new Date().toISOString(),
      text: element("text").value, title: element("title").value, url: element("url").value,
    };
    writeDrafts(localStorage, [...drafts, draft]);
    element("text").value = "";
    element("title").value = "";
    element("url").value = "";
    status.textContent = copy.saved;
  });
});

element("prepare").addEventListener("click", () => run(async () => {
  clearConfirmation();
  confirmation = await prepareFlush(localStorage, fetcher);
  element("owner").textContent = copy.owner(confirmation.ownerId, readDrafts(localStorage).length);
  element("confirmation").hidden = false;
  status.textContent = copy.reviewOwner;
}));
element("send").addEventListener("click", () => run(async () => {
  const approved = confirmation;
  clearConfirmation();
  status.textContent = copy.sending;
  const sent = await flushDrafts(localStorage, approved, fetcher);
  status.textContent = copy.sent(sent);
}));
element("cancel").addEventListener("click", clearConfirmation);
element("delete-cancel").addEventListener("click", closeDelete);
deleteDialog.addEventListener("cancel", event => {
  if (busy) event.preventDefault();
  else deleting = null;
});
element("delete-confirm").addEventListener("click", () => {
  const selected = deleting;
  if (!selected) return;
  run(async () => {
    clearConfirmation();
    writeDrafts(localStorage, readDrafts(localStorage).filter(item => item.requestId !== selected));
    deleting = null;
    deleteDialog.close();
    status.textContent = copy.deleted;
  });
});
window.addEventListener("storage", () => {
  clearConfirmation();
  closeDelete();
  if (!busy) {
    try { render(); } catch (error) {
      status.textContent = draftErrorText(error, copy);
    }
  }
});
window.addEventListener("offline", () => {
  clearConfirmation();
  status.textContent = copy.offline;
});
window.addEventListener("pageshow", clearConfirmation);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearConfirmation(); });

run(async () => {});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(async (registration) => {
      if (!registration.active) {
        const worker = registration.installing ?? registration.waiting;
        if (!worker) throw new Error("Offline worker was not installed");
        await new Promise((resolve, reject) => {
          const changed = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              worker.removeEventListener("statechange", changed);
              if (worker.state === "activated") resolve();
              else reject(new Error("Offline worker installation failed"));
            }
          };
          worker.addEventListener("statechange", changed);
          changed();
        });
      }
      await navigator.serviceWorker.ready;
    })
    .then(() => { element("readiness").textContent = copy.ready; element("readiness").dataset.ready = "true"; })
    .catch(() => { element("readiness").textContent = copy.installFailed; element("readiness").dataset.ready = "false"; });
} else {
  element("readiness").textContent = copy.unavailable;
}
