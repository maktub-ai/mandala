import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export function productEnv(name, env = process.env) {
  return env[`MANDALA_${name}`] ?? env[`OPEN_MANA_${name}`];
}

// Select one identity. The explicit offline migration leaves a legacy directory alias.
export function productHome(kind = 'workspace', env = process.env, root = homedir()) {
  const suffix = kind === 'workspace' ? '' : kind === 'control' ? '-account-service' : '-releases';
  const explicit = kind === 'releases' ? undefined : productEnv(kind === 'control' ? 'CONTROL_HOME' : 'HOME', env);
  const selected = explicit === undefined ? join(root, `.mandala${suffix}`) : resolve(explicit);
  for(let path=selected;dirname(path)!==path;path=dirname(path)) {
    const match=/^\.(?:mandala|open-mana)(-account-service|-releases)?$/.exec(basename(path));
    if(match && existsSync(join(dirname(path), `.mandala${match[1]??''}.migrating`))) throw new Error('product_home_migration_in_progress');
  }
  if (explicit !== undefined) return explicit;
  const legacy = join(root, `.open-mana${suffix}`);
  if (existsSync(selected)) {
    let legacyExists=false;
    try { lstatSync(legacy); legacyExists=true; } catch (error) { if(error.code!=='ENOENT')throw error; }
    if (legacyExists && (!existsSync(legacy) || realpathSync(legacy)!==realpathSync(selected))) throw new Error('conflicting_product_homes: set MANDALA_HOME explicitly or migrate the legacy directory');
    return selected;
  }
  return existsSync(legacy) ? legacy : join(root, `.mandala${suffix}`);
}
