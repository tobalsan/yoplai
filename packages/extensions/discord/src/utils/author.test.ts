import { describe, expect, it } from "vitest";
import { formatDiscordAuthor } from "./author.js";

describe("formatDiscordAuthor", () => {
  it("includes the mention form and a bot marker", () => {
    expect(formatDiscordAuthor({ id: "42", username: "Iris", bot: true })).toBe(
      "Iris (<@42>, bot)"
    );
    expect(formatDiscordAuthor({ id: "7", username: "thinh" })).toBe("thinh (<@7>)");
    expect(formatDiscordAuthor({ id: "7" })).toBe("7 (<@7>)");
  });
});
