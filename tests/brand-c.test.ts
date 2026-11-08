import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const paths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1]);
const full = read("src/assets/logo-petals.svg");
const small = read("src/assets/logo-small.svg");

it("keeps shipped C artwork on the same approved geometry", () => {
  expect(paths(full)).toHaveLength(12);
  for (const name of ["logo-on-light", "logo-on-dark", "logo-black", "logo-white", "app-icon"]) {
    expect(paths(read(`src/assets/${name}.svg`))).toEqual(paths(full));
  }
  expect(paths(small)).toEqual(paths(full).slice(0, 6));
  expect(paths(read("public/favicon.svg"))).toEqual(paths(small));
});

it("preserves C's mirrored petals and inward lower lobes", () => {
  const geometry = new Map([...full.matchAll(/<path id="([^"]+)" d="([^"]+)"/g)].map(match => [match[1], match[2]]));
  const coordinates = (id: string) => [...geometry.get(id)!.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
  for (const [left, right] of [
    ["upper-left-petal", "upper-right-petal"],
    ["lower-left-petal", "lower-right-petal"],
    ["upper-left-turn", "upper-right-turn"],
    ["middle-left-turn", "middle-right-turn"],
    ["lower-left-lobe", "lower-right-lobe"],
  ]) {
    const mirrored = coordinates(left).map((value, index) => index % 2 ? value : 100 - value);
    const target = coordinates(right);
    expect(target).toHaveLength(mirrored.length);
    target.forEach((value, index) => expect(value).toBeCloseTo(mirrored[index], 6));
  }
  // One open, continuous lower petal replaces the old sweeping pinwheel overlap.
  expect(geometry.get("bottom-petal")!.match(/M/g)).toHaveLength(1);
  expect(geometry.get("bottom-petal")!.match(/Z/g)).toHaveLength(1);
});

it("keeps logo cutouts transparent and removes the colored seed overlay", () => {
  for (const name of ["logo-petals", "logo-small", "logo-on-light", "logo-on-dark", "logo-black", "logo-white"]) {
    const svg = read(`src/assets/${name}.svg`);
    expect(svg).not.toMatch(/<(?:image|rect|filter|text)\b/);
    expect(svg).not.toMatch(/#(?:a83c36|ff8a72|ff6b5e)/i);
    expect(svg).toContain('viewBox="0 0 100 100"');
  }
  const css = read("src/ui/brand-mark.css");
  expect(css).not.toMatch(/logo-seeds|brand-accent|::after/);
  expect(read("scripts/desktop-icons.mjs")).not.toMatch(/#(?:a83c36|ff8a72|ff6b5e)/i);
});
