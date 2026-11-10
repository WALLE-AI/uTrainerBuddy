import assert from 'node:assert/strict';

// Shared by setup and acceptance so they cannot silently target different distros.
export function createWslConfig(env = process.env) {
  const distro = env.TRAINERBUDDY_WSL_DISTRO ?? 'docker-desktop';
  assert(distro.trim() === distro && distro.length > 0 && !distro.startsWith('-') && !/[\r\n\0]/.test(distro),
    'TRAINERBUDDY_WSL_DISTRO must be a nonempty WSL distribution name');
  const mountRoot = (env.TRAINERBUDDY_WSL_MOUNT_ROOT ?? (distro === 'docker-desktop' ? '/mnt/host' : '/mnt')).replace(/\/+$/, '');
  assert(mountRoot.startsWith('/') && !mountRoot.startsWith('//') && !/[\\\r\n\0]/.test(mountRoot)
    && mountRoot.split('/').every(part => part !== '..' && part !== '.'),
  'TRAINERBUDDY_WSL_MOUNT_ROOT must be an absolute Linux mount directory without traversal');
  return {
    distro,
    mountRoot,
    // Fixtures need root for their private namespaces/chroots, not a user's default account.
    args: (...command) => ['-d', distro, '-u', 'root', '-e', ...command],
    linuxPath(value) {
      assert(typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\r\n\0]/.test(value),
        'WSL paths must be absolute Windows drive paths');
      const normalized = value.replaceAll('\\', '/');
      assert(!normalized.split('/').some(part => part === '..' || part === '.'), 'WSL paths must not contain traversal');
      return mountRoot + '/' + normalized[0].toLowerCase() + normalized.slice(2);
    },
  };
}

export const wsl = createWslConfig();
export const linuxPath = value => wsl.linuxPath(value);
