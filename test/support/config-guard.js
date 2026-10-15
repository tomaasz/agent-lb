// Pure helpers behind the test preload. Kept free of side effects so a test can
// import them without changing the environment it is trying to observe.

import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** True when `path` lies inside a real config directory: $HOME/.config, the passwd home's .config or $XDG_CONFIG_HOME. */
export function isUnderRealConfigDir(path) {
  const target = resolve(path);
  const dirs = [join(homedir(), '.config'), join(userInfo().homedir, '.config')];
  if (process.env.XDG_CONFIG_HOME) dirs.push(resolve(process.env.XDG_CONFIG_HOME));
  return dirs.some(dir => target === dir || target.startsWith(dir + sep));
}

/** Throw unless every given agent-lb path stays outside the real config directory. */
export function assertIsolatedConfig(paths) {
  for (const [name, path] of Object.entries(paths)) {
    if (isUnderRealConfigDir(path)) {
      throw new Error(`Refusing to run tests: ${name} (${path}) is inside the real config directory. ` +
        'Run them with `npm test`, or point AGENT_LB_CONFIG at a temp dir.');
    }
  }
}
