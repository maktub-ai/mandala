// Folder references retain their path bytes in the existing draft File storage.
export const directoryReferenceType = 'application/x-mandala-directory-path';
export const isDirectoryReference = (file: Pick<File, 'type'>) => file.type === directoryReferenceType;

export async function resolveComposerFiles(text: string, files: File[]) {
  const paths = await Promise.all(files.filter(isDirectoryReference).map(file => file.text()));
  return { text: [text, ...paths].filter(Boolean).join('\n'), files: files.filter(file => !isDirectoryReference(file)) };
}
