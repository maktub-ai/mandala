import { resolve } from 'node:path';
import { previewBlueprintMigration } from '../server/blueprint-migration';

const usage = 'Usage: node --import tsx scripts/preview-blueprint-migration.ts PROFILE_HOME';
if (process.argv.length !== 3) {
  console.error(usage);
  process.exitCode = 1;
} else if (process.argv[2] === '--help') {
  console.log(usage);
} else {
  console.log(JSON.stringify(await previewBlueprintMigration(resolve(process.argv[2])), null, 2));
}
