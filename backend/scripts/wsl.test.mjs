import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWslConfig } from './wsl.mjs';

test('existing Docker fixture retains its mount layout', () => {
  const config = createWslConfig({});
  assert.equal(config.linuxPath('D:\\project\\train.py'), '/mnt/host/d/project/train.py');
  assert.deepEqual(config.args('id', '-u'), ['-d', 'docker-desktop', '-u', 'root', '-e', 'id', '-u']);
});

test('independent distro selects standard mount root and preserves argument boundaries', () => {
  const config = createWslConfig({ TRAINERBUDDY_WSL_DISTRO: 'trainerbuddy-test' });
  const path = config.linuxPath("D:\\研究 项目\\a'b.txt");
  assert.equal(path, "/mnt/d/研究 项目/a'b.txt");
  assert.deepEqual(config.args('cp', path, '/tmp/test file'),
    ['-d', 'trainerbuddy-test', '-u', 'root', '-e', 'cp', path, '/tmp/test file']);
});

test('custom mount roots apply consistently', () => {
  const config = createWslConfig({ TRAINERBUDDY_WSL_DISTRO: 'custom', TRAINERBUDDY_WSL_MOUNT_ROOT: '/drives/' });
  assert.equal(config.linuxPath('C:/test/file'), '/drives/c/test/file');
});

test('invalid distro, mount and unsupported Windows paths fail before execution', () => {
  for (const distro of ['', ' leading', '-d', 'bad\nname']) {
    assert.throws(() => createWslConfig({ TRAINERBUDDY_WSL_DISTRO: distro }));
  }
  for (const root of ['', '/', 'mnt', '/mnt/../tmp', '//server', '/mnt\\host']) {
    assert.throws(() => createWslConfig({ TRAINERBUDDY_WSL_MOUNT_ROOT: root }));
  }
  const config = createWslConfig({});
  for (const path of ['relative/file', 'C:relative', '\\\\server\\share', 'D:/../file', 'D:/bad\nfile']) {
    assert.throws(() => config.linuxPath(path));
  }
});
