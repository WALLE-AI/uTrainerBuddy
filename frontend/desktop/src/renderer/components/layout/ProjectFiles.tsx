import { httpRequest } from '@/common/adapter/httpBridge';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';
import FileTypeIcon from '@/renderer/pages/conversation/explorer/fileIcon/FileTypeIcon';
import { Message, Tree } from '@arco-design/web-react';
import type { TreeProps } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { RemoteFiles } from '../compute/RemoteFiles';
import { ProjectPublish } from '../compute/ProjectPublish';

type Entry = { name: string; type: 'dir' | 'file' };
type FileNode = NonNullable<TreeProps['treeData']>[number] & { path: string; isLeaf: boolean };

export function ProjectFiles({ projectId, active = true }: { projectId: string; active?: boolean }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<'local' | 'remote'>('local');
  const [localRevision, setLocalRevision] = useState(0);
  return <>
    <ProjectPublish projectId={projectId} active={active} onBindingChanged={() => setLocalRevision(value => value + 1)} />
    <div className='project-file-sources' role='group' aria-label={t('conversation.compute.filesSource')}>
      <button className='workbench-button' aria-pressed={source === 'local'} onClick={() => setSource('local')}>{t('conversation.compute.filesLocal')}</button>
      <button className='workbench-button' aria-pressed={source === 'remote'} onClick={() => setSource('remote')}>{t('conversation.sync.publishedFiles')}</button>
    </div>
    <div hidden={source !== 'local'}><LocalProjectFiles key={localRevision} projectId={projectId} active={active && source === 'local'} /></div>
    <div className='project-remote-files' hidden={source !== 'remote'}><RemoteFiles projectId={projectId} active={active && source === 'remote'} /></div>
  </>;
}

function LocalProjectFiles({ projectId, active = true }: { projectId: string; active?: boolean }) {
  const { t } = useTranslation();
  const preview = usePreviewContext();
  const [expanded, setExpanded] = useState<string[]>(['root']);
  const [selected, setSelected] = useState<string[]>([]);
  const [directories, setDirectories] = useState<Record<string, Entry[]>>({});
  const [rootError, setRootError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const label = (key: string) => t(`conversation.workbench.${key}`);
  const project = useSWR(active ? ['project-files-title', projectId] : null,
    () => httpRequest<{ name: string }>('GET', `/api/projects/${projectId}`));
  const loadDirectory = useCallback(async (path: string) => {
    const entries = await httpRequest<Entry[]>('GET', `/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
    setDirectories(previous => ({ ...previous, [path]: entries }));
    if (!path) setRootError(false);
  }, [projectId]);
  useEffect(() => {
    if (!active || directories[''] !== undefined) return;
    void loadDirectory('').catch(() => setRootError(true));
  }, [active, directories, loadDirectory]);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all(['', ...expanded.filter(key => key !== 'root').map(key => key.slice(5))].map(loadDirectory));
    } catch { Message.error(label('loadError')); }
    finally { setRefreshing(false); }
  };
  const open = async (path: string) => {
    try {
      const file = await httpRequest<{ bytes: number[]; size: number }>('GET', `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
      const name = path.split('/').pop()!;
      const { contentType, language } = getFileTypeInfo(name);
      const binary = contentType === 'image' || contentType === 'pdf';
      const bytes = new Uint8Array(file.bytes);
      const extension = name.split('.').pop()?.toLowerCase();
      const mime = contentType === 'pdf' ? 'application/pdf' : extension === 'svg' ? 'image/svg+xml' : extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
      const content = binary ? await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([bytes], { type: mime }));
      }) : new TextDecoder().decode(bytes);
      preview.openPreview(content, contentType, { title: name, file_name: name, language, editable: false });
    } catch {
      Message.error(label('fileError'));
    }
  };
  const children = (path: string): FileNode[] | undefined => directories[path]?.map(entry => {
    const child = path ? `${path}/${entry.name}` : entry.name;
    const isLeaf = entry.type === 'file';
    return { key: `file:${child}`, title: entry.name, path: child, isLeaf,
      children: isLeaf ? undefined : children(child) };
  });
  const treeData: FileNode[] = [{ key: 'root', title: project.data?.name || label('projectFiles'), path: '', isLeaf: false, children: children('') }];
  return <div className='workbench-project-files'>
    <div className='workbench-section-heading'><h3>{label('projectFiles')}</h3>
      <button className='workbench-button' disabled={refreshing} onClick={() => void refresh()}>{label('refresh')}</button>
    </div>
    {rootError ? <button className='workbench-button' onClick={() => void loadDirectory('').catch(() => setRootError(true))}>{label('retry')}</button>
      : directories[''] === undefined ? <p className='workbench-note'>{label('loading')}</p> : <>
        <Tree className='workspace-tree' treeData={treeData} blockNode actionOnClick={['select', 'expand']}
          expandedKeys={expanded} selectedKeys={selected}
          onExpand={keys => setExpanded(keys.map(String))}
          loadMore={async node => {
            const data = node.props.dataRef as FileNode;
            await loadDirectory(data.path);
            setExpanded(previous => previous.includes(String(data.key)) ? previous : [...previous, String(data.key)]);
          }}
          onSelect={(keys, extra) => {
            setSelected(keys.map(String));
            const data = extra.node.props.dataRef as FileNode;
            if (data.isLeaf) void open(data.path);
          }}
          renderTitle={node => {
            const data = node.dataRef as FileNode;
            const name = String(node.title);
            return <span className='flex items-center gap-4px min-w-0 w-full'>
              <FileTypeIcon node={{ name, relativePath: data.path, isFile: data.isLeaf }} expanded={expanded.includes(String(data.key))} />
              <span dir='ltr' className='overflow-hidden text-ellipsis whitespace-nowrap'>{name}</span>
            </span>;
          }} />
        {directories[''].length === 0 && <p className='workbench-note'>{label('noFiles')}</p>}
      </>}
  </div>;
}
