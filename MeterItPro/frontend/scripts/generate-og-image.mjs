/**
 * Generates public/og-image.png (1200x630) for social media link previews.
 * Run with: node scripts/generate-og-image.mjs
 */
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public');

mkdirSync(outDir, { recursive: true });

// Build the OG image as SVG at 1200x630
const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a1628" />
      <stop offset="100%" stop-color="#0d2040" />
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f62fe" />
      <stop offset="100%" stop-color="#0050e6" />
    </linearGradient>
    <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f62fe" />
      <stop offset="100%" stop-color="#0050e6" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)" />

  <!-- Subtle grid lines -->
  <line x1="0" y1="210" x2="1200" y2="210" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1" />
  <line x1="0" y1="420" x2="1200" y2="420" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1" />
  <line x1="400" y1="0" x2="400" y2="630" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1" />
  <line x1="800" y1="0" x2="800" y2="630" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1" />

  <!-- Blue accent bar left -->
  <rect x="0" y="0" width="6" height="630" fill="url(#accent)" />

  <!-- Logo icon -->
  <rect x="72" y="72" width="88" height="88" rx="20" fill="url(#logoGrad)" />
  <circle cx="116" cy="124" r="22" fill="#ffffff" opacity="0.15" />
  <circle cx="116" cy="124" r="18" fill="#ffffff" />
  <path d="M116 124 L128 112" stroke="#0f62fe" stroke-width="4" stroke-linecap="round" />
  <circle cx="116" cy="124" r="3.5" fill="#0f62fe" />
  <path d="M102 136 C106 141 112 144 116 144 C120 144 126 141 130 136" stroke="#0f62fe" stroke-width="3" stroke-linecap="round" fill="none" />

  <!-- Brand name -->
  <text x="176" y="108" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#ffffff" letter-spacing="0">MeterIt Pro</text>
  <text x="176" y="140" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#0f62fe" letter-spacing="1">METER MANAGEMENT SOFTWARE</text>

  <!-- Main headline -->
  <text x="72" y="260" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" fill="#ffffff">Meter Management</text>
  <text x="72" y="330" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" fill="#ffffff">Software</text>

  <!-- Sub-headline -->
  <text x="72" y="400" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#94a3b8">For manufacturers, sellers, BMS operators &amp; utilities.</text>

  <!-- Feature pills -->
  <rect x="72" y="450" width="220" height="44" rx="22" fill="#0f62fe" fill-opacity="0.2" stroke="#0f62fe" stroke-width="1.5" />
  <text x="182" y="478" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#60a5fa" text-anchor="middle">Meter Readings</text>

  <rect x="308" y="450" width="210" height="44" rx="22" fill="#0f62fe" fill-opacity="0.2" stroke="#0f62fe" stroke-width="1.5" />
  <text x="413" y="478" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#60a5fa" text-anchor="middle">BMS Integration</text>

  <rect x="534" y="450" width="200" height="44" rx="22" fill="#0f62fe" fill-opacity="0.2" stroke="#0f62fe" stroke-width="1.5" />
  <text x="634" y="478" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#60a5fa" text-anchor="middle">Analytics &amp; Reports</text>

  <rect x="750" y="450" width="180" height="44" rx="22" fill="#0f62fe" fill-opacity="0.2" stroke="#0f62fe" stroke-width="1.5" />
  <text x="840" y="478" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#60a5fa" text-anchor="middle">Multi-Site</text>

  <!-- Domain -->
  <text x="1128" y="590" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#475569" text-anchor="end">meteritpro.com</text>

  <!-- Right side decorative meter graphic -->
  <circle cx="1050" cy="280" r="160" fill="#0f62fe" fill-opacity="0.06" stroke="#0f62fe" stroke-opacity="0.15" stroke-width="1.5" />
  <circle cx="1050" cy="280" r="120" fill="#0f62fe" fill-opacity="0.06" stroke="#0f62fe" stroke-opacity="0.2" stroke-width="1.5" />
  <circle cx="1050" cy="280" r="80" fill="#ffffff" fill-opacity="0.05" stroke="#0f62fe" stroke-opacity="0.3" stroke-width="2" />
  <!-- Meter needle -->
  <path d="M1050 280 L1115 215" stroke="#0f62fe" stroke-width="5" stroke-linecap="round" />
  <circle cx="1050" cy="280" r="10" fill="#0f62fe" />
  <!-- Meter arc -->
  <path d="M940 330 C950 230 1050 170 1140 220" stroke="#0f62fe" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.6" />
  <!-- Tick marks -->
  <line x1="900" y1="280" x2="916" y2="280" stroke="#0f62fe" stroke-width="2.5" opacity="0.5" />
  <line x1="1050" y1="120" x2="1050" y2="136" stroke="#0f62fe" stroke-width="2.5" opacity="0.5" />
  <line x1="1200" y1="280" x2="1184" y2="280" stroke="#0f62fe" stroke-width="2.5" opacity="0.5" />
</svg>
`;

await sharp(Buffer.from(svgContent))
  .resize(1200, 630)
  .png({ quality: 95, compressionLevel: 8 })
  .toFile(resolve(outDir, 'og-image.png'));

