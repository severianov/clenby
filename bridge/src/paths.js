/**
 * Per-user config directory resolution.
 *
 * The spec (§5, Reviewer note 4) says "the per-user config dir, owner-only" —
 * `~/.config/clenby/bridge-token` is the POSIX/XDG shape; this resolves the
 * right directory per OS. Read as intent, not a literal path.
 */

import os from 'node:os';
import path from 'node:path';

const APP_DIR = 'clenby';
const TOKEN_FILE = 'bridge-token';

/**
 * Resolve the Clenby config directory for the current OS.
 * - Windows: `%APPDATA%\clenby`
 * - macOS:   `~/Library/Application Support/clenby`
 * - else:    `$XDG_CONFIG_HOME/clenby` or `~/.config/clenby`
 * @returns {string}
 */
export function configDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, APP_DIR);
}

/**
 * Absolute path to the pairing-token file inside a config directory.
 * @param {string} [dir] Config directory (defaults to {@link configDir}).
 * @returns {string}
 */
export function tokenPath(dir = configDir()) {
  return path.join(dir, TOKEN_FILE);
}
