import { useEffect, useState, type MouseEventHandler } from 'react';
import { libraryFilesPath, type LibraryFileList } from '../shared/library-files';
import type { LibrarySection } from '../shared/data-plugins';
import { requestJson } from './api';
import { useLanguage } from './i18n';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import LoadingState from './ui/LoadingState';
import Notice from './ui/Notice';
import { Button as LinkButton } from './components/ui/button';

type Section = LibrarySection & { id: string };
type SectionResult = { data?: LibraryFileList; error?: string; badge?: number };

export function useLibraryFiles(sections: Section[], active: string | undefined, projectId: string) {
  const [state, setState] = useState<{ projectId: string; results: Map<string, SectionResult> }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setState({ projectId, results: new Map() });

    async function read(section: Section) {
      const query = projectId ? '?project=' + encodeURIComponent(projectId) : '';
      let result: SectionResult;
      try {
        const data = await requestJson<LibraryFileList>(libraryFilesPath(section.id) + query, { signal: controller.signal });
        const files = data.projects.find(group => group.projectId === projectId)?.files ?? [];
        result = { data, badge: files.reduce((sum, file) => sum + file.badge, 0) };
      } catch (reason) {
        result = { error: (reason as Error).message };
      }
      if (controller.signal.aborted) return;
      setState(previous => ({ projectId, results: new Map(previous?.results).set(section.id, result) }));
      if (section.id === active) timer = setTimeout(() => void read(section), 10_000);
    }

    for (const section of sections) {
      if (section.id === active || (projectId && section.source.kind === 'collection' && section.source.summary?.badgeItems)) void read(section);
    }
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sections, active, projectId, revision]);
  return { results: state?.projectId === projectId ? state.results : undefined, retry: () => setRevision(value => value + 1) };
}

export function LibraryFiles({ projectId, fileId, section, onFollow, data, error, retry }: SectionResult & {
  projectId: string; fileId: string | null; section: Section; onFollow: MouseEventHandler<HTMLAnchorElement>; retry: () => void;
}) {
  const { t, text, errorText } = useLanguage();
  if (error) return <Notice>{errorText(error)}<Button onClick={retry}>{t('重试')}</Button></Notice>;
  if (!data) return <LoadingState label={t('读取文件…')}/>;

  const path = (project?: string, file?: string) => {
    const query = new URLSearchParams({ tab: section.id });
    if (project) query.set('project', project);
    if (file) query.set('file', file);
    return '/library?' + query;
  };
  const project = data.projects.find(item => item.projectId === projectId);
  const files = project?.files ?? [];
  const file = fileId ? files.find(item => item.id === fileId) : files.length === 1 ? files[0] : undefined;
  const backToFiles = file && files.length > 1;
  const back = projectId && <LinkButton asChild variant="outline" size="sm" className="ui-button">
    <a onClick={onFollow} href={backToFiles ? path(projectId) : path()}>
      <Icon name="arrowLeft" size={15}/>{backToFiles ? t('返回文件列表') : t('全部项目')}
    </a>
  </LinkButton>;

  if (file) return <section className="library-file-reader">
    <div className="library-file-tools">{back}
      {file.viewUrl && <LinkButton asChild variant="outline" size="sm" className="ui-button"><a href={file.viewUrl} target="_blank" rel="noopener noreferrer">
        <Icon name="external-link" size={15}/>{t('在浏览器中打开')}
      </a></LinkButton>}
    </div>
    {file.needsUpdate && <Notice tone="info"><strong>{file.title}</strong>{section.updateText ? text(section.updateText.zh, section.updateText.en) : t('此文件的摘要不可用。')}</Notice>}
    {file.viewUrl
      ? <iframe key={file.viewUrl + ':' + file.modifiedAt} src={file.viewUrl} title={file.title} sandbox="allow-scripts" referrerPolicy="no-referrer"/>
      : <EmptyState icon="file">{t('文件暂不可用。')}</EmptyState>}
  </section>;

  const rows = projectId
    ? files.map(item => ({ href: path(projectId, item.id), title: item.title, meta: item.viewUrl ? item.filename : t('文件暂不可用。') }))
    : data.projects.map(item => ({ href: path(item.projectId), title: item.projectName, meta: t(item.files.length === 1 ? '1 个文件' : '{count} 个文件', { count: item.files.length }) }));
  return <>
    {back && <div className="library-file-tools">{back}</div>}
    {rows.length ? <div className="asset-list library-resource-rows">{rows.map(row =>
      <article key={row.href} className="library-resource-row"><a href={row.href} onClick={onFollow} aria-label={t('打开 {title}', {title:row.title})}>
        <span className="asset-row-icon"><Icon name={projectId ? 'file' : 'project'} size={24}/></span>
        <span className="asset-row-content"><strong>{row.title}</strong><span className="library-row-meta">{row.meta}</span></span>
        <span className="library-file-open">{t('打开')}<Icon name="chevronRight" size={13}/></span>
      </a></article>
    )}</div> : <EmptyState icon={section.icon}>{section.emptyText ? text(section.emptyText.zh, section.emptyText.en) : t('没有可显示的文件。')}</EmptyState>}
  </>;
}
