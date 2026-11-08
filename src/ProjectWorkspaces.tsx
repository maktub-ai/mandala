import Button from './ui/Button';
import Input from './ui/Input';
import CodeGraphBinding from './CodeGraphBinding';
import { useEffect, useRef, useState } from "react";
import type { ExecutionMachine, Project, Workspace } from "../shared/types";
import { isRemoteAbsolutePath } from "../shared/execution-machines";
import { projectWorkspaces } from "../shared/workspaces";
import { useLanguage } from "./i18n";
import FolderPicker from "./FolderPicker";
import Icon from "./ui/Icon";
import Select from "./ui/Select";
import { api } from "./api";
import Notice from "./ui/Notice";
import { sshErrorText } from "./ssh-errors";
import "./project-workspaces.css";

export default function ProjectWorkspaces({ project, machines = [], onChange }: { project: Project; machines?: ExecutionMachine[]; onChange: (patch: Partial<Project>) => void }) {
  const { t, text, errorText, language } = useLanguage();
  const [undo, setUndo] = useState<{ workspaceId: string; previous: Workspace; from: string; to: string } | null>(null);
  const [pathCheck, setPathCheck] = useState<{ key: string; state: "checking" | "ok" | "missing" | "file" | "error"; detail?: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [folder, setFolder] = useState<{ value: string; apply: (path: string) => void } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDefault, setCloneDefault] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const latest = useRef({ project, onChange });
  latest.current = { project, onChange };
  const cloneRequest = useRef(0);
  useEffect(() => {
    setCloning(false); setCloneOpen(false); setCloneUrl(""); setCloneDefault(false); setCloneError(""); setUndo(null);
    return () => { cloneRequest.current++; };
  }, [project.id]);
  const workspaces = projectWorkspaces(project);
  const workspace = workspaces.find(w => w.id === selectedId) ?? workspaces[0];
  const remote = workspace?.machineId !== undefined;
  const machineName = (id?: string) => id === undefined ? text("本机", "Local") : machines.find(machine => machine.id === id)?.name ?? text("执行机器不可用", "Execution machine unavailable");
  // Check the remote working directory shortly after typing stops, so a wrong path shows up here and not at the first run.
  const pathKey = remote && isRemoteAbsolutePath(workspace.cwd) && machines.some(machine => machine.id === workspace.machineId) ? workspace.machineId + "\n" + workspace.cwd : "";
  useEffect(() => {
    if (!pathKey) { setPathCheck(null); return; }
    const [machineId, path] = pathKey.split("\n");
    let live = true;
    const timer = setTimeout(() => {
      setPathCheck({ key: pathKey, state: "checking" });
      api<{ exists: boolean; isDirectory: boolean; realpath?: string }>("/execution-machines/check-path", "POST", { machineId, path })
        .then(result => { if (live) setPathCheck({ key: pathKey, state: !result.exists ? "missing" : result.isDirectory ? "ok" : "file", detail: result.realpath && result.realpath !== path ? result.realpath : undefined }); })
        .catch(error => { if (live) setPathCheck({ key: pathKey, state: "error", detail: error instanceof Error ? error.message : String(error) }); });
    }, 700);
    return () => { live = false; clearTimeout(timer); };
  }, [pathKey]);
  const check = pathCheck?.key === pathKey ? pathCheck : null;
  const save = (items: Workspace[]) => onChange({ workspaces: items, cwd: items[0]?.cwd ?? "", resources: items[0]?.resources ?? [] });
  const patch = (value: Partial<Workspace>) => save(workspaces.map(w => w.id === workspace.id ? { ...w, ...value } : w));
  const clone = async () => {
    if (remote || cloning || !cloneUrl.trim()) return;
    const request = ++cloneRequest.current, projectId = project.id, makeDefault = cloneDefault;
    setCloning(true); setCloneError("");
    try {
      const { workspace: cloned } = await api<{ workspace: Workspace }>(`/projects/${encodeURIComponent(projectId)}/workspaces/clone`, "POST", { url: cloneUrl.trim() });
      if (request !== cloneRequest.current || latest.current.project.id !== projectId) return;
      const current = latest.current, items = projectWorkspaces(current.project);
      const emptyDefault = items.length === 1 && items[0].id === "default" && items[0].name === "Default" && !items[0].cwd && !items[0].resources.length;
      const next = emptyDefault ? [cloned] : makeDefault ? [cloned, ...items] : [...items, cloned];
      current.onChange({ workspaces: next, cwd: next[0]?.cwd ?? "", resources: next[0]?.resources ?? [] });
      setSelectedId(cloned.id); setCloneOpen(false); setCloneUrl(""); setCloneDefault(false);
    } catch (error) {
      if (request === cloneRequest.current) setCloneError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === cloneRequest.current) setCloning(false);
    }
  };
  return <div className="settings-subsection project-workspaces">
    <div className="settings-section-title"><h3>{t("工作目录组")}</h3><div className="project-workspace-actions"><Button type="button" disabled={remote} title={remote ? text("远程目录暂不支持从仓库克隆。", "Cloning is not available for remote directories yet.") : undefined} onClick={() => setCloneOpen(true)}><Icon name="gitBranch" size={16} />{t("从仓库克隆")}</Button><Button type="button" onClick={() => {
      const id = crypto.randomUUID();
      save([...workspaces, { id, name: t("工作目录组") + " " + (workspaces.length + 1), cwd: "", resources: [] }]); setSelectedId(id);
    }}><Icon name="plus" size={16} />{t("添加目录组")}</Button></div></div>
    <p className="field-hint">{t("项目可包含多个工作目录组，也可以暂不关联目录。")}</p>
    {cloneOpen && !remote && <form className="workspace-clone-form" aria-label={t("克隆仓库")} aria-busy={cloning} onSubmit={event => { event.preventDefault(); void clone(); }}>
      <label>{t("远程仓库 URL")}<Input autoFocus aria-label={t("远程仓库 URL")} value={cloneUrl} disabled={cloning} onChange={event => { setCloneUrl(event.target.value); setCloneError(""); }} /></label>
      <p className="field-hint">{t("克隆成功后添加为项目目录组，现有目录不会被修改。")}</p>
      <label className="workspace-clone-default"><Input type="checkbox" checked={cloneDefault} disabled={cloning} onChange={event => setCloneDefault(event.target.checked)} />{t("设为默认目录组")}</label>
      {cloneError && <p className="form-error" role="alert">{errorText(cloneError)}</p>}
      <div className="project-workspace-actions"><Button type="button" disabled={cloning} onClick={() => { setCloneOpen(false); setCloneError(""); }}>{t("取消")}</Button>
        <Button type="submit" className="primary" disabled={cloning || !cloneUrl.trim()}>{cloning ? t("克隆中…") : t("克隆仓库")}</Button></div>
    </form>}
    {workspace ? <>
      <div className="workspace-editor-toolbar"><Select ariaLabel={t("当前目录组")} value={workspace.id} onChange={setSelectedId}
        options={workspaces.map((w, index) => ({ value: w.id, label: w.name === "Default" ? t("默认目录组") : w.name,
          description: [index === 0 ? t("默认") : w.cwd, w.machineId === undefined ? "" : machineName(w.machineId)].filter(Boolean).join(" · "), icon: <Icon name={w.machineId === undefined ? "folder" : "server"} size={16} /> }))} />
        {workspace !== workspaces[0] && <Button type="button" onClick={() => save([workspace, ...workspaces.filter(w => w.id !== workspace.id)])}>{t("设为默认目录组")}</Button>}
        <Button className="icon-button" type="button" aria-label={t("移除目录组")} onClick={() => save(workspaces.filter(w => w.id !== workspace.id))}><Icon name="trash" size={16} /></Button>
      </div>
      <label>{t("目录组名称")}<Input aria-label={t("目录组名称")} value={workspace.name} onChange={e => patch({ name: e.target.value })} /></label>
      <label>{text("执行机器", "Execution machine")}<Select ariaLabel={text("执行机器", "Execution machine")} value={workspace.machineId ?? ""} onChange={machineId => {
        const next = machineId || undefined;
        if (next === workspace.machineId) return;
        // Paths never carry over between machines; keep the old values so the switch can be undone.
        const hadPaths = !!workspace.cwd || workspace.resources.some(resource => resource.kind === "local" && resource.location);
        setUndo(hadPaths ? { workspaceId: workspace.id, previous: workspace, from: machineName(workspace.machineId), to: machineName(next) } : null);
        setFolder(null); setCloneOpen(false); patch({ machineId: next, cwd: "", codeGraph: undefined, resources: workspace.resources.map(resource => resource.kind === "local" ? { ...resource, location: "", codeGraph: undefined } : resource) });
      }} options={[{ value: "", label: text("本机", "Local") }, ...machines.map(machine => ({ value: machine.id, label: machine.name, description: machine.host })), ...(remote && !machines.some(machine=>machine.id===workspace.machineId) ? [{value:workspace.machineId!,label:text("执行机器不可用", "Execution machine unavailable"),disabled:true}] : [])]}/></label>
      {undo?.workspaceId === workspace.id ? <Notice tone="info" className="workspace-machine-undo"><span>{text(`已从「${undo.from}」切换到「${undo.to}」，原有目录路径已清空。`, `Switched from "${undo.from}" to "${undo.to}". The previous directory paths were cleared.`)}</span><Button type="button" variant="ghost" onClick={() => { const previous = undo.previous; setUndo(null); save(workspaces.map(w => w.id === previous.id ? previous : w)); }}>{text("撤销", "Undo")}</Button></Notice>
        : <p className="field-hint">{machines.length ? text("目录路径属于所选机器，切换机器后需要重新填写。", "Directory paths belong to the selected machine; switching machines means entering them again.") : text("在“设置 → 远程机器”中添加机器后，可在这里选择让智能体在远程执行。", "Add a machine in Settings → Remote machines to run Agents there.")}</p>}
      <div className="settings-folder-field"><label>{t("主工作目录")}<Input aria-label={t("主工作目录")} value={workspace.cwd}
        aria-invalid={remote && !isRemoteAbsolutePath(workspace.cwd)} placeholder={remote ? "/srv/project" : t("留空，创建独立的空工作目录")} onChange={e => patch({ cwd: e.target.value })} /></label>
        <Button type="button" disabled={remote} title={remote ? text("远程目录暂不支持浏览，请直接输入路径。", "Browsing is not available for remote directories yet; type the path.") : undefined} onClick={() => setFolder({ value: workspace.cwd, apply: cwd => patch({ cwd }) })}>{t("浏览文件夹")}</Button></div>
      {!(remote && check) && <p className="field-hint">{remote ? text("请输入执行机器上的绝对 POSIX 路径；不会使用本机目录。", "Enter an absolute POSIX path on the execution machine. Local directories are not used.") : t("可选择已有目录；留空时保存会创建独立工作目录。")}</p>}
      {remote && !isRemoteAbsolutePath(workspace.cwd) && <p className="form-error" role="alert">{text("远程主工作目录必须是以 / 开头的绝对路径。", "The remote working directory must be an absolute path starting with /.")}</p>}
      {remote && check && <p className={"workspace-path-check" + (check.state === "ok" ? " is-ok" : check.state === "checking" ? "" : " is-problem")} role="status">
        <Icon name={check.state === "ok" ? "circleCheck" : check.state === "checking" ? "clock" : "error"} size={14} />
        <span>{check.state === "checking" ? text("正在检查远程目录…", "Checking the remote directory…")
          : check.state === "ok" ? text("目录存在", "Directory found") + (check.detail ? text(`（实际路径 ${check.detail}）`, ` (resolves to ${check.detail})`) : "")
          : check.state === "missing" ? text("机器上不存在这个目录。", "This directory does not exist on the machine.")
          : check.state === "file" ? text("这是一个文件，不是文件夹。", "This is a file, not a folder.")
          : (sshErrorText(language, check.detail ?? "", machines.find(machine => machine.id === workspace.machineId)?.host) ?? text("暂时无法检查这个目录：", "Could not check this directory right now: ") + errorText(check.detail ?? "")).split("\n")[0]}</span>
      </p>}
      {remote ? <p className="field-hint">{text("远程目录暂不支持代码图谱（CodeGraph）与从仓库克隆。", "CodeGraph and cloning are not available for remote directories yet.")}</p>
        : <CodeGraphBinding projectId={project.id} workspaceId={workspace.id} bindingId="cwd" settings={workspace.codeGraph} onChange={codeGraph=>patch({codeGraph})} />}
      <div className="settings-section-title"><h3>{t("关联资源")}</h3><Button type="button" onClick={() => patch({ resources: [...workspace.resources,
        { id: crypto.randomUUID(), label: "", kind: "local", location: "" }] })}><Icon name="plus" size={16} />{t("添加资源")}</Button></div>
      {remote && <p className="field-hint">{text("目录资源位于同一台执行机器。", "Directory resources belong to the same execution machine.")}</p>}
      {workspace.resources.map((r, i) => {
        const resource = (value: Partial<typeof r>) => patch({ resources: workspace.resources.map((item, index) => index === i ? { ...item, ...value } : item) });
        return <div className="resource-row" key={r.id}>
          <label>{t("资源名称")}<Input aria-label={t("资源名称")} value={r.label} onChange={e => resource({ label: e.target.value })} /></label>
          <label>{t("资源类型")}<Select ariaLabel={t("资源类型")} value={r.kind} searchable={false} onChange={value => resource({ kind: value as "local" | "remote-git", ...(value === "remote-git" && r.codeGraph ? { codeGraph: { ...r.codeGraph, enabled: false } } : {}) })}
            options={[{ value: "local", label: remote ? text("机器上的目录", "Directory on machine") : t("本地目录"), icon: <Icon name="folder" size={16} /> }, { value: "remote-git", label: t("远程 Git"), icon: <Icon name="link" size={16} /> }]} /></label>
          <label className="resource-location">{t("资源位置")}<span><Input aria-label={t("资源位置")} value={r.location}
            placeholder={r.kind === "local" ? remote ? "/srv/resources" : t("选择或输入本地目录") : t("远程仓库 URL")} onChange={e => resource({ location: e.target.value })} />
            {r.kind === "local" && <Button type="button" aria-label={t("浏览本地目录")} disabled={remote} onClick={() => setFolder({ value: r.location,
              apply: path => resource({ location: path, label: r.label || path.split(/[\\/]/).filter(Boolean).at(-1) || path }) })}>{t("浏览")}</Button>}</span></label>
          <Button type="button" className="resource-remove" aria-label={t("移除资源")} onClick={() => patch({ resources: workspace.resources.filter(item => item.id !== r.id) })}><Icon name="close" size={16} /></Button>
          {!remote && <CodeGraphBinding projectId={project.id} workspaceId={workspace.id} bindingId={"resource:" + r.id} settings={r.codeGraph} remote={r.kind === "remote-git"} onChange={codeGraph=>resource({codeGraph})} />}
        </div>;
      })}
    </> : <p className="field-hint">{t("尚无目录组")}</p>}
    {folder && !remote && <FolderPicker initialPath={folder.value} onSelect={path => { folder.apply(path); setFolder(null); }} onClose={() => setFolder(null)} />}
  </div>;
}
