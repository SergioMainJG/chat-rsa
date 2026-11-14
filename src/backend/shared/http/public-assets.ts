// Icons and the web manifest from public/, served at the root where browsers and the manifest
// look for them. Only these files are published: public/ also holds design sources (the mockup,
// the full-size logo) that must not be served.

const PUBLIC_DIR = new URL('../../../../public/', import.meta.url);
const ONE_DAY_SECONDS = 86_400;

/** Published path → content type (null lets Bun infer it from the extension). */
const PUBLIC_FILES: Readonly<Record<string, null | string>> = {
  'android-chrome-192x192.png': null,
  'android-chrome-512x512.png': null,
  'apple-touch-icon.png': null,
  'favicon-16x16.png': null,
  'favicon-32x32.png': null,
  'favicon.ico': 'image/x-icon',
  'favicon.svg': 'image/svg+xml',
  'site.webmanifest': 'application/manifest+json',
};

export function publicAssetRoutes(): Record<string, () => Response> {
  return Object.fromEntries(
    Object.entries(PUBLIC_FILES).map(([name, type]) => {
      const file = Bun.file(new URL(name, PUBLIC_DIR));
      const headers: Record<string, string> = {
        'Cache-Control': `public, max-age=${ONE_DAY_SECONDS}`,
        ...(type === null ? {} : { 'Content-Type': type }),
      };
      return [`/${name}`, () => new Response(file, { headers })];
    }),
  );
}
