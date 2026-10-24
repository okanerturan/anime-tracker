// Bundle the Worker. server/db.js, server/images.js, server/upstream.js and the hosted-only switches are swapped for their Cloudflare versions.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWAP = {
  [path.join(root, 'server/db.js')]: path.join(root, 'worker/db.js'),
  [path.join(root, 'server/images.js')]: path.join(root, 'worker/images.js'),
  [path.join(root, 'server/upstream.js')]: path.join(root, 'worker/upstream.js'),
  [path.join(root, 'server/accounts/switches.js')]: path.join(root, 'worker/switches.js')
};

const swapPlugin = {
  name: 'swap-node-modules',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      const target = path.resolve(args.resolveDir, args.path.endsWith('.js') ? args.path : `${args.path}.js`);
      if (SWAP[target]) return { path: SWAP[target] };
      return undefined;
    });
  }
};

await build({
  entryPoints: [path.join(root, 'worker/entry.mjs')],
  outfile: path.join(root, 'dist/worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  external: ['cloudflare:workers', 'node:*'],
  plugins: [swapPlugin],
  logLevel: 'warning'
});
console.log('built dist/worker.js');
