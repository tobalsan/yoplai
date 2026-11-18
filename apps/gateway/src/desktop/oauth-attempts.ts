import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { desktopEnabled } from "./guard.js";

export const OAUTH_HOSTS = { "openai-codex": "auth.openai.com", anthropic: "claude.ai" } as const;
export type OAuthProvider = keyof typeof OAUTH_HOSTS;
export function isOAuthProvider(provider: string): provider is OAuthProvider {
  return Object.hasOwn(OAUTH_HOSTS, provider);
}

const lifetime = 10 * 60_000;
const signInFailed = "Sign-in failed. Try again.";
type State = "waiting-browser" | "waiting-code" | "done" | "failed" | "cancelled";
type Attempt = {
  handle: string;
  provider: OAuthProvider;
  state: State;
  message?: string;
  controller: AbortController;
  answer?: (value: string) => void;
};

export async function openDesktopBrowser(url: string) {
  if (process.platform !== "darwin" || !desktopEnabled()) throw new Error(signInFailed);
  await promisify(execFile)("/usr/bin/open", [url], { timeout: 10_000 });
}

export function createOAuthAttempts(
  login: (provider: OAuthProvider, interaction: AuthInteraction) => Promise<unknown>,
  open = openDesktopBrowser,
) {
  const attempts = new Map<string, Attempt>();
  const active = new Map<OAuthProvider, Attempt>();
  const view = ({ handle, provider, state, message }: Attempt) => ({ handle, provider, state, message });

  function terminal(attempt: Attempt, state: "done" | "failed" | "cancelled", message?: string) {
    attempt.state = state;
    attempt.message = message;
    attempt.answer = undefined;
    if (state !== "done") attempt.controller.abort();
  }

  function start(provider: OAuthProvider) {
    const attempt: Attempt = { handle: randomUUID(), provider, state: "waiting-browser", controller: new AbortController() };
    const { signal } = attempt.controller;
    attempts.set(attempt.handle, attempt);
    active.set(provider, attempt);
    const expiry = setTimeout(() => {
      if (active.get(provider) === attempt && !signal.aborted) terminal(attempt, "failed", "The sign-in time expired. Start again.");
      setTimeout(() => attempts.delete(attempt.handle), lifetime).unref();
    }, lifetime);
    expiry.unref();
    let promptClosed = false;
    const prompt = (step: AuthPrompt): Promise<string> => {
      if (signal.aborted || step.signal?.aborted || promptClosed) return Promise.reject(new Error(signInFailed));
      if (step.type === "select" && step.options.some((option) => option.id === "browser")) return Promise.resolve("browser");
      if (step.type !== "manual_code" || attempt.answer) return Promise.reject(new Error(signInFailed));
      attempt.state = "waiting-code";
      return new Promise((resolve, reject) => {
        const close = () => {
          signal.removeEventListener("abort", abort);
          step.signal?.removeEventListener("abort", abort);
          attempt.answer = undefined;
          promptClosed = true;
          if (attempt.state === "waiting-code") attempt.state = "waiting-browser";
        };
        const abort = () => {
          close();
          reject(new Error(signInFailed));
        };
        signal.addEventListener("abort", abort, { once: true });
        step.signal?.addEventListener("abort", abort, { once: true });
        attempt.answer = (value) => { close(); resolve(value); };
      });
    };
    void Promise.resolve().then(async () => {
      if (signal.aborted) return;
      if (!desktopEnabled()) throw new Error(signInFailed);
      await login(provider, {
        signal, prompt,
        notify(event) {
          if (event.type !== "auth_url" || signal.aborted || promptClosed) return;
          const url = new URL(event.url);
          if (url.protocol !== "https:" || url.host !== OAUTH_HOSTS[provider] || url.username || url.password) {
            throw new Error(signInFailed);
          }
          void open(url.href).catch(() => {
            if (active.get(provider) === attempt && !signal.aborted) terminal(attempt, "failed", signInFailed);
          });
        },
      });
      if (!signal.aborted) terminal(attempt, "done");
    }).catch(() => {
      if (!signal.aborted) terminal(attempt, "failed", signInFailed);
    }).finally(() => {
      active.delete(provider);
      clearTimeout(expiry);
      setTimeout(() => attempts.delete(attempt.handle), lifetime).unref();
    });
    return view(attempt);
  }

  return {
    start,
    busy: (provider: string) => isOAuthProvider(provider) && active.has(provider),
    status(handle: string) {
      const attempt = attempts.get(handle);
      return attempt && view(attempt);
    },
    answer(handle: string, code: string) {
      const attempt = attempts.get(handle);
      if (!attempt?.answer) return undefined;
      attempt.answer(code);
      return view(attempt);
    },
    cancel(handle: string) {
      const attempt = attempts.get(handle);
      if (!attempt) return undefined;
      if (active.get(attempt.provider) === attempt && !attempt.controller.signal.aborted && attempt.state !== "done") terminal(attempt, "cancelled");
      return view(attempt);
    },
  };
}
