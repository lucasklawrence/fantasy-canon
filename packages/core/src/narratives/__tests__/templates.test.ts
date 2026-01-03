import { formatNarrative } from "../templates.js";

describe("formatNarrative", () => {
  it("formats title and body with a blank line separator", () => {
    const result = formatNarrative({
      title: "FAAB Kings",
      body: "Team A spent it all."
    });

    expect(result).toBe("FAAB Kings\n\nTeam A spent it all.");
  });
});
