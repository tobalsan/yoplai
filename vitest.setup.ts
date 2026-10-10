import { registerOAuthProvider } from "./packages/shared/src/oauth/providers.js";
import { googleProvider, zendeskProvider } from "./packages/shared/src/oauth/test-providers.js";

// Providers now ship with extensions; tests exercising the OAuth flow use fixtures.
registerOAuthProvider(googleProvider);
registerOAuthProvider(zendeskProvider);

const hasUsableLocalStorage =
  typeof globalThis.localStorage !== "undefined" &&
  typeof globalThis.localStorage.getItem === "function" &&
  typeof globalThis.localStorage.setItem === "function";

if (!hasUsableLocalStorage) {
  const store = new Map<string, string>();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    },
  });
}
