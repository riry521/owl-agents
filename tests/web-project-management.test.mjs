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

const { buildProjectUpdateInput, deletionDialogModel, impactFromError, isProjectAutoPushEnabled, projectErrorKey } = loadProjectManagementModule();

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
