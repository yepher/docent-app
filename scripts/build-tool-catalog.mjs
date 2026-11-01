// Node 22.13+: run with --experimental-strip-types. This publishes files locally only.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { BUNDLED_TOOLS } from '../src/main/tools/bundled.ts';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'tool-packages'), { recursive: true });
const catalog = { format: 'docent-tool-collection', formatVersion: 1, name: 'Docent starter tools', tools: [] };
for (const pkg of BUNDLED_TOOLS) {
  const file = `tool-packages/${pkg.manifest.id}.docent-tool.json`;
  const content = JSON.stringify(pkg, null, 2) + '\n';
  await writeFile(resolve(root, file), content);
  catalog.tools.push({ id: pkg.manifest.id, name: pkg.manifest.name, description: pkg.manifest.description,
    version: pkg.manifest.version, file, sha256: createHash('sha256').update(content).digest('hex') });
}
await writeFile(resolve(root, 'docent-tools.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Prepared ${catalog.tools.length} shareable tool packages and docent-tools.json. No files were uploaded.`);
