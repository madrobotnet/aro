import type { EditorView } from "@codemirror/view";
import { compositionActive } from "./composition-edits";
import { liveLabels } from "./live-markdown-ranges";
import { isComposing } from "./wikilink-autocomplete";

export class LiveLinkPopover {
  popover: HTMLElement | null = null;
  readonly closePopover = () => {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    this.view.focus();
  };
  readonly outsidePress = (event: Event) => {
    if (event.target instanceof Node && !this.popover?.contains(event.target)) this.closePopover();
  };
  readonly dismissKey = (event: KeyboardEvent) => {
    if (!this.popover) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closePopover();
    } else if (!event.ctrlKey && !event.metaKey && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")) {
      // Space activates a focused action like any other native button.
      if (event.key !== " ") this.closePopover();
    }
  };
  showPopover(link: HTMLElement) {
    if (isComposing(this.view) || this.view.state.field(compositionActive, false)) return;
    this.closePopover();
    const anchor = this.view.posAtDOM(link, 0);
    const copy = this.view.state.facet(liveLabels);
    const panel = document.createElement("div");
    panel.className = "cm-link-popover surface-card shadow-pop p-1 text-sm text-ink";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", copy.linkActions);
    panel.contentEditable = "false";
    panel.popover = "manual";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = copy.openLink;
    open.className = "min-h-11 min-w-11 rounded-ctl px-4 hover:bg-canvas disabled:opacity-50";
    const url = link.getAttribute("href");
    open.disabled = !url;
    open.addEventListener("click", () => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      this.closePopover();
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = copy.editLink;
    edit.className = open.className;
    edit.addEventListener("click", () => {
      this.closePopover();
      this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
      this.view.focus();
    });
    panel.append(open, edit);
    this.view.dom.append(panel);
    this.popover = panel;
    panel.showPopover();
    // The top layer avoids editor clipping. Bound it to the visual viewport,
    // excluding the dock whether it is at the bottom or under the phone header.
    const rect = link.getBoundingClientRect(), size = panel.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8;
    const right = left + (viewport?.width ?? window.innerWidth) - 16;
    let top = (viewport?.offsetTop ?? 0) + 8;
    let bottom = top + (viewport?.height ?? window.innerHeight) - 16;
    const dock = this.view.dom.closest("section")?.querySelector(".editor-format-dock");
    const toolbar = dock?.firstElementChild;
    if (toolbar && getComputedStyle(toolbar).visibility !== "hidden") {
      const bounds = toolbar.getBoundingClientRect();
      if (dock?.getAttribute("data-keyboard") === "open") top = Math.max(top, bounds.bottom + 8);
      else bottom = Math.min(bottom, bounds.top - 8);
    }
    panel.style.left = `${Math.max(left, Math.min(rect.left, right - size.width))}px`;
    panel.style.top = `${Math.max(top, Math.min(rect.bottom + 6 + size.height <= bottom ? rect.bottom + 6 : rect.top - size.height - 6, bottom - size.height))}px`;
    (open.disabled ? edit : open).focus({ preventScroll: true });
  }
  readonly linkClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || event.button !== 0) return;
    const link = event.target.closest<HTMLAnchorElement>(".cm-live-link");
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    if (isComposing(this.view) || this.view.state.field(compositionActive, false) || event.type !== "click") return;
    if (event.ctrlKey || event.metaKey) {
      this.closePopover();
      if (link.getAttribute("href")) window.open(link.href, "_blank", "noopener,noreferrer");
    } else this.showPopover(link);
  };
  constructor(readonly view: EditorView) {
    view.contentDOM.addEventListener("click", this.linkClick, true);
    view.contentDOM.addEventListener("mousedown", this.linkClick, true);
    view.contentDOM.addEventListener("pointerdown", this.linkClick, true);
    document.addEventListener("pointerdown", this.outsidePress, true);
    document.addEventListener("keydown", this.dismissKey, true);
    document.addEventListener("compositionstart", this.closePopover, true);
    document.addEventListener("beforeinput", this.closePopover, true);
    document.addEventListener("scroll", this.closePopover, true);
    window.addEventListener("resize", this.closePopover);
    window.visualViewport?.addEventListener("resize", this.closePopover);
    window.visualViewport?.addEventListener("scroll", this.closePopover);
  }
  destroy() {
    this.popover?.remove();
    this.view.contentDOM.removeEventListener("click", this.linkClick, true);
    this.view.contentDOM.removeEventListener("mousedown", this.linkClick, true);
    this.view.contentDOM.removeEventListener("pointerdown", this.linkClick, true);
    document.removeEventListener("pointerdown", this.outsidePress, true);
    document.removeEventListener("keydown", this.dismissKey, true);
    document.removeEventListener("compositionstart", this.closePopover, true);
    document.removeEventListener("beforeinput", this.closePopover, true);
    document.removeEventListener("scroll", this.closePopover, true);
    window.removeEventListener("resize", this.closePopover);
    window.visualViewport?.removeEventListener("resize", this.closePopover);
    window.visualViewport?.removeEventListener("scroll", this.closePopover);
  }
}
