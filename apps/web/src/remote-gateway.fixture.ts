import { vi } from "vitest";

/**
 * Synthetic gateways for web tests. One fake fetch plays the local gateway and the
 * relay. It logs every request, answers only the routes that a test registers,
 * and counts any other request as unexpected. No test sends a real request.
 */
export type RecordedRequest = { method: string; url: string; body: unknown; headers: Record<string, string> };
export type FakeAnswer = Response | { status?: number; json?: unknown; text?: string } | undefined;
export type FakeHandler = (request: RecordedRequest) => FakeAnswer | Promise<FakeAnswer>;

export function relayPrefix(gateway: string): string {
  return `/api/relay/gateways/${encodeURIComponent(gateway)}`;
}

export function createFakeGateways() {
  const requests: RecordedRequest[] = [];
  const unexpected: RecordedRequest[] = [];
  const handlers: { method: string; match: string | RegExp; handler: FakeHandler }[] = [];
  const order: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const request = { method, url, body, headers };
    requests.push(request);
    order.push(`fetch ${method} ${url}`);
    const found = [...handlers].reverse().find((item) => item.method === method && (typeof item.match === "string" ? item.match === url : item.match.test(url)));
    const answer = found ? await found.handler(request) : undefined;
    if (!found || answer === undefined) {
      unexpected.push(request);
      return new Response(JSON.stringify({ error: "unexpected_request" }), { status: 599 });
    }
    if (answer instanceof Response) return answer;
    return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  });

  return {
    fetchMock,
    requests,
    unexpected,
    order,
    /** Answers one method and URL. A string matches the whole URL with its query. A RegExp tests it. */
    on(method: string, match: string | RegExp, handler: FakeHandler | FakeAnswer) {
      handlers.push({ method, match, handler: typeof handler === "function" ? (handler as FakeHandler) : () => handler });
    },
    /** Requests that reached a gateway, as "METHOD url". */
    log(): string[] {
      return requests.map((request) => `${request.method} ${request.url}`);
    },
    /** Requests that did not use the relay prefix of the gateway and are not on the allowed local list. */
    localConfigurationRequests(allowed: RegExp[] = [/^\/api\/agents$/]): string[] {
      return requests
        .filter((request) => !request.url.startsWith("/api/relay/") && !allowed.some((pattern) => pattern.test(request.url)))
        .map((request) => `${request.method} ${request.url}`);
    },
  };
}

/** A fake popup window. `closed` and `location.href` are the two fields that the page reads or writes. */
export function createFakePopup() {
  const popup = {
    closed: false,
    closeCalls: 0,
    location: { href: "" },
    close() { popup.closed = true; popup.closeCalls += 1; },
  };
  return popup;
}
