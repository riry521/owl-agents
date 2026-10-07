import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const modelPresetsPath = join(repoRoot, 'apps/web/lib/model-presets.ts');

function loadModelPresets() {
  const source = readFileSync(modelPresetsPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(modelPresetsPath);
  loaded.filename = modelPresetsPath;
  loaded.paths = Module._nodeModulePaths(dirname(modelPresetsPath));
  loaded._compile(outputText, modelPresetsPath);
  return loaded.exports;
}

const { presetMatchesSettings, presetToRoleInputs } = loadModelPresets();

function role(role, provider, model, effort, catalog_version = '1.0.0') {
  return { role, provider, model, effort, catalog_version };
}

const EIGHT_ROLES = ['advisor', 'manager', 'designer', 'lead_designer', 'worker', 'reviewer', 'librarian', 'curator'];

function makeRoles(overrides = {}) {
  return EIGHT_ROLES.map((r) => role(r, 'anthropic', overrides[r]?.model ?? 'claude-sonnet-5', overrides[r]?.effort ?? 'medium'));
}

test('presetMatchesSettings is true for identical roles in a different order', () => {
  const roles = makeRoles();
  const preset = { roles: [...roles].reverse() };
  assert.equal(presetMatchesSettings(preset, roles), true);
});

test('presetMatchesSettings ignores catalog_version differences', () => {
  const roles = makeRoles();
  const preset = { roles: roles.map((r) => ({ ...r, catalog_version: '9.9.9' })) };
  assert.equal(presetMatchesSettings(preset, roles), true);
});

test('presetMatchesSettings is false when any role differs (provider, model, or effort)', () => {
  const roles = makeRoles();
  const withDifferentModel = { roles: makeRoles({ worker: { model: 'claude-opus-5' } }) };
  assert.equal(presetMatchesSettings(withDifferentModel, roles), false);

  const withDifferentEffort = { roles: makeRoles({ reviewer: { effort: 'high' } }) };
  assert.equal(presetMatchesSettings(withDifferentEffort, roles), false);
});

test('presetMatchesSettings is false when role counts differ', () => {
  const roles = makeRoles();
  const preset = { roles: roles.slice(0, 7) };
  assert.equal(presetMatchesSettings(preset, roles), false);
});

test('presetToRoleInputs strips catalog_version and keeps the four settings fields', () => {
  const roles = makeRoles();
  const inputs = presetToRoleInputs({ roles });
  assert.equal(inputs.length, roles.length);
  for (const input of inputs) {
    assert.equal(Object.hasOwn(input, 'catalog_version'), false);
    assert.equal(typeof input.role, 'string');
    assert.equal(typeof input.provider, 'string');
    assert.equal(typeof input.model, 'string');
    assert.equal(typeof input.effort, 'string');
  }
});
