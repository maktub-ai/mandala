import { createContext, useContext } from 'react';

export type ContentTarget = { kind: 'asset';assetId:string;versionId:string;fileId:string;title:string } | { kind: 'file'; href: string } | { kind: 'attachment'; name: string; src: string; mimeType: string; size: number } | { kind: 'image'; name: string; src: string };
export const ContentPreviewContext = createContext<((target: ContentTarget) => void) | null>(null);
export const useContentPreview = () => useContext(ContentPreviewContext);
