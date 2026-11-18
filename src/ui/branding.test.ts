import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {renderBrandLogoHtml, resolvePublicAssetUrl} from './branding';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

test('resolvePublicAssetUrl respects Vite base paths', () => {
  assert.equal(
    resolvePublicAssetUrl('branding/spatialsheet-logo-96.webp', '/'),
    '/branding/spatialsheet-logo-96.webp'
  );
  assert.equal(
    resolvePublicAssetUrl('/branding/icon-192.png', '/spatialsheet'),
    '/spatialsheet/branding/icon-192.png'
  );
  assert.equal(
    resolvePublicAssetUrl('branding/favicon-32x32.png', '/spatialsheet/'),
    '/spatialsheet/branding/favicon-32x32.png'
  );
});

test('renderBrandLogoHtml renders accessible, CLS-safe markup and existing assets', () => {
  const headerHtml = renderBrandLogoHtml({
    variant: 'header',
    sizePx: 36,
    alt: 'SpatialSheet logo',
  });
  assert.ok(headerHtml.includes('width="36"'));
  assert.ok(headerHtml.includes('height="36"'));
  assert.ok(headerHtml.includes('alt="SpatialSheet logo"'));
  assert.ok(headerHtml.includes('spatialsheet-logo-96.webp'));
  assert.ok(headerHtml.includes('spatialsheet-logo-96.png'));

  const emptyHtml = renderBrandLogoHtml({
    variant: 'empty',
    sizePx: 48,
    decorative: true,
  });
  assert.ok(emptyHtml.includes('aria-hidden="true"'));
  assert.ok(emptyHtml.includes('alt=""'));
  assert.ok(emptyHtml.includes('spatialsheet-logo-256.webp'));
  assert.ok(emptyHtml.includes('icon-192.png'));

  const expectedFiles = [
    'favicon.ico',
    'manifest.webmanifest',
    'branding/spatialsheet-logo-master.png',
    'branding/spatialsheet-logo.webp',
    'branding/spatialsheet-logo-256.webp',
    'branding/spatialsheet-logo-96.webp',
    'branding/spatialsheet-logo-96.png',
    'branding/icon-192.png',
    'branding/icon-512.png',
    'branding/apple-touch-icon.png',
    'branding/favicon-32x32.png',
    'branding/favicon-16x16.png',
  ];
  for (const rel of expectedFiles) {
    const abs = path.join(PUBLIC_DIR, rel);
    assert.ok(fs.existsSync(abs), `Expected brand asset to exist: ${rel}`);
    assert.ok(fs.statSync(abs).size > 0, `Expected non-empty asset: ${rel}`);
  }
});
