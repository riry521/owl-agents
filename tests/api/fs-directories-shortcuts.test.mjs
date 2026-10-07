import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir } from '../helpers/temp.mjs';

const { listHostDirectories } = await import('../../apps/server/dist/fs-directories.js');

// "/dev" is on a different device than the temp dir, so fake volumes are not taken for the startup disk.
const otherDeviceRoot = '/dev';

async function fixture(t) {
  const base = await tempDir(t, 'owl-fs-shortcuts-');
  const home = join(base, 'home');
  const volumes = join(base, 'Volumes');
  mkdirSync(home);
  mkdirSync(volumes);
  return { base, home, volumes, roots: { homeDir: home, volumesDir: volumes, rootDir: otherDeviceRoot } };
}

test('shortcuts add volumes, cloud storage and iCloud Drive only when present', async (t) => {
  const f = await fixture(t);
  const empty = await listHostDirectories(f.home, false, join(f.base, 'data'), f.roots);
  assert.deepEqual(empty.shortcuts.map((s) => s.key), ['home']);

  mkdirSync(join(f.volumes, 'Backup'));
  mkdirSync(join(f.volumes, '.External'));
  mkdirSync(join(f.home, 'Library', 'CloudStorage', 'Dropbox'), { recursive: true });
  mkdirSync(join(f.home, 'Library', 'CloudStorage', '.Provider'), { recursive: true });
  mkdirSync(join(f.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true });
  const listing = await listHostDirectories(f.home, false, join(f.base, 'data'), f.roots);
  const byKey = Object.fromEntries(listing.shortcuts.map((s) => [s.key, s]));
  assert.equal(byKey['volume:Backup'].name, 'Backup');
  assert.equal(byKey['volume:Backup'].kind, 'volume');
  assert.equal(byKey['volume:.External'].name, '.External');
  assert.equal(byKey['volume:.External'].kind, 'volume');
  assert.equal(byKey['cloud:Dropbox'].name, 'Dropbox');
  assert.equal(byKey['cloud:Dropbox'].path, join(f.home, 'Library', 'CloudStorage', 'Dropbox'));
  assert.equal(byKey['cloud:.Provider'].name, '.Provider');
  assert.equal(byKey['cloud:.Provider'].kind, 'cloud');
  assert.equal(byKey.icloud.name, 'iCloud Drive');
});

test('the startup disk is excluded by symlink to / and by sharing its device', async (t) => {
  const f = await fixture(t);
  symlinkSync(otherDeviceRoot, join(f.volumes, 'Macintosh HD'));
  mkdirSync(join(f.volumes, 'External'));
  const listing = await listHostDirectories(f.home, false, join(f.base, 'data'), f.roots);
  assert.deepEqual(listing.shortcuts.filter((s) => s.kind === 'volume').map((s) => s.name), ['External']);

  const sameDevice = await listHostDirectories(f.home, false, join(f.base, 'data'), { ...f.roots, rootDir: f.base });
  assert.ok(!sameDevice.shortcuts.some((s) => s.name === 'External'));
});

test('a missing volumes directory is not an error', async (t) => {
  const f = await fixture(t);
  const listing = await listHostDirectories(f.home, false, join(f.base, 'data'), { ...f.roots, volumesDir: join(f.base, 'nope') });
  assert.ok(listing.shortcuts.every((s) => s.kind === undefined));
});

test('stat and readdir EACCES/EPERM return 403 with macOS permission steps', async (t) => {
  const f = await fixture(t);
  for (const operation of ['stat', 'readdir']) {
    for (const code of ['EACCES', 'EPERM']) {
      await t.test(`${operation} failing with ${code} returns 403 with permission steps`, async () => {
        const failure = Object.assign(new Error(code), { code });
        const fsOps = {
          stat: (path, ...args) => operation === 'stat' && path === f.home ? Promise.reject(failure) : stat(path, ...args),
          readdir: (path, ...args) => operation === 'readdir' && path === f.home ? Promise.reject(failure) : readdir(path, ...args),
        };
        await assert.rejects(listHostDirectories(f.home, false, join(f.base, 'data'), f.roots, fsOps), (error) => {
          assert.equal(error.status, 403);
          const hint = error.details.permission_hint;
          const text = hint.settings_paths.join(' ');
          assert.match(text, /フルディスクアクセス/);
          assert.match(text, /ファイルとフォルダ/);
          assert.match(text, /リムーバブルボリューム/);
          assert.match(text, /ネットワークボリューム/);
          assert.match(text, /ファイルプロバイダ/);
          assert.match(hint.steps, /ターミナルや Node/);
          return true;
        });
      });
    }
  }
});
