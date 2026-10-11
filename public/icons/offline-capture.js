import { LOCK_NAME, readDrafts, writeDrafts, prepareFlush, flushDrafts } from "./offline-capture-queue.js";

const element = (id) => document.getElementById(id);
const status = element("status");
let confirmation = null; // Session identity is deliberately never persisted.
let busy = false;

function clearConfirmation() {
  confirmation = null;
  element("confirmation").hidden = true;
}

function render() {
  const drafts = readDrafts(localStorage);
  element("count").textContent = `${drafts.length} / 50`;
  const list = element("drafts");
  list.replaceChildren();
  if (!drafts.length) list.textContent = "No local drafts yet.";
  for (const draft of drafts) {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = draft.title || draft.text.split("\n")[0].slice(0, 120) || "Saved link";
    const date = document.createElement("p");
    date.className = "secondary";
    date.textContent = new Date(draft.createdAt).toLocaleString();
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Review draft";
    const text = document.createElement("pre");
    text.textContent = draft.text;
    const url = document.createElement("p");
    url.textContent = draft.url;
    details.append(summary, text, url);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "Delete local draft";
    remove.addEventListener("click", () => run(async () => {
      clearConfirmation();
      writeDrafts(localStorage, readDrafts(localStorage).filter((item) => item.requestId !== draft.requestId));
      status.textContent = "Local draft deleted.";
    }));
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
    if (!navigator.locks) throw new Error("Safe cross-tab draft storage is unavailable in this browser. Use a browser with Web Locks on HTTPS or localhost.");
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("Another tab is saving or sending drafts. Wait for it to finish, then try again.");
      await action();
    });
  } catch (error) {
    clearConfirmation();
    status.textContent = error instanceof Error ? error.message : "Operation failed. Drafts were kept.";
  } finally {
    busy = false;
    element("editor").disabled = false;
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    try { render(); } catch (error) {
      element("prepare").disabled = true;
      status.textContent = error instanceof Error ? error.message : "Cannot read local drafts.";
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
    status.textContent = "Saved locally, unencrypted. Nothing was sent.";
  });
});

element("prepare").addEventListener("click", () => run(async () => {
  clearConfirmation();
  confirmation = await prepareFlush(localStorage, fetcher);
  element("owner").textContent = `Authenticated owner: ${confirmation.ownerId}. ${readDrafts(localStorage).length} drafts ready for review.`;
  element("confirmation").hidden = false;
  status.textContent = "Check the owner above. Sending requires another explicit confirmation.";
}));
element("send").addEventListener("click", () => run(async () => {
  const approved = confirmation;
  clearConfirmation();
  status.textContent = "Sending oldest drafts first...";
  const sent = await flushDrafts(localStorage, approved, fetcher);
  status.textContent = `${sent} drafts sent to the inbox and removed locally.`;
}));
element("cancel").addEventListener("click", clearConfirmation);
window.addEventListener("storage", () => {
  clearConfirmation();
  if (!busy) {
    try { render(); } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Cannot read local drafts.";
    }
  }
});
window.addEventListener("offline", () => {
  clearConfirmation();
  status.textContent = "Offline. You can save locally; sending requires an online login and confirmation.";
});
window.addEventListener("pageshow", clearConfirmation);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearConfirmation(); });

try { render(); } catch (error) {
  element("prepare").disabled = true;
  status.textContent = error instanceof Error ? error.message : "Cannot read local drafts.";
}
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
    .then(() => { element("readiness").textContent = "Offline page ready on this device. Drafts stay local until you confirm sending."; })
    .catch(() => { element("readiness").textContent = "Offline page installation failed. Keep this page open; do not rely on offline reopening yet."; });
} else {
  element("readiness").textContent = "Offline reopening is unavailable here. Use HTTPS or localhost and a browser with service workers.";
}
