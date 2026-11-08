export function titleFromText(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/g, " "));
  if (/\p{Script=Han}/u.test(text) && characters.length > 24)
    return characters.slice(0, 23).join("").trimEnd() + "…";
  return characters.slice(0, 80).join("");
}
