// Stored memory text may begin with a machine META block; people read the summary and body.
export const memoryBody = (text: string) => text.replace(/^\s*(?:<!--\s*)?-----META-START-----[\s\S]*?-----META-END-----(?:\s*-->)?\s*/, '');
export const memorySummary = (text: string) => text.match(/-----META-START-----[\s\S]*?\nsummary:\s*([^\n]+)/)?.[1];
