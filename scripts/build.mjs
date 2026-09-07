import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/web', { recursive: true });
await build({ entryPoints: ['src/admin-entry.ts'], outfile: 'dist/web/admin.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await Promise.all(['admin.html', 'admin.css'].map(name => copyFile(`src/${name}`, `dist/web/${name}`)));
