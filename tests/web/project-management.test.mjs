import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const modulePath = join(repoRoot, 'apps/web/lib/project-management.ts');
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));

function loadProjectManagementModule() {
  const source = readFileSync(modulePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  loaded._compile(outputText, modulePath);
  return loaded.exports;
}

const { buildProjectUpdateInput, deletionDialogModel, formatCommandLine, impactFromError, isProjectAutoPushEnabled, parseCommandLine, postMergeCommandPlaceholder, projectEditForm, investigateNoticeKey, investigateOutcome, projectErrorKey } = loadProjectManagementModule();

function project(overrides = {}) {
  return { id: 'project-id', name: 'Project', canonical_path: '/projects/project', ...overrides };
}

function impact(overrides = {}) {
  return {
    project_id: 'project-id',
    work_count: 0,
    running_work_count: 0,
    active_agent_count: 0,
    backlog_item_count: 0,
    running_works: [],
    blockers: [],
    deletable: true,
    ...overrides,
  };
}

test('buildProjectUpdateInput returns null when nothing changed', () => {
  assert.equal(buildProjectUpdateInput(project(), { name: ' Project ', path: '/projects/project' }), null);
});

test('isProjectAutoPushEnabled displays only boolean true as on', () => {
  assert.equal(isProjectAutoPushEnabled(project({ auto_push: true })), true);
  assert.equal(isProjectAutoPushEnabled(project({ auto_push: false })), false);
  assert.equal(isProjectAutoPushEnabled(project()), false);
});

test('buildProjectUpdateInput trims and includes only changed fields', () => {
  assert.deepEqual(buildProjectUpdateInput(project(), { name: '  New name  ', path: '/projects/project' }), { name: 'New name' });
  assert.deepEqual(buildProjectUpdateInput(project(), { name: 'Project', path: '/projects/other' }), { canonical_path: '/projects/other' });
  assert.deepEqual(buildProjectUpdateInput(project(), { name: ' New name ', path: '/projects/other' }), {
    name: 'New name',
    canonical_path: '/projects/other',
  });
});

test('buildProjectUpdateInput includes a boolean auto_push only when the toggle changes', () => {
  assert.deepEqual(buildProjectUpdateInput(project({ auto_push: false }), {
    name: 'Project',
    path: '/projects/project',
    autoPush: true,
  }), { auto_push: true });
  assert.deepEqual(buildProjectUpdateInput(project({ auto_push: true }), {
    name: 'Project',
    path: '/projects/project',
    autoPush: false,
  }), { auto_push: false });
  assert.equal(buildProjectUpdateInput(project({ auto_push: true }), {
    name: 'Project',
    path: '/projects/project',
    autoPush: true,
  }), null);
});

test('buildProjectUpdateInput sends commit_language as ja, en or null only when it changes', () => {
  const base = { name: 'Project', path: '/projects/project' };
  assert.deepEqual(buildProjectUpdateInput(project(), { ...base, commitLanguage: 'ja' }), { commit_language: 'ja' });
  assert.deepEqual(buildProjectUpdateInput(project({ commit_language: 'ja' }), { ...base, commitLanguage: 'en' }), { commit_language: 'en' });
  assert.deepEqual(buildProjectUpdateInput(project({ commit_language: 'en' }), { ...base, commitLanguage: null }), { commit_language: null });
  assert.equal(buildProjectUpdateInput(project({ commit_language: 'en' }), { ...base, commitLanguage: 'en' }), null);
  assert.equal(projectEditForm(project({ commit_language: 'en' })).commitLanguage, 'en');
  assert.equal(projectEditForm(project()).commitLanguage, null);
});

test('buildProjectUpdateInput rejects empty required fields', () => {
  assert.deepEqual(buildProjectUpdateInput(project(), { name: '  ', path: '/projects/project' }), { error: 'nameRequired' });
  assert.deepEqual(buildProjectUpdateInput(project(), { name: 'Project', path: '  ' }), { error: 'pathRequired' });
});

test('parseCommandLine splits words and quotes without shell expansion', () => {
  assert.deepEqual(parseCommandLine(''), []);
  assert.deepEqual(parseCommandLine('   '), []);
  assert.deepEqual(parseCommandLine('uvx code-review-graph build'), ['uvx', 'code-review-graph', 'build']);
  assert.deepEqual(parseCommandLine(`sh -c 'echo "$HOME" | tee out'`), ['sh', '-c', 'echo "$HOME" | tee out']);
  assert.deepEqual(parseCommandLine('printf "a \\"b\\" c" \'\''), ['printf', 'a "b" c', '']);
  assert.deepEqual(parseCommandLine('path\\ with\\ spaces x'), ['path with spaces', 'x']);
  assert.equal(parseCommandLine(`echo 'unterminated`), null);
  assert.equal(parseCommandLine('echo "unterminated'), null);
  assert.equal(parseCommandLine('trailing\\'), null);
});

test('formatCommandLine round-trips through parseCommandLine', () => {
  for (const argv of [[], ['serena', 'project', 'index'], ['sh', '-c', `echo 'it''s' "$X"`], ['a b', ''], ['--flag=value', './bin/tool']]) {
    assert.deepEqual(parseCommandLine(formatCommandLine(argv)), argv);
  }
  assert.equal(formatCommandLine(['uvx', 'code-review-graph', 'update']), 'uvx code-review-graph update');
});

test('buildProjectUpdateInput includes worktree commands only when they change', () => {
  const base = project({ worktree_setup_command: ['make', 'deps'], worktree_refresh_command: [] });
  const form = projectEditForm(base);
  assert.equal(form.setupCommand, 'make deps');
  assert.equal(form.refreshCommand, '');
  assert.equal(buildProjectUpdateInput(base, form), null);
  assert.deepEqual(buildProjectUpdateInput(base, { ...form, refreshCommand: `serena project index '.'` }), {
    worktree_refresh_command: ['serena', 'project', 'index', '.'],
  });
  assert.deepEqual(buildProjectUpdateInput(base, { ...form, setupCommand: '  ' }), { worktree_setup_command: [] });
  assert.deepEqual(buildProjectUpdateInput(base, { ...form, setupCommand: `make 'deps` }), { error: 'commandInvalid' });
  assert.equal(buildProjectUpdateInput(project(), { name: 'Project', path: '/projects/project', setupCommand: '', refreshCommand: '' }), null);
});

test('buildProjectUpdateInput includes the post-merge command only when it changes', () => {
  const unset = project({ post_merge_command: null, effective_post_merge_command: ['pnpm', 'build'] });
  const form = projectEditForm(unset);
  assert.equal(form.postMergeCommand, '');
  assert.equal(buildProjectUpdateInput(unset, form), null);
  assert.deepEqual(buildProjectUpdateInput(unset, { ...form, postMergeCommand: 'make "all deps"' }), { post_merge_command: ['make', 'all deps'] });
  const set = project({ post_merge_command: ['make', 'ci'] });
  const setForm = projectEditForm(set);
  assert.equal(setForm.postMergeCommand, 'make ci');
  assert.equal(buildProjectUpdateInput(set, setForm), null);
  assert.deepEqual(buildProjectUpdateInput(set, { ...setForm, postMergeCommand: '' }), { post_merge_command: null });
  assert.deepEqual(buildProjectUpdateInput(set, { ...setForm, postMergeDisabled: true }), { post_merge_command: [] });
  assert.deepEqual(buildProjectUpdateInput(set, { ...setForm, postMergeCommand: `make 'x` }), { error: 'commandInvalid' });
  // disabled toggle on an unset project, then unchanged on a disabled one
  assert.deepEqual(buildProjectUpdateInput(unset, { ...form, postMergeDisabled: true }), { post_merge_command: [] });
  const disabled = project({ post_merge_command: [] });
  const disabledForm = projectEditForm(disabled);
  assert.equal(disabledForm.postMergeDisabled, true);
  assert.equal(buildProjectUpdateInput(disabled, disabledForm), null);
  assert.deepEqual(buildProjectUpdateInput(disabled, { ...disabledForm, postMergeDisabled: false }), { post_merge_command: null });
  assert.deepEqual(buildProjectUpdateInput(disabled, { ...disabledForm, postMergeDisabled: false, postMergeCommand: 'make ci' }), { post_merge_command: ['make', 'ci'] });
  // undefined (older server) behaves like null
  const legacy = project({});
  assert.equal(buildProjectUpdateInput(legacy, projectEditForm(legacy)), null);
});

test('install command edits follow the same null / [] / argv rules as post-merge', () => {
  const unset = project({ post_merge_install_command: null });
  const form = projectEditForm(unset);
  assert.equal(form.installCommand, '');
  assert.equal(buildProjectUpdateInput(unset, form), null);
  assert.deepEqual(buildProjectUpdateInput(unset, { ...form, installCommand: 'npm ci' }), { post_merge_install_command: ['npm', 'ci'] });
  assert.deepEqual(buildProjectUpdateInput(unset, { ...form, installDisabled: true }), { post_merge_install_command: [] });
  assert.deepEqual(buildProjectUpdateInput(unset, { ...form, installCommand: `npm 'x` }), { error: 'commandInvalid' });
  const set = project({ post_merge_install_command: ['npm', 'ci'] });
  assert.deepEqual(buildProjectUpdateInput(set, { ...projectEditForm(set), installCommand: '' }), { post_merge_install_command: null });
});

test('postMergeCommandPlaceholder shows the default only while unset', () => {
  assert.deepEqual(postMergeCommandPlaceholder(project({ post_merge_command: null, effective_post_merge_command: ['pnpm', 'build'] })), { kind: 'default', command: 'pnpm build' });
  assert.deepEqual(postMergeCommandPlaceholder(project({ post_merge_command: [], effective_post_merge_command: [] })), { kind: 'none' });
  assert.deepEqual(postMergeCommandPlaceholder(project({ post_merge_command: ['make'], effective_post_merge_command: ['make'] })), { kind: 'none' });
  assert.deepEqual(postMergeCommandPlaceholder(project({})), { kind: 'none' });
});

test('deletionDialogModel distinguishes empty and with-Works projects', () => {
  assert.deepEqual(deletionDialogModel(impact()), { variant: 'empty' });
  assert.deepEqual(deletionDialogModel(impact({ work_count: 4, backlog_item_count: 2 })), {
    variant: 'withWorks',
    workCount: 4,
    backlogCount: 2,
  });
});

test('deletionDialogModel describes blockers and hidden running Works', () => {
  const runningWorks = [{ id: 'work-1', display_number: 1, title: 'Blocked', state: 'running' }];
  assert.deepEqual(deletionDialogModel(impact({
    running_work_count: 3,
    active_agent_count: 2,
    running_works: runningWorks,
    blockers: ['running_works', 'active_agents'],
    deletable: false,
  })), {
    variant: 'blocked',
    runningWorks,
    hiddenRunningCount: 2,
    activeAgentCount: 2,
  });
});

test('impactFromError returns valid impact only for project blocker and confirmation conflict errors', () => {
  const expected = impact({ work_count: 2 });
  assert.deepEqual(impactFromError({ message: 'project_has_running_works', code: 'project_has_running_works', details: { impact: expected } }), expected);
  assert.deepEqual(impactFromError({ message: 'project_deletion_impact_changed', code: 'project_deletion_impact_changed', details: { impact: expected } }), expected);
  assert.equal(impactFromError({ message: 'validation_error', code: 'validation_error', details: { impact: expected } }), null);
  assert.equal(impactFromError({ message: 'project_has_running_works', code: 'project_has_running_works', details: { impact: { ...expected, deletable: 'yes' } } }), null);
});

test('projectErrorKey maps each API code by operation context', () => {
  const key = (code, context, details = {}) => projectErrorKey({ message: code, code, details }, context);
  assert.equal(key('validation_error', 'load'), 'projects.errorValidation');
  assert.equal(key('validation_error', 'edit'), 'projects.errorValidation');
  assert.equal(key('validation_error', 'edit', { inspection: { kind: 'not_git' } }), 'projects.editNeedsGit');
  assert.equal(key('validation_error', 'edit', { canonical_path: '/projects/duplicate', project_id: 'other-project' }), 'projects.errorDuplicate');
  assert.equal(key('validation_error', 'delete'), 'projects.errorValidation');
  assert.equal(key('project_path_conflict', 'load'), 'projects.errorDuplicate');
  assert.equal(key('project_path_conflict', 'edit'), 'projects.errorDuplicate');
  assert.equal(key('project_path_conflict', 'delete'), 'projects.errorDefault');
  assert.equal(key('project_has_running_works', 'edit'), 'projects.editBlocked');
  assert.equal(key('project_has_running_works', 'delete'), 'projects.deleteBlocked');
  assert.equal(key('project_has_running_works', 'load'), 'projects.errorDefault');
  assert.equal(key('project_deletion_impact_changed', 'delete'), 'projects.deleteImpactChanged');
  assert.equal(key('project_deletion_impact_changed', 'edit'), 'projects.errorDefault');
  assert.equal(key('project_not_found', 'load'), 'projects.errorNotFound');
  assert.equal(key('project_not_found', 'edit'), 'projects.errorNotFound');
  assert.equal(key('project_not_found', 'delete'), 'projects.errorNotFound');
  assert.equal(key('worktree_cleanup_failed', 'delete'), 'projects.errorCleanupFailed');
  assert.equal(key('worktree_cleanup_failed', 'load'), 'projects.errorDefault');
  for (const context of ['load', 'edit', 'delete']) {
    assert.equal(key('network_error', context), 'projects.errorNetwork');
    assert.equal(key('runtime_config_unavailable', context), 'projects.errorNetwork');
    assert.equal(key('invalid_runtime_config', context), 'projects.errorInvalidResponse');
    assert.equal(key('invalid_response', context), 'projects.errorInvalidResponse');
    assert.equal(key('unexpected_error', context), 'projects.errorDefault');
  }
});

test('ja and en project translations contain the same project management keys', () => {
  const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const keys = [
    'editAria', 'deleteAria', 'folderLabel', 'editPathNote', 'editNoChanges', 'editSuccess', 'editNeedsGit', 'editBlocked',
    'deleteTitle', 'deleteConfirmEmpty', 'deleteConfirmWithWorks', 'deleteBacklogNote', 'deleteRenumberNote', 'deleteKeepsFiles',
    'deleteWithWorks', 'deleteConfirm', 'deleteBlocked', 'blockingWorksTitle', 'blockingWorksMore', 'blockingAgents',
    'deleteImpactChanged', 'deleteSuccess', 'deleteSuccessWithWorks', 'deleting', 'errorNotFound', 'errorCleanupFailed',
    'worktreeSetupLabel', 'worktreeRefreshLabel', 'worktreeCommandPlaceholder', 'worktreeCommandsHelp', 'worktreeCommandInvalid', 'postMergeLabel', 'postMergeHelp', 'postMergeDefaultPlaceholder', 'postMergePlaceholder', 'postMergeDisabledLabel', 'postMergeOn', 'postMergeInstallLabel', 'postMergeInstallHelp', 'postMergeInstallPlaceholder', 'postMergeInstallDisabledLabel',
  ];
  for (const key of keys) {
    assert.equal(typeof ja.projects[key], 'string', `ja projects.${key}`);
    assert.equal(typeof en.projects[key], 'string', `en projects.${key}`);
    assert.ok(ja.projects[key].length > 0, `ja projects.${key} is not empty`);
    assert.ok(en.projects[key].length > 0, `en projects.${key} is not empty`);
  }
  assert.equal(ja.projects.errorDefault, 'Projectを取得・更新できませんでした。しばらくしてからもう一度お試しください。');
  assert.equal(en.projects.errorDefault, 'The project could not be loaded or updated. Try again shortly.');
  for (const key of ['edit', 'delete', 'save', 'saving', 'cancel', 'close', 'loading']) {
    assert.equal(typeof ja.common[key], 'string', `ja common.${key}`);
    assert.equal(typeof en.common[key], 'string', `en common.${key}`);
  }
});

// ---- API request shapes and ProjectsView edit/delete flows -----------------
//
// Same approach as tests/web-folder-picker.test.mjs: the real api-client.ts runs
// against a stubbed fetch, and ProjectsView.tsx is transpiled with the real TS
// compiler and driven with a small hook harness instead of a full renderer.

const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');
const viewPath = join(repoRoot, 'apps/web/components/ProjectsView.tsx');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const realJsxRuntime = webRequire('react/jsx-runtime');

function loadApiClient() {
  const { outputText } = ts.transpileModule(readFileSync(apiClientPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(apiClientPath);
  loaded.filename = apiClientPath;
  loaded.paths = Module._nodeModulePaths(dirname(apiClientPath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/format') return { runOrdinals: () => new Map() };
    if (request === '@/lib/work-detail-safety.mjs') return { normalizeWorkDetailData: (value) => value };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, apiClientPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

/** Fake Owl API: records every non-config request and answers from `handler(method, pathname, body)`. */
function installFakeApi(handler) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, pathname: url.pathname, body });
    return new Response(JSON.stringify(handler(method, url.pathname, body)), { status: 200 });
  };
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

function assertCommandEnvelope(body, payload) {
  assert.equal(typeof body.request_id, 'string');
  assert.equal(typeof body.idempotency_key, 'string');
  assert.equal(body.expected_version, 0);
  assert.deepEqual(body.payload, payload);
}

test('updateProject PATCHes /projects/{id} with the changed fields as the command payload', async () => {
  const { updateProject } = loadApiClient();
  const updated = project({ id: 'p/1', name: 'Renamed' });
  const api = installFakeApi(() => ({ request_id: 'r1', data: updated, version: 1 }));
  try {
    const input = buildProjectUpdateInput(project({ id: 'p/1' }), { name: ' Renamed ', path: '/projects/project', autoPush: true });
    const result = await updateProject('p/1', input);
    assert.deepEqual(result, updated);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, 'PATCH');
    assert.equal(api.requests[0].pathname, '/api/v1/projects/p%2F1');
    assertCommandEnvelope(api.requests[0].body, { name: 'Renamed', auto_push: true });
  } finally {
    api.restore();
  }
});

test('deleteProject DELETEs /projects/{id} with confirmed_work_count and getProjectDeletionImpact GETs deletion-impact', async () => {
  const { deleteProject, getProjectDeletionImpact } = loadApiClient();
  const api = installFakeApi((method) => (method === 'GET'
    ? { request_id: 'r1', data: impact({ project_id: 'project-id', work_count: 3 }) }
    : { request_id: 'r2', data: { project_id: 'project-id', detached_work_count: 3 }, version: 1 }));
  try {
    assert.equal((await getProjectDeletionImpact('project-id')).work_count, 3);
    await deleteProject('project-id', 3);
    assert.deepEqual(api.requests.map(({ method, pathname }) => [method, pathname]), [
      ['GET', '/api/v1/projects/project-id/deletion-impact'],
      ['DELETE', '/api/v1/projects/project-id'],
    ]);
    assertCommandEnvelope(api.requests[1].body, { confirmed_work_count: 3 });
  } finally {
    api.restore();
  }
});

// Minimal render harness: hooks live in slots that survive re-renders, effects
// run after each render when their deps change, and the patched JSX runtime
// records every element so tests can call the handlers React would call.
function createView(props = {}) {
  const slots = [];
  let index = 0;
  let elements = [];
  let pendingEffects = [];
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));
  const record = (jsx) => (type, props, ...rest) => {
    elements.push({ type, props });
    return jsx(type, props, ...rest);
  };
  const jsxRuntime = { ...realJsxRuntime, jsx: record(realJsxRuntime.jsx), jsxs: record(realJsxRuntime.jsxs) };
  const hooks = {
    ...React,
    useState(initial) {
      const i = index++;
      slots[i] ??= { value: initial };
      return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useRef(initial) {
      const i = index++;
      return (slots[i] ??= { value: { current: initial } }).value;
    },
    useCallback(fn, deps) {
      const i = index++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: fn, deps };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = index++;
      if (slots[i] && sameDeps(slots[i].deps, deps)) return;
      // The holder outlives re-renders so a queued effect always cleans up the one before it.
      const holder = slots[i]?.holder ?? {};
      slots[i] = { deps, holder };
      pendingEffects.push(() => {
        holder.cleanup?.();
        holder.cleanup = fn();
      });
    },
  };

  // The delete dialog registers a keydown listener on window from an effect.
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

  const { outputText } = ts.transpileModule(readFileSync(viewPath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(viewPath);
  loaded.filename = viewPath;
  loaded.paths = Module._nodeModulePaths(dirname(viewPath));
  const modules = {
    react: hooks,
    'react/jsx-runtime': jsxRuntime,
    'next/link': ({ href, children }) => React.createElement('a', { href }, children),
    'next/navigation': { useRouter: () => ({ push: () => {} }) },
    '@/lib/i18n': { useLocale: () => ({ locale: 'en', t: (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key) }) },
    '@/lib/format': { workStateLabels: () => ({}) },
    '@/lib/api-client': loadApiClient(),
    '@/lib/project-management': loadProjectManagementModule(),
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(modules, request)) return modules[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, viewPath);
  } finally {
    Module._load = originalLoad;
  }

  function renderOnce() {
    index = 0;
    elements = [];
    view.html = renderToStaticMarkup(React.createElement(loaded.exports.ProjectsView, props));
  }
  const view = {
    html: '',
    /** Renders, runs the effects and lets their async work settle, then renders the settled state. */
    async render() {
      renderOnce();
      const effects = pendingEffects;
      pendingEffects = [];
      effects.forEach((effect) => effect());
      await new Promise((resolve) => setTimeout(resolve, 0));
      renderOnce();
    },
    find(type, predicate) {
      const found = elements.find((element) => element.type === type && predicate(element.props));
      assert.ok(found, `no <${type}> matched`);
      return found.props;
    },
    async click(type, predicate) {
      view.find(type, predicate).onClick();
      await view.render();
    },
    async change(predicate, value) {
      view.find('input', predicate).onChange({ target: { value } });
      await view.render();
    },
    async submit(predicate) {
      view.find('form', predicate).onSubmit({ preventDefault: () => {} });
      await view.render();
    },
  };
  return view;
}

const byAria = (label) => (props) => props['aria-label'] === label;
const byText = (text) => (props) => props.children === text;
const byClass = (className) => (props) => props.className === className;

function fakeProjectServer(initial) {
  const projects = [...initial];
  return installFakeApi((method, pathname, body) => {
    const id = pathname.split('/')[4];
    const found = projects.find((entry) => entry.id === id);
    if (method === 'GET' && pathname === '/api/v1/projects') return { request_id: 'r', data: projects, has_more: false };
    if (method === 'GET') return { request_id: 'r', data: impact({ project_id: id, work_count: 2, backlog_item_count: 4 }) };
    if (method === 'PATCH') {
      Object.assign(found, body.payload);
      return { request_id: 'r', data: found, version: 1 };
    }
    projects.splice(projects.indexOf(found), 1);
    return { request_id: 'r', data: { project_id: id, detached_work_count: body.payload.confirmed_work_count }, version: 1 };
  });
}

const twoProjects = () => [project({ id: 'p1', name: 'Alpha' }), project({ id: 'p2', name: 'Beta', canonical_path: '/projects/beta' })];
const requestsOf = (api, method) => api.requests.filter((request) => request.method === method);

test('ProjectsView edit sends the changed fields to the update API and shows the result in the list', async () => {
  const api = fakeProjectServer(twoProjects());
  try {
    const view = createView();
    await view.render();
    assert.match(view.html, /Alpha/);

    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    await view.change((props) => props.value === 'Alpha', 'Alpha Renamed');
    await view.submit(byClass('project-edit'));

    const patches = requestsOf(api, 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].pathname, '/api/v1/projects/p1');
    assertCommandEnvelope(patches[0].body, { name: 'Alpha Renamed' });
    assert.match(view.html, /Alpha Renamed/);
    assert.match(view.html, /Beta/);
    assert.match(view.html, /projects\.editSuccess/);
    assert.doesNotMatch(view.html, /project-edit/);
  } finally {
    api.restore();
  }
});

test('ProjectsView edit with no changes does not call the update API', async () => {
  const api = fakeProjectServer(twoProjects());
  try {
    const view = createView();
    await view.render();
    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    await view.submit(byClass('project-edit'));
    assert.equal(requestsOf(api, 'PATCH').length, 0);
    assert.match(view.html, /projects\.editNoChanges/);
  } finally {
    api.restore();
  }
});

test('ProjectsView delete shows the impact confirmation first, then calls the delete API and removes the project', async () => {
  const api = fakeProjectServer(twoProjects());
  try {
    const view = createView();
    await view.render();
    await view.click('button', byAria('projects.deleteAria{"name":"Alpha"}'));

    assert.equal(requestsOf(api, 'DELETE').length, 0, 'nothing is deleted before the confirmation');
    assert.ok(api.requests.some((request) => request.method === 'GET' && request.pathname === '/api/v1/projects/p1/deletion-impact'));
    assert.match(view.html, /projects\.deleteTitle/);
    assert.match(view.html, /projects\.deleteConfirmWithWorks\{&quot;name&quot;:&quot;Alpha&quot;,&quot;count&quot;:&quot;2&quot;\}/);
    assert.match(view.html, /projects\.deleteBacklogNote\{&quot;count&quot;:&quot;4&quot;\}/);
    assert.match(view.html, /projects\.deleteKeepsFiles/);

    await view.click('button', byText('common.cancel'));
    assert.equal(requestsOf(api, 'DELETE').length, 0, 'cancel does not delete');
    assert.doesNotMatch(view.html, /projects\.deleteTitle/);
    assert.match(view.html, /Alpha/);

    await view.click('button', byAria('projects.deleteAria{"name":"Alpha"}'));
    await view.click('button', byClass('btn btn--danger'));

    const deletes = requestsOf(api, 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].pathname, '/api/v1/projects/p1');
    assertCommandEnvelope(deletes[0].body, { confirmed_work_count: 2 });
    assert.doesNotMatch(view.html, /Alpha/);
    assert.match(view.html, /Beta/);
    assert.match(view.html, /projects\.deleteSuccessWithWorks/);
    assert.doesNotMatch(view.html, /projects\.deleteTitle/);
  } finally {
    api.restore();
  }
});

test('ProjectsView links each running Work that blocks deletion to its Work detail page', async () => {
  const runningWork = { id: 'work/1', title: 'Busy work', state: 'running', display_number: 7 };
  const api = installFakeApi((method, pathname) => {
    if (method === 'GET' && pathname === '/api/v1/projects') return { request_id: 'r', data: twoProjects(), has_more: false };
    return { request_id: 'r', data: impact({ project_id: 'p1', work_count: 1, running_work_count: 1, running_works: [runningWork], blockers: ['running_works'], deletable: false }) };
  });
  try {
    const view = createView();
    await view.render();
    await view.click('button', byAria('projects.deleteAria{"name":"Alpha"}'));

    assert.match(view.html, /<a href="\/work\?id=work%2F1">#7 Busy work<\/a>/);
  } finally {
    api.restore();
  }
});

test('テストの実行方法の3つの選択肢は test_run: null / { mode: whole, whole_argv } / { mode: off } を送り、per_file の指定は変えない限り送らない', () => {
  const build = (projectOverrides, formOverrides) => buildProjectUpdateInput(project(projectOverrides), { ...projectEditForm(project(projectOverrides)), ...formOverrides });
  assert.deepEqual(build({ test_run: { mode: 'off' } }, { testRunMode: 'auto' }), { test_run: null });
  assert.deepEqual(build({}, { testRunMode: 'command', testRunCommand: 'make "test all"' }), { test_run: { mode: 'whole', whole_argv: ['make', 'test all'] } });
  assert.deepEqual(build({}, { testRunMode: 'off' }), { test_run: { mode: 'off' } });
  assert.equal(build({ test_run: { mode: 'whole', whole_argv: ['make', 'test'] } }, {}), null);
  assert.deepEqual(build({ test_run: { mode: 'whole', whole_argv: ['make', 'test'] } }, { testRunCommand: 'make check' }), { test_run: { mode: 'whole', whole_argv: ['make', 'check'] } });
  const perFile = { mode: 'per_file', file_argv: ['node', '--test', '{file}'] };
  assert.equal(projectEditForm(project({ test_run: perFile })).testRunMode, 'custom');
  assert.equal(build({ test_run: perFile }, {}), null);
  assert.deepEqual(build({ test_run: perFile }, { name: 'Renamed' }), { name: 'Renamed' });
  assert.deepEqual(build({ test_run: perFile }, { testRunMode: 'auto' }), { test_run: null });
  assert.deepEqual(build({}, { testRunMode: 'command', testRunCommand: '  ' }), { error: 'testCommandRequired' });
  assert.deepEqual(build({}, { testRunMode: 'command', testRunCommand: "make 'x" }), { error: 'commandInvalid' });
});

test('テストの実行方法と調べた設定の文言が ja/en にそろっている', () => {
  const statuses = ['ready', 'tests_failing', 'no_tests', 'no_language', 'needs_approval', 'unresolved'];
  const keys = [
    'testRunModeLabel', 'testRunModeAuto', 'testRunModeCommand', 'testRunModeOff', 'testRunModeCustom', 'testRunCommandLabel', 'testRunCommandRequired', 'testRunModeHelp',
    'testSetupInvestigate', 'testSetupInvestigating', ...['not_a_git_checkout', 'investigation_unavailable', 'investigation_failed', 'unknown'].map((reason) => `testSetupFailReason_${reason}`), 'testSetupInvestigateAccepted', 'testSetupInvestigateDone', 'testSetupInvestigateFailed', 'testSetupInvestigateTimeout',
    ...['explicit_test_run', 'runner_unavailable', 'provider_paused'].map((reason) => `testSetupInvestigateUnavailable_${reason}`),
    ...statuses.map((status) => `testSetupStatus_${status}`),
  ];
  for (const lang of ['ja', 'en']) {
    const projects = JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8')).projects;
    for (const key of keys) assert.ok(projects[key], `${lang}: ${key}`);
  }
  const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8')).projects;
  assert.equal(ja.testRunSourceSetup, '調べて確かめた設定');
});

test('test_run_status.reason の識別子はすべて ja/en の辞書に説明がある', () => {
  const coreSrc = ['test-detection-rules.ts', 'test-detection.ts']
    .map((f) => readFileSync(join(repoRoot, 'packages/core/src', f), 'utf8')).join('\n');
  const reasons = new Set([
    ...[...coreSrc.matchAll(/offRule\([^\n]*?"(\w+)"\)/g)].map((m) => m[1]),
    ...[...coreSrc.matchAll(/reason: "(\w+)"/g)].map((m) => m[1]),
    ...[...coreSrc.matchAll(/\?\? "(\w+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(reasons.has('no_test_marker') && reasons.has('explicit_off'));
  for (const lang of ['ja', 'en']) {
    const projects = JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8')).projects;
    for (const reason of reasons) {
      const text = projects[`testRunReason_${reason}`];
      assert.ok(text, `${lang}: ${reason}`);
      assert.notEqual(text, reason);
    }
  }
});

test('investigateNoticeKey は 202 を受け付け表示に、409 test_setup_unavailable を reason ごとの表示にする', () => {
  assert.equal(investigateNoticeKey(null), 'projects.testSetupInvestigateAccepted');
  for (const reason of ['explicit_test_run', 'runner_unavailable', 'provider_paused']) {
    assert.equal(investigateNoticeKey({ code: 'test_setup_unavailable', details: { reason } }), `projects.testSetupInvestigateUnavailable_${reason}`);
  }
  assert.equal(investigateNoticeKey({ code: 'project_not_found' }), 'projects.errorNotFound');
});

const detailedSetup = (overrides = {}) => ({
  status: 'ready', command: ['pytest'], setup_commands: [['uv', 'sync-marker']], prepare_command: null, cwd: 'cwd-marker',
  executables: {}, sources: ['sources-marker.md'], confirmed_at: null,
  attempts: [{ by: 'agent', argv: ['attempt-marker'], exit_code: 0, result: 'passed', summary: '', at: '2026-10-10T00:00:00Z' }],
  outside_installs: [{ argv: ['outside-marker'], reason: 'r', approved_at: null }], missing: ['missing-marker'],
  trigger: 'manual', investigated_at: '2026-10-10T00:00:00Z', ...overrides,
});
const testRunStatus = { enabled: true, reason: null, command: ['run-marker'], source: 'setup' };

test('investigateOutcome はサーバーの調査状態から、調査中・完了・失敗（記録なしの終了を含む）を決める', () => {
  assert.deepEqual(investigateOutcome({ running: true, outcome: null }), { state: 'pending' });
  assert.deepEqual(investigateOutcome({ running: false, outcome: { saved: true, status: 'ready', reason: null } }), { state: 'done' });
  assert.deepEqual(investigateOutcome({ running: false, outcome: { saved: true, status: 'unresolved', reason: null } }), { state: 'failed', reason: 'unresolved' });
  assert.deepEqual(investigateOutcome({ running: false, outcome: { saved: false, status: null, reason: 'not_a_git_checkout' } }), { state: 'failed', reason: 'not_a_git_checkout' });
  assert.deepEqual(investigateOutcome({ running: false, outcome: null }), { state: 'failed', reason: 'unknown' });
});

test('ProjectsView の一覧にはテスト調査の表示もボタンも出ず、編集画面の中に設定とボタンがあり詳しいログは出ない', async () => {
  const api = fakeProjectServer([project({ id: 'p1', name: 'Alpha', test_setup: detailedSetup(), test_run_status: testRunStatus })]);
  try {
    const view = createView();
    await view.render();
    assert.match(view.html, /Alpha/);
    assert.match(view.html, /projects\.editAria/);
    assert.doesNotMatch(view.html, /testSetup|testRunOn|testRunOff|run-marker/);

    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    assert.match(view.html, /projects\.testRunModeLabel/);
    assert.match(view.html, /projects\.testRunOn/);
    assert.match(view.html, /run-marker/);
    assert.match(view.html, /projects\.testSetupInvestigate/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).type, 'button');
    assert.doesNotMatch(view.html, /sync-marker|cwd-marker|sources-marker|attempt-marker|outside-marker|missing-marker|testSetupAttempts|testSetupMissing|testSetupOutside/);
  } finally {
    api.restore();
  }
});

function investigateServer(stateFor, initial = { running: false, outcome: null }) {
  // stateFor receives how many state reads happened since the POST; before it the server answers `initial`.
  let reads = 0;
  let posted = false;
  return installFakeApi((method, pathname) => {
    if (method === 'POST') {
      posted = true;
      return { request_id: 'r', data: { project_id: 'p1', trigger: 'manual', accepted: true } };
    }
    if (pathname.endsWith('/test-setup/investigation')) {
      if (!posted) return { request_id: 'r', data: { project_id: 'p1', ...initial } };
      reads += 1;
      return { request_id: 'r', data: { project_id: 'p1', ...stateFor(reads) } };
    }
    return { request_id: 'r', data: [project({ id: 'p1', name: 'Alpha', test_setup: detailedSetup() })], has_more: false };
  });
}
const finished = (outcome) => ({ running: false, outcome });

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const formHtml = (html) => {
  const start = html.indexOf('class="project-edit"');
  return html.slice(start, html.indexOf('</form>', start));
};

test('ProjectsView の調べ直しボタンは編集フォームの中で POST を1回だけ送り、受け付け・調査中のあと調査が終わると完了を出す', async () => {
  const api = investigateServer((reads) => (reads >= 2 ? finished({ saved: true, status: 'ready', reason: null }) : { running: true, outcome: null }));
  try {
    const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 10000 });
    await view.render();
    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    await view.click('button', byText('projects.testSetupInvestigate'));
    const posts = requestsOf(api, 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].pathname, '/api/v1/projects/p1/test-setup/investigate');
    assert.equal(requestsOf(api, 'PATCH').length, 0);
    assert.match(formHtml(view.html), /projects\.testSetupInvestigateAccepted/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, true);
    await view.render();
    await settle();
    await view.render();
    assert.match(formHtml(view.html), /projects\.testSetupInvestigateDone/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, false);
  } finally {
    api.restore();
  }
});

test('ProjectsView は記録の status が ready 以外、または記録を残さず終わった調査を失敗と理由で出す', async () => {
  const cases = [
    [{ saved: true, status: 'unresolved', reason: null }, 'unresolved'],
    [{ saved: false, status: null, reason: 'not_a_git_checkout' }, 'not_a_git_checkout'],
  ];
  for (const [outcome, label] of cases) {
    const api = investigateServer((reads) => (reads >= 1 ? finished(outcome) : { running: true, outcome: null }));
    try {
      const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 10000 });
      await view.render();
      await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
      await view.click('button', byText('projects.testSetupInvestigate'));
      await view.render();
      await settle();
      await view.render();
      assert.match(formHtml(view.html), /projects\.testSetupInvestigateFailed/);
      assert.ok(formHtml(view.html).includes(label), label);
    } finally {
      api.restore();
    }
  }
});

test('ProjectsView は打ち切り時間を過ぎると調査中の文言を出し、調査の終了が分かるまでボタンを押せないままにする', async () => {
  const api = investigateServer(() => ({ running: true, outcome: null }));
  try {
    const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 20 });
    await view.render();
    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    await view.click('button', byText('projects.testSetupInvestigate'));
    await view.render();
    await settle();
    await view.render();
    assert.match(formHtml(view.html), /projects\.testSetupInvestigateTimeout/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, true);
  } finally {
    api.restore();
  }
});

test('ProjectsView は POST の応答を待つあいだに編集をやめたら、応答のあとで状態も読み直しも始めない', async () => {
  const api = investigateServer(() => ({ running: true, outcome: null }));
  const okFetch = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (input, init = {}) => {
    if (init.method === 'POST') await gate;
    return okFetch(input, init);
  };
  try {
    const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 10000 });
    await view.render();
    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    const stateReads = () => api.requests.filter((request) => request.pathname.endsWith('/test-setup/investigation')).length;
    const readsOnOpen = stateReads();
    const clicking = view.click('button', byText('projects.testSetupInvestigate'));
    await view.click('button', byText('common.cancel'));
    release();
    await clicking;
    await settle();
    await view.render();
    assert.equal(stateReads(), readsOnOpen);
    assert.doesNotMatch(view.html, /testSetupInvestigateAccepted/);
  } finally {
    globalThis.fetch = okFetch;
    api.restore();
  }
});

test('ProjectsView は編集を開いたとき、調査中ならボタンを押せないまま読み直しを再開し、終わっていれば完了または失敗と理由を出す', async () => {
  const cases = [
    [{ running: true, outcome: null }, finished({ saved: true, status: 'ready', reason: null }), /projects\.testSetupInvestigateDone/],
    [finished({ saved: false, status: null, reason: 'not_a_git_checkout' }), null, /projects\.testSetupInvestigateFailed.*not_a_git_checkout/],
  ];
  for (const [initial, later, expected] of cases) {
    // The first read is the one made when the form opens; later reads come from the resumed polling.
    let reads = 0;
    const api = installFakeApi((method, pathname) => {
      if (pathname.endsWith('/test-setup/investigation')) {
        reads += 1;
        return { request_id: 'r', data: { project_id: 'p1', ...(reads > 1 && later ? later : initial) } };
      }
      return { request_id: 'r', data: [project({ id: 'p1', name: 'Alpha', test_setup: detailedSetup() })], has_more: false };
    });
    try {
      const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 10000 });
      await view.render();
      await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
      if (initial.running) {
        assert.match(formHtml(view.html), /projects\.testSetupInvestigateAccepted/);
        assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, true);
        await view.render();
        await settle();
        await view.render();
      }
      assert.match(formHtml(view.html), expected);
      assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, false);
      assert.equal(requestsOf(api, 'POST').length, 0);
    } finally {
      api.restore();
    }
  }
});

test('ProjectsView は編集を開いて調査状態を読み終えるまでボタンを押せず、読めなかったときは理由と読み直しのボタンを出して押せないままにする', async () => {
  const api = installFakeApi(() => ({ request_id: 'r', data: [project({ id: 'p1', name: 'Alpha', test_setup: detailedSetup() })], has_more: false }));
  const okFetch = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The first state read is held until released and then fails; the next one finds that nothing ran.
  let stateReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    if (!String(input.url ?? input).endsWith('/test-setup/investigation')) return okFetch(input, init);
    stateReads += 1;
    if (stateReads === 1) {
      await gate;
      return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'x' } }), { status: 500 });
    }
    return new Response(JSON.stringify({ request_id: 'r', data: { project_id: 'p1', running: false, outcome: null } }), { status: 200 });
  };
  try {
    const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 10000 });
    await view.render();
    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    assert.match(formHtml(view.html), /projects\.testSetupStateLoading/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, true);

    release();
    await settle();
    await view.render();
    assert.match(formHtml(view.html), /projects\.testSetupStateLoadFailed.*projects\.errorDefault/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, true);

    await view.click('button', byText('projects.testSetupStateReload'));
    await view.render();
    assert.equal(stateReads, 2);
    assert.doesNotMatch(formHtml(view.html), /testSetupState/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, false);
    assert.equal(requestsOf(api, 'POST').length, 0);
  } finally {
    globalThis.fetch = okFetch;
    api.restore();
  }
});

test('ProjectsView は 409 test_setup_unavailable の reason ごとの文言を編集フォームの中に出す', async () => {
  const api = investigateServer(() => ({ running: true, outcome: null }));
  const okFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => (init.method === 'POST' && !String(input.url ?? input).includes('runtime-config')
    ? new Response(JSON.stringify({ error: { code: 'test_setup_unavailable', message: 'x', details: { reason: 'provider_paused' } } }), { status: 409 })
    : okFetch(input, init));
  try {
    const view = createView({ pollIntervalMs: 5, pollTimeoutMs: 10000 });
    await view.render();
    await view.click('button', byAria('projects.editAria{"name":"Alpha"}'));
    await view.click('button', byText('projects.testSetupInvestigate'));
    assert.match(formHtml(view.html), /projects\.testSetupInvestigateUnavailable_provider_paused/);
    assert.equal(view.find('button', byText('projects.testSetupInvestigate')).disabled, false);
  } finally {
    globalThis.fetch = okFetch;
    api.restore();
  }
});
