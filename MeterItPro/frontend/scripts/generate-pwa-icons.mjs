/**
 * Generates PWA icons for iOS and Android from the MeterIt Pro logo SVG.
 * Run with: node scripts/generate-pwa-icons.mjs
 */
import sharp from 'sharp';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/icons');

mkdirSync(outDir, { recursive: true });

const logoSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f62fe" />
      <stop offset="100%" stop-color="#0050e6" />
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="20" fill="url(#g)" />
  <circle cx="48" cy="52" r="22" fill="#ffffff" opacity="0.15" />
  <circle cx="48" cy="52" r="18" fill="#ffffff" />
  <path d="M48 52 L60 40" stroke="#0f62fe" stroke-width="4" stroke-linecap="round" />
  <circle cx="48" cy="52" r="3.5" fill="#0f62fe" />
  <path d="M34 64 C38 69 44 72 48 72 C52 72 58 69 62 64" stroke="#0f62fe" stroke-width="3" stroke-linecap="round" fill="none" />
</svg>
`;

const icons = [
  { name: 'pwa-192x192.png', size: 192 },
  { name: 'pwa-512x512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

for (const { name, size } of icons) {
  await sharp(Buffer.from(logoSvg))
    .resize(size, size)
    .png({ quality: 95, compressionLevel: 8 })
    .toFile(resolve(outDir, name));
}
