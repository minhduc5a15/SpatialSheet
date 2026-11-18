export type BrandLogoVariant = 'badge' | 'header' | 'empty';

/**
 * Resolves a static asset path under `public/` using Vite's configured base URL,
 * with safe fallback when imported outside Vite (e.g. Node unit tests).
 */
export function resolvePublicAssetUrl(
  relativePath: string,
  baseUrl?: string
): string {
  const metaEnv = (
    import.meta as unknown as {env?: {BASE_URL?: string}} | undefined
  )?.env;
  const rawBase = baseUrl ?? metaEnv?.BASE_URL ?? '/';
  const normalizedBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const cleanRelative = relativePath.replace(/^\/+/, '');
  return `${normalizedBase}${cleanRelative}`;
}

export function renderBrandLogoHtml(options: {
  variant: BrandLogoVariant;
  sizePx: number;
  alt?: string;
  className?: string;
  decorative?: boolean;
}): string {
  const {variant, sizePx, alt = 'SpatialSheet logo', className = '', decorative = false} =
    options;

  let webpRel = 'branding/spatialsheet-logo-256.webp';
  let pngRel = 'branding/icon-192.png';
  if (variant === 'header') {
    webpRel = 'branding/spatialsheet-logo-96.webp';
    pngRel = 'branding/spatialsheet-logo-96.png';
  } else if (variant === 'badge') {
    webpRel = 'branding/spatialsheet-logo-96.webp';
    pngRel = 'branding/favicon-32x32.png';
  }

  const webpSrc = resolvePublicAssetUrl(webpRel);
  const pngSrc = resolvePublicAssetUrl(pngRel);
  const ariaAttr = decorative ? 'aria-hidden="true"' : '';
  const altAttr = decorative ? '' : alt;

  return `
    <picture class="shrink-0 inline-block ${className}" ${ariaAttr}>
      <source srcset="${webpSrc}" type="image/webp" />
      <img
        src="${pngSrc}"
        alt="${altAttr}"
        width="${sizePx}"
        height="${sizePx}"
        decoding="async"
        class="w-full h-full object-contain block select-none"
      />
    </picture>
  `.trim();
}
