export type LibraryFile = {
  id: string;
  title: string;
  filename: string;
  badge: number;
  needsUpdate: boolean;
  modifiedAt: number | null;
  viewUrl: string | null;
};
export type LibraryFileList = { projects: { projectId: string; projectName: string; files: LibraryFile[] }[] };

export const libraryFilesPath = (sectionId: string) => '/api/v2/library-sections/' + encodeURIComponent(sectionId) + '/files';
