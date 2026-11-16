import { describe, expect, it } from "vitest";
import { importAddressProblem } from "./skill-import-url";

const prompt = (address: string) => `Send each skill in turn as an HTTPS POST to ${address} (local installations may use HTTP). Set Authorization.`;

describe("importAddressProblem", () => {
  it.each([
    "https://skills.example.test/api/skills/import",
    "https://skills.example.test:8443/api/skills/import",
    "https://10.1.2.3/api/skills/import",
    "https://192.168.1.5:3000/api/skills/import",
    "https://172.16.0.9/api/skills/import",
    "https://[fd12:3456::1]/api/skills/import",
    "https://[2001:db8::1]/api/skills/import",
    "https://gateway.internal/api/skills/import",
    "https://gateway.corp.local/api/skills/import",
    "https://agents/api/skills/import",
    "https://studio/api/skills/import",
    "https://100.64.0.1/api/skills/import",
    "https://studio.tailnet-name.ts.net/api/skills/import",
    "https://[::ffff:c0a8:105]/api/skills/import",
  ])("accepts the configured HTTPS root endpoint %s", (address) => {
    expect(importAddressProblem(prompt(address))).toBeUndefined();
  });

  it.each([
    ["remote HTTP on a public name", "http://skills.example.test/api/skills/import", "plain HTTP"],
    ["remote HTTP on a private address", "http://10.0.0.5/api/skills/import", "plain HTTP"],
    ["remote HTTP on loopback", "http://localhost:4000/api/skills/import", "plain HTTP"],
    ["credentials", "https://user:pass@skills.example.test/api/skills/import", "root endpoint"],
    ["a user name only", "https://user@skills.example.test/api/skills/import", "root endpoint"],
    ["a query", "https://skills.example.test/api/skills/import?next=1", "root endpoint"],
    ["an empty query", "https://skills.example.test/api/skills/import?", "root endpoint"],
    ["a fragment", "https://skills.example.test/api/skills/import#x", "root endpoint"],
    ["a path prefix", "https://skills.example.test/base/api/skills/import", "root endpoint"],
    ["a longer path", "https://skills.example.test/api/skills/import-token", "root endpoint"],
    ["a trailing slash", "https://skills.example.test/api/skills/import/", "root endpoint"],
    ["a wrong path", "https://skills.example.test/api/skills", "root endpoint"],
    ["the origin only", "https://skills.example.test", "root endpoint"],
    ["an endpoint inside a query", "https://evil.example.test/x?u=https://good.example.test/api/skills/import", "root endpoint"],
    ["an endpoint inside a path", "https://evil.example.test/https://good.example.test/api/skills/import", "root endpoint"],
    ["an endpoint as a prefix of a host path", "https://skills.example.test/api/skills/import.evil", "root endpoint"],
    ["localhost", "https://localhost:4000/api/skills/import", "only works on that gateway"],
    ["localhost with a final dot", "https://localhost./api/skills/import", "only works on that gateway"],
    ["a localhost subdomain", "https://app.localhost/api/skills/import", "only works on that gateway"],
    ["loopback IPv4", "https://127.0.0.1/api/skills/import", "only works on that gateway"],
    ["loopback IPv4 in another form", "https://127.1/api/skills/import", "only works on that gateway"],
    ["a hexadecimal loopback", "https://0x7f.0.0.1/api/skills/import", "only works on that gateway"],
    ["unspecified IPv4", "https://0.0.0.0/api/skills/import", "only works on that gateway"],
    ["loopback IPv6", "https://[::1]/api/skills/import", "only works on that gateway"],
    ["unspecified IPv6", "https://[::]/api/skills/import", "only works on that gateway"],
    ["mapped loopback IPv6", "https://[::ffff:127.0.0.1]/api/skills/import", "only works on that gateway"],
    ["mapped unspecified IPv6", "https://[::ffff:0.0.0.0]/api/skills/import", "only works on that gateway"],
  ])("refuses %s", (_name, address, message) => {
    expect(importAddressProblem(prompt(address))).toContain(message);
  });

  it("refuses a prompt with no import address", () => {
    expect(importAddressProblem("Nothing to see")).toContain("no import address");
  });

  it("does not take an address from the middle of a word", () => {
    expect(importAddressProblem("POST xhttps://skills.example.test/api/skills/import")).toContain("no import address");
  });

  it("gives an actionable message and never names a rewritten address", () => {
    const problem = importAddressProblem(prompt("http://skills.example.test/api/skills/import"))!;
    expect(problem).toContain("server.baseUrl");
    expect(problem).toContain("HTTPS");
  });
});
