// Dashboard annotation mode. Injected inline (never served as an asset) only
// for viewers who may ask the page's agent for edits. The chat page frames the
// dashboard in an opaque-origin sandbox, so it talks to this script only by
// postMessage: ready/note/exit out, set/remove/clear in. Dormant until `set`.
// The page identity arrives as JSON in the script tag's data-annotation.
(function (window) {
  const { document, Node, Element, CSS, setTimeout } = window;
  if (window.top === window) return;
  const ctx = JSON.parse(document.currentScript.dataset.annotation);
  const CHANNEL = "yoplai-annotate";
  const post = (type, body) => window.parent.postMessage({ channel: CHANNEL, type, ...body }, "*");
  const clip = (value, max) => (value.length > max ? value.slice(0, max - 1) + "…" : value);
  const squash = (value) => (value || "").replace(/\s+/g, " ").trim();
  const announce = () => post("ready", { id: ctx.id, slug: ctx.slug, agentId: ctx.agentId, title: document.title || ctx.slug, params: ctx.params });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
  else setTimeout(announce, 0);

  // Element hints: kit charts render generated DOM, so text and heading carry
  // as much meaning as the selector.
  const esc = (value) => (CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&"));
  const segment = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return tag + "#" + esc(el.id);
    const classes = [...el.classList].slice(0, 2).map((name) => "." + esc(name)).join("");
    const parent = el.parentElement;
    const same = parent ? [...parent.children].filter((child) => child.tagName === el.tagName) : [];
    return tag + classes + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(el) + 1) + ")" : "");
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 4; node = node.parentElement) {
      parts.unshift(segment(node));
      if (node.id) break;
    }
    return parts.join(" > ");
  };
  const headingBefore = (el) => {
    let found = "";
    for (const heading of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      const position = el.compareDocumentPosition(heading);
      if (heading === el || position & Node.DOCUMENT_POSITION_CONTAINS || position & Node.DOCUMENT_POSITION_CONTAINED_BY) continue;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) found = squash(heading.textContent);
      else break;
    }
    return found;
  };
  const ancestorOf = (el) => {
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id) return tag + "#" + esc(node.id);
      const data = [...node.attributes].find((attribute) => attribute.name.startsWith("data-"));
      if (data) return tag + "[" + data.name + (data.value ? '="' + clip(data.value, 60).replace(/"/g, '\\"') + '"' : "") + "]";
    }
    return "";
  };
  const hints = (el) => ({
    selector: clip(selectorOf(el), 200),
    tag: el.tagName.toLowerCase(),
    text: clip(squash(el.innerText ?? el.textContent), 120),
    heading: clip(headingBefore(el), 120),
    ancestor: clip(ancestorOf(el), 200),
  });

  // UI lives in a shadow root so page CSS cannot restyle it and page DOM is untouched.
  let host, ui, outline, popover, field;
  const markers = new Map();
  const mount = () => {
    if (host) return;
    host = document.createElement("yoplai-annotations");
    host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647";
    ui = host.attachShadow({ mode: "open" });
    ui.innerHTML = `<style>
:host{--a:#2563eb;--bg:#fff;--fg:#1a1c21;--mute:#6b7280;--bd:#e1e4e9;--hv:rgba(0,0,0,.06)}
.outline{position:absolute;pointer-events:none;border:2px solid var(--a);border-radius:4px;background:color-mix(in srgb,var(--a) 8%,transparent);box-sizing:border-box;display:none}
.marker{position:absolute;pointer-events:none;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:10px;background:var(--a);color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.pop{position:absolute;width:280px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);padding:8px;box-sizing:border-box;border:1px solid var(--bd);border-radius:12px;background:var(--bg);box-shadow:0 0 0 .5px rgba(0,0,0,.04),0 8px 28px rgba(0,0,0,.16);display:none}
.pop textarea{display:block;width:100%;min-height:44px;max-height:160px;box-sizing:border-box;resize:none;padding:4px 6px;border:0;border-radius:6px;font:inherit;color:inherit;background:transparent;outline:0}
.pop textarea::placeholder{color:var(--mute)}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}
.hint{font-size:11px;color:var(--mute);white-space:nowrap}
.hint kbd{font:inherit}
.pop.confirming .row.main,.row.sure{display:none}
.pop.confirming .row.sure{display:flex}
.sure .ask{font-weight:500}
.acts{display:flex;align-items:center;gap:2px}
button{font:500 12px/1 system-ui,sans-serif;white-space:nowrap;flex-shrink:0;padding:6px 10px;border-radius:7px;border:0;background:transparent;color:var(--mute);cursor:pointer}
button:hover{color:var(--fg);background:var(--hv)}
button.add{background:var(--a);color:#fff}
button.add:hover{background:var(--a);filter:brightness(1.1)}
button.add:disabled{background:var(--hv);color:var(--mute);filter:none;cursor:default}
button:focus-visible{outline:2px solid var(--a);outline-offset:1px}
:host(.dark){--a:#6b94ff;--bg:#1d1f24;--fg:#e8e9ec;--mute:#9ba1ad;--bd:#33363e;--hv:rgba(255,255,255,.08)}
:host(.dark) button.add:not(:disabled){color:#0b1020}
</style><div class="outline"></div><div class="pop" role="dialog" aria-label="Annotation"><textarea aria-label="Note" placeholder="What should change here?" maxlength="500"></textarea><div class="row main"><span class="hint"><kbd>Enter</kbd> add · <kbd>Esc</kbd> cancel</span><div class="acts"><button type="button" class="cancel">Cancel</button><button type="button" class="add" disabled>Add</button></div></div><div class="row sure"><span><span class="ask">Discard this note?</span> <span class="hint"><kbd>Esc</kbd> discard</span></span><button type="button" class="keep">Keep editing</button></div></div>`;
    outline = ui.querySelector(".outline");
    popover = ui.querySelector(".pop");
    field = ui.querySelector("textarea");
    ui.querySelector(".cancel").addEventListener("click", requestClose);
    const keepButton = ui.querySelector(".keep");
    keepButton.addEventListener("click", keepEditing);
    popover.addEventListener("pointerdown", (event) => event.target !== keepButton && keepEditing());
    ui.querySelector(".add").addEventListener("click", addNote);
    field.addEventListener("keydown", (event) => {
      // Shift+Enter keeps a line break; IME composition keeps its own Enter.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        addNote();
      }
    });
    field.addEventListener("input", () => {
      keepEditing();
      ui.querySelector(".add").disabled = !field.value.trim();
      field.style.height = "auto";
      field.style.height = Math.min(field.scrollHeight, 160) + "px";
    });
    document.documentElement.append(host);
  };
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top + window.scrollY, left: rect.left + window.scrollX, width: rect.width, height: rect.height };
  };
  const place = (node, el) => {
    const b = box(el);
    node.style.top = b.top + "px";
    node.style.left = b.left + "px";
    return b;
  };
  const showOutline = (el) => {
    const b = place(outline, el);
    outline.style.width = b.width + "px";
    outline.style.height = b.height + "px";
    outline.style.display = "block";
  };
  const renumber = () => {
    let n = 0;
    for (const { el, node } of markers.values()) {
      node.textContent = String(++n);
      const b = place(node, el);
      node.style.left = Math.max(0, b.left + b.width - 10) + "px";
      node.style.top = Math.max(0, b.top - 10) + "px";
    }
  };

  let on = false;
  let target = null;
  const drafts = new Map();
  const keepEditing = () => {
    popover.classList.remove("confirming");
    field.focus();
    field.style.height = Math.min(field.scrollHeight, 160) + "px";
  };
  // Dismiss by click keeps the text as a draft for that element.
  const closePopover = () => {
    if (target && field.value.trim()) drafts.set(target, field.value);
    else if (target) drafts.delete(target);
    discardPopover();
  };
  const discardPopover = () => {
    popover.classList.remove("confirming");
    target = null;
    if (popover) popover.style.display = "none";
  };
  // Esc and Cancel: close at once when empty, else ask before discarding.
  const requestClose = () => {
    if (!field.value.trim()) return discardPopover();
    if (!popover.classList.contains("confirming")) {
      return popover.classList.add("confirming");
    }
    drafts.delete(target);
    field.value = "";
    discardPopover();
  };
  const addNote = () => {
    const note = clip(field.value.trim(), 500);
    if (!target || !note) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const node = document.createElement("div");
    node.className = "marker";
    ui.append(node);
    markers.set(id, { el: target, node });
    renumber();
    post("note", { id, ...hints(target), note });
    drafts.delete(target);
    discardPopover();
  };
  const openPopover = (el) => {
    target = el;
    popover.classList.remove("confirming");
    field.value = drafts.get(el) || "";
    field.style.height = "";
    ui.querySelector(".add").disabled = !field.value.trim();
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    host.classList.toggle("dark", dark);
    const b = box(el);
    popover.style.display = "block";
    const width = popover.offsetWidth || 280;
    popover.style.left = Math.max(8, Math.min(b.left, window.scrollX + document.documentElement.clientWidth - width - 8)) + "px";
    popover.style.top = b.top + b.height + 6 + "px";
    field.focus();
  };

  const inUi = (event) => !!host && event.composedPath().includes(host);
  // The page itself is not a block worth noting.
  const pickable = (node) => node instanceof Element && node !== document.body && node !== document.documentElement;
  const block = (event) => {
    if (!on || inUi(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== "click") return;
    // A click outside an open popover only closes it; the next click picks.
    if (target) return closePopover();
    if (pickable(event.target)) openPopover(event.target);
  };
  const hover = (event) => {
    if (!on || inUi(event) || target) return;
    if (pickable(event.target)) showOutline(event.target);
    else outline.style.display = "none";
  };
  const key = (event) => {
    if (!on || event.key !== "Escape") return;
    event.preventDefault();
    if (target) requestClose();
    else post("exit", {});
  };
  const BLOCKED = ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup", "submit"];
  for (const type of BLOCKED) window.addEventListener(type, block, true);
  window.addEventListener("mouseover", hover, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("resize", () => markers.size && renumber());

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.channel !== CHANNEL) return;
    if (data.type === "set") {
      on = data.on === true;
      mount();
      if (!on) {
        discardPopover();
        drafts.clear();
        outline.style.display = "none";
      }
    } else if (data.type === "remove" && markers.has(data.id)) {
      markers.get(data.id).node.remove();
      markers.delete(data.id);
      renumber();
    } else if (data.type === "clear") {
      for (const { node } of markers.values()) node.remove();
      markers.clear();
      drafts.clear();
    }
  });
})(globalThis);
