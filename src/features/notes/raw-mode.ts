const STORAGE_KEY = "aro-editor-raw";
const CHANGE_EVENT = "aro-editor-raw-change";

export function readRawMode(): boolean { return window.localStorage.getItem(STORAGE_KEY) === "true"; }
export function writeRawMode(raw: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, String(raw));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function subscribeRawMode(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
