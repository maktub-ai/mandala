export type ComposerReferenceItem = {
  id: string;
  kind: "skill" | "mcp" | "task" | "agent" | "project" | "chat" | "message" | "command";
  objectId?: string;
  intent?: "inquiry";
  name: string;
  source: string;
  detail: string;
  status: string;
};

export const conversationDragType = 'application/x-mandala-conversation';

// Clients send only the catalog identity. Paths, instructions and authorization
// are resolved again by the local server at the execution boundary.
export type ComposerReferenceSelection = { id: string };
