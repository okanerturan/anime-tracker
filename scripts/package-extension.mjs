#!/usr/bin/env node
// Zip extension/ for the Chrome Web Store: releases/tsuzuku-extension-v<version>.zip.
// With a tag argument (ext-v1.2.3, as the release workflow passes), the manifest must match it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new Error(`manifest version "${version}" is not a Chrome version`);
const tag = process.argv[2];
if (tag && tag.replace(/^ext-v/, '') !== version) throw new Error(`tag ${tag} does not match manifest version ${version}`);
for (const f of ['background.js', 'popup.html', 'icons/icon-128.png']) if (!existsSync(join(ext, f))) throw new Error(`extension/${f} is missing`);

mkdirSync(join(root, 'releases'), { recursive: true });
const out = join(root, 'releases', `tsuzuku-extension-v${version}.zip`);
rmSync(out, { force: true });
// -X: no extra file attributes; -r from inside extension/ so manifest.json sits at the zip's root.
execFileSync('zip', ['-X', '-q', '-r', out, '.', '-x', '.*', '*/.*'], { cwd: ext });
console.log(`${out} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
