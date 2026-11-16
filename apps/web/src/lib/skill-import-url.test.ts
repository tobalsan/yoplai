import { describe, expect, it } from "vitest";
import { importAddressProblem } from "./skill-import-url";

const prompt = (address: string) => `Send the skill files with POST ${address} and the token.`;

describe("importAddressProblem", () => {
  it("accepts a public HTTPS address", () => {
    expect(importAddressProblem(prompt("https://skills.example.test/api/skills/import"))).toBeUndefined();
  });

  it("refuses a public HTTP address and names the HTTPS fix", () => {
    const problem = importAddressProblem(prompt("http://skills.example.test/api/skills/import"));
    expect(problem).toContain("plain HTTP");
    expect(problem).toContain("server.baseUrl");
    expect(problem).toContain("HTTPS");
  });

  it("refuses a local or private address over HTTP or HTTPS", () => {
    for (const address of ["http://localhost:3000", "https://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.5:3000"]) {
      expect(importAddressProblem(prompt(`${address}/api/skills/import`))).toContain("server.baseUrl");
    }
  });

  it("refuses a prompt with no import address", () => {
    expect(importAddressProblem("Nothing to see")).toContain("no import address");
  });
});
