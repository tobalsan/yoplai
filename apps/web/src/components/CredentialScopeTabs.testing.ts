// Test helpers for driving CredentialScopeTabs through the DOM.
const tabs = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.cred-tabs [role="tab"]'));

export const scopeTabLabels = (root: ParentNode) =>
  tabs(root).map((tab) => tab.querySelector(".cred-tab-label")?.firstChild?.textContent);

export const activeScope = (root: ParentNode) =>
  tabs(root).find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.scope;

export const selectScope = (root: ParentNode, scope: "personal" | "team") =>
  tabs(root).find((tab) => tab.dataset.scope === scope)!.click();

export const scopeTabsDisabled = (root: ParentNode) => tabs(root).every((tab) => tab.disabled);
