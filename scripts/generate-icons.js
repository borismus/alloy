#!/usr/bin/env node
/**
 * Generate PWA icons from SVG source
 * Run: node scripts/generate-icons.js
 */

import sharp from 'sharp';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const svgPath = join(publicDir, 'icon.svg');

// Icon sizes needed for PWA/iOS
const sizes = [
  { size: 180, name: 'apple-touch-icon.png' },      // iOS home screen
  { size: 152, name: 'apple-touch-icon-152x152.png' }, // iPad
  { size: 167, name: 'apple-touch-icon-167x167.png' }, // iPad Pro
  { size: 192, name: 'icon-192.png' },              // Android/PWA
  { size: 512, name: 'icon-512.png' },              // PWA splash
  { size: 32, name: 'favicon-32x32.png' },          // Favicon
  { size: 16, name: 'favicon-16x16.png' },          // Favicon small
];

async function generateIcons() {
  console.log('Generating PWA icons...');

  if (!existsSync(svgPath)) {
    console.error('Error: icon.svg not found in public/');
    process.exit(1);
  }

  const svgBuffer = readFileSync(svgPath);

  for (const { size, name } of sizes) {
    const outputPath = join(publicDir, name);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`  ✓ ${name} (${size}x${size})`);
  }

  console.log('\nDone! Icons generated in public/');
}

generateIcons().catch(console.error);
