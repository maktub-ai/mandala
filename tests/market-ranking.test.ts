import { expect, it } from "vitest";
import { sortMarketItems, type MarketItem } from "../shared/market";
it("orders reported values above unavailable metrics, preserves zero and ties, and leaves the original list intact", () => {
  const item = (name: string, stars?: number): MarketItem => ({ name, catalogId: name, kind: "skill", description: "", version: "1", sourceUrl: "https://example.org", ...(stars === undefined ? {} : { stats: { stars } }) });
  const items = [item("missing"), item("zero", 0), item("high", 5), item("tie", 5)];
  expect(sortMarketItems(items, "stars").map(item => item.name)).toEqual(["high", "tie", "zero", "missing"]);
  expect(sortMarketItems(items, "default")).toEqual(items);
  expect(items.map(item => item.name)).toEqual(["missing", "zero", "high", "tie"]);
});
