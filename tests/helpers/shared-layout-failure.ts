import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, dirname} from 'node:path';

// Preloaded only by the shared-layout acceptance child. Cause a real mkdir
// failure in the actual command suite, after allocation/teardown registration.
const mkdirSync = fs.mkdirSync;
fs.mkdirSync = ((path, options) => {
  if (
    typeof path === 'string' &&
    basename(path) === 'docs' &&
    basename(dirname(path)).startsWith('command-guard-test-') &&
    dirname(dirname(path)) === tmpdir()
  ) {
    fs.writeFileSync(path, 'synthetic obstruction');
    console.error('INJECTED shared layout setup failure');
  }
  return mkdirSync(path, options);
}) as typeof fs.mkdirSync;
syncBuiltinESMExports();
