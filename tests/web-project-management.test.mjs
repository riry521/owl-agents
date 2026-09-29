import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const { buildProjectUpdateInput, deletionDialogModel, formatCommandLine, impactFromError, isProjectAutoPushEnabled, parseCommandLine, projectEditForm, projectErrorKey } = loadProjectManagementModule();

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

test('ja and en project translations contain the same §10.5 keys', () => {
  const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const keys = [
    'editAria', 'deleteAria', 'folderLabel', 'editPathNote', 'editNoChanges', 'editSuccess', 'editNeedsGit', 'editBlocked',
    'deleteTitle', 'deleteConfirmEmpty', 'deleteConfirmWithWorks', 'deleteBacklogNote', 'deleteRenumberNote', 'deleteKeepsFiles',
    'deleteWithWorks', 'deleteConfirm', 'deleteBlocked', 'blockingWorksTitle', 'blockingWorksMore', 'blockingAgents',
    'deleteImpactChanged', 'deleteSuccess', 'deleteSuccessWithWorks', 'deleting', 'errorNotFound', 'errorCleanupFailed',
    'worktreeSetupLabel', 'worktreeRefreshLabel', 'worktreeCommandPlaceholder', 'worktreeCommandsHelp', 'worktreeCommandInvalid',
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
function createView() {
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
      slots[i] = { deps };
      pendingEffects.push(fn);
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
    'next/link': { default: ({ children }) => children },
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
    view.html = renderToStaticMarkup(React.createElement(loaded.exports.ProjectsView));
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
