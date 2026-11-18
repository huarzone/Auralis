/** Bundle local CommonJS modules once, then wrap them in DSH's shared-module factory without third-party tools. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = resolve(root, 'src');
const wallpaper = `data:image/webp;base64,${(await readFile(resolve(root, 'assets/wallpaper.webp'))).toString('base64')}`;
const modules = new Map();
const visiting = new Set();

async function bundle(file) {
  if (modules.has(file)) return;
  if (visiting.has(file)) throw new Error(`Circular browser module: ${file}`);
  visiting.add(file);
  let source = await readFile(resolve(src, file), 'utf8');
  if (file === 'client.cjs') {
    if (!source.includes('@auralis-wallpaper:start')) throw new Error('Wallpaper marker missing.');
    source = source.replace(/\/\/ @auralis-wallpaper:start[\s\S]*?\/\/ @auralis-wallpaper:end/, () => `const wallpaper = ${JSON.stringify(wallpaper)};`);
  }
  const imports = [...source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)];
  for (const [, dependency] of imports) {
    if (dirname(resolve(src, dependency)) !== src || !dependency.endsWith('.cjs')) throw new Error(`Unexpected browser dependency: ${dependency}`);
    await bundle(dependency);
  }
  source = source.replace(/require\(['"]\.\/([^'"]+)['"]\)/g, (_, dependency) => `__auralisLocal[${JSON.stringify(dependency)}]`);
  if (/require\(['"]\./.test(source) || source.includes('@auralis-wallpaper')) throw new Error(`Unbundled local reference: ${file}`);
  modules.set(file, source);
  visiting.delete(file);
}

await bundle('client.cjs');
const bundled = [...modules].map(([file, source]) => `__auralisLocal[${JSON.stringify(file)}] = (() => {\nconst module = { exports: {} };\n${source}\nreturn module.exports;\n})();`).join('\n');
const output = `window.__ModuleLoader__.load({\n  id: 'auralis',\n  factory: (require) => {\n    const __auralisLocal = Object.create(null);\n${bundled}\n    const client = __auralisLocal['client.cjs'];\n    return { inject: client.inject, apply: client.apply };\n  },\n});\n`;
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), output);
console.log(`Built dist/client.js with ${modules.size} local modules and no third-party build dependencies.`);
