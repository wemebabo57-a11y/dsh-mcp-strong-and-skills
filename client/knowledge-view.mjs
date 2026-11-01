import { parseKnowledgeConfig, normalizeProjectRoot } from '../src/knowledge-config.mjs';

export const KNOWLEDGE_EN = {
  knowledgeTitle: 'Projects & knowledge', knowledgeHint: 'Save a short project card and register reference sources. The current working directory selects the project automatically; shared libraries remain available. Source bodies are loaded only by a tool call.',
  projectAdd: 'Add project', projectName: 'Project name', projectRoot: 'Absolute project root', projectNotes: 'Project card (stack, layout, conventions, checks; up to 1200 characters)', projectSave: 'Save project', projectDelete: 'Delete project and its private libraries',
  libraryAdd: 'Import knowledge source', libraryName: 'Library name', libraryId: 'Unique library ID', libraryKind: 'Source type', libraryLocal: 'Local folder / text file', libraryGithub: 'Public GitHub repository', libraryLocation: 'Absolute local path or https://github.com/owner/repo', libraryRef: 'GitHub branch / commit (optional)', libraryScope: 'Available to', libraryGlobal: 'Shared with all projects', librarySave: 'Import / save source', libraryDelete: 'Remove source',
  knowledgeLocalHint: 'Local sources reference the Host filesystem (not the browser device); files stay in place. GitHub sources connect on first use and have a 10-minute process cache. No install scripts run. Configure a project first to create a private library.',
  knowledgeBudget: 'Project cards persist in this Harness profile and replace repeated onboarding scans. Knowledge defaults to a small catalog, then bounded literal search and line ranges, including in unlimited mode. Keep cards current; verify code relevant to the task.',
  knowledgeEmpty: 'No projects or sources configured.', knowledgeEdit: 'Edit',
};
export const KNOWLEDGE_ZH = {
  knowledgeTitle: '项目设定与知识库', knowledgeHint: '保存简短的项目卡片并导入资料来源。按当前工作目录自动匹配项目，公共库始终可用；正文只在模型调用检索工具时读取。',
  projectAdd: '添加项目', projectName: '项目名称', projectRoot: '项目根目录（绝对路径）', projectNotes: '项目设定（技术栈、目录、约定、检查命令，最多 1200 字）', projectSave: '保存项目', projectDelete: '删除项目及其专属库',
  libraryAdd: '导入知识来源', libraryName: '知识库名称', libraryId: '唯一知识库 ID', libraryKind: '来源类型', libraryLocal: '本地目录 / 文本文件', libraryGithub: '公开 GitHub 仓库', libraryLocation: '本地绝对路径或 https://github.com/owner/repo', libraryRef: 'GitHub 分支 / 提交（可选）', libraryScope: '适用范围', libraryGlobal: '公共库（所有项目）', librarySave: '导入 / 保存来源', libraryDelete: '移除来源',
  knowledgeLocalHint: '本地路径属于 DSH 宿主所在电脑；文件保留在原处。GitHub 来源首次调用时连接，进程内缓存 10 分钟，不执行安装脚本。先创建项目，即可为它分配专属库。',
  knowledgeBudget: '项目卡片保存在当前 Harness 配置，跨会话复用以减少重复入门扫描。知识库默认只列小目录，再按需检索、读取行片段；无限模式下也有独立预算。设定变更后请更新卡片，仍需核对任务相关源码。',
  knowledgeEmpty: '尚未配置项目或知识来源。', knowledgeEdit: '编辑',
};

export function createKnowledgeEditor(h) {
  return function KnowledgeEditor({ text = '', disabled, set, t, surfaceId }) {
    const settings = parseKnowledgeConfig(text);
    const save = next => set('knowledgeConfig', JSON.stringify(next));
    const value = (form, name) => form.elements.namedItem(name).value.trim();
    function input(prefix, name, label, initial = '', max = 1000, multiline = false, required = false) {
      const id = `${surfaceId}-${prefix}-${name}`;
      return h('div', { className: 'strong-knowledge__field', key: name },
        h('label', { htmlFor: id }, t(label)),
        h(multiline ? 'textarea' : 'input', { id, name, type: multiline ? undefined : 'text', defaultValue: initial, maxLength: max, rows: multiline ? 4 : undefined, disabled, required }));
    }
    function projectForm(project, index) {
      const prefix = `project-${index ?? 'new'}`;
      return h('form', { key: prefix + text, onSubmit: event => {
        event.preventDefault();
        const form = event.currentTarget;
        let root; try { root = normalizeProjectRoot(value(form, 'root')); } catch (error) { const control = form.elements.namedItem('root'); control.setCustomValidity(error.message); control.reportValidity(); control.setCustomValidity(''); return; }
        const next = { root, name: value(form, 'name'), notes: value(form, 'notes') };
        const projects = index === undefined ? [...settings.projects, next] : settings.projects.map((item, at) => at === index ? next : item);
        const libraries = settings.libraries.map(item => project && item.scope === project.root ? { ...item, scope: root } : item);
        void save({ projects, libraries });
      } },
      input(prefix, 'name', 'projectName', project?.name, 80, false, true),
      input(prefix, 'root', 'projectRoot', project?.root, 1000, false, true),
      input(prefix, 'notes', 'projectNotes', project?.notes, 1200, true),
      h('button', { type: 'submit', disabled }, t('projectSave')),
      project ? h('button', { type: 'button', disabled, onClick: () => { void save({ projects: settings.projects.filter((_, at) => at !== index), libraries: settings.libraries.filter(item => item.scope !== project.root) }); } }, t('projectDelete')) : null);
    }
    function libraryForm(library, index) {
      const prefix = `library-${index ?? 'new'}`;
      const scopeId = `${surfaceId}-${prefix}-scope`, kindId = `${surfaceId}-${prefix}-kind`;
      return h('form', { key: prefix + text, onSubmit: event => {
        event.preventDefault();
        const form = event.currentTarget;
        const next = Object.fromEntries(['id', 'name', 'kind', 'location', 'ref', 'scope'].map(name => [name, value(form, name)]));
        void save({ ...settings, libraries: index === undefined ? [...settings.libraries, next] : settings.libraries.map((item, at) => at === index ? next : item) });
      } },
      input(prefix, 'id', 'libraryId', library?.id, 48, false, true), input(prefix, 'name', 'libraryName', library?.name, 80, false, true),
      h('div', { className: 'strong-knowledge__field' }, h('label', { htmlFor: kindId }, t('libraryKind')),
        h('select', { id: kindId, name: 'kind', defaultValue: library?.kind ?? 'local', disabled }, h('option', { value: 'local' }, t('libraryLocal')), h('option', { value: 'github' }, t('libraryGithub')))),
      input(prefix, 'location', 'libraryLocation', library?.location, 1000, false, true), input(prefix, 'ref', 'libraryRef', library?.ref, 150),
      h('div', { className: 'strong-knowledge__field' }, h('label', { htmlFor: scopeId }, t('libraryScope')),
        h('select', { id: scopeId, name: 'scope', defaultValue: library?.scope ?? 'global', disabled }, h('option', { value: 'global' }, t('libraryGlobal')), ...settings.projects.map(project => h('option', { key: project.root, value: project.root }, project.name)))),
      h('button', { type: 'submit', disabled }, t('librarySave')),
      library ? h('button', { type: 'button', disabled, onClick: () => { void save({ ...settings, libraries: settings.libraries.filter((_, at) => at !== index) }); } }, t('libraryDelete')) : null);
    }
    return h('div', { id: `${surfaceId}-knowledgeConfig`, className: 'strong-settings__group strong-knowledge' },
      h('h3', null, t('knowledgeTitle')), h('p', { className: 'strong-settings__hint' }, t('knowledgeHint')),
      h('p', { className: 'strong-settings__hint' }, t('knowledgeBudget')),
      !settings.projects.length && !settings.libraries.length ? h('p', { className: 'strong-settings__hint' }, t('knowledgeEmpty')) : null,
      ...settings.projects.map((project, index) => h('details', { key: project.root }, h('summary', null, project.name, ' · ', t('knowledgeEdit')), projectForm(project, index))),
      h('details', null, h('summary', null, t('projectAdd')), projectForm()),
      ...settings.libraries.map((library, index) => h('details', { key: library.id }, h('summary', null, library.name, ' · ', library.scope === 'global' ? t('libraryGlobal') : settings.projects.find(project => project.root === library.scope)?.name, ' · ', t('knowledgeEdit')), libraryForm(library, index))),
      h('details', null, h('summary', null, t('libraryAdd')), h('p', { className: 'strong-settings__hint' }, t('knowledgeLocalHint')), libraryForm()));
  };
}
