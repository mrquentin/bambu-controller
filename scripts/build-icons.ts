/**
 * Render the app icon (assets/icon.svg) and the monochrome notification badge
 * (assets/badge.svg) into the files the web app serves.
 *
 *   npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8');
const out = path.join(root, 'web/public');

fs.copyFileSync(path.join(root, 'assets/icon.svg'), path.join(out, 'favicon.svg'));

const sizes: Record<string, number> = {
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
};

for (const [file, size] of Object.entries(sizes)) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(out, file), png);
  console.log(`${file} (${size}px)`);
}

const badge = fs.readFileSync(path.join(root, 'assets/badge.svg'), 'utf8');
fs.writeFileSync(path.join(out, 'badge-96.png'), new Resvg(badge, { fitTo: { mode: 'width', value: 96 } }).render().asPng());
console.log('badge-96.png (96px)');
