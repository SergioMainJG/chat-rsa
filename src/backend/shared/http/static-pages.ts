// Production pages: the HTML imports are bundled once at startup with Bun.build and served as
// plain routes, because Bun's own HTML-import routes hard-code their headers. Served this way
// every page and asset carries the security headers, text is precompressed (brotli and gzip),
// hashed assets are cached forever and pages are revalidated by ETag. Development keeps the
// HTML imports for hot reload.
import { brotliCompressSync, constants } from 'node:zlib';

import {
  type Locale,
  localePath,
  LOCALES,
  type Page,
  PAGE_PATHS,
  PAGES,
} from '../../../shared/i18n/i18n.locale.ts';
import { SECURITY_HEADERS } from './security-headers.ts';

type Encoding = 'br' | 'gzip' | 'identity';

type PageRoute = (request: Request) => Response;

type Variant = { readonly body: Uint8Array<ArrayBuffer>; readonly encoding: Encoding };

const FRONTEND = new URL('../../../frontend/', import.meta.url);

/** Each page's source per locale, relative to src/frontend. */
const SOURCES: Readonly<Record<Page, string>> = {
  chat: 'messaging/chat',
  home: 'index',
  'sign-in': 'auth/sign-in',
  'sign-up': 'auth/sign-up',
};

/** Locale route (`/es/chat`) → page source (`messaging/chat.es.html`), relative to src/frontend. */
export const PAGE_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  LOCALES.flatMap((locale) =>
    PAGES.map((page) => [localePath(locale, page), `${SOURCES[page]}.${locale}.html`]),
  ),
);

const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/u;
/** Below this size compression saves less than its headers cost. */
const MIN_COMPRESS_BYTES = 1024;

/**
 * The encoding to answer with: brotli, then gzip, when `Accept-Encoding` allows it (a `q=0` refuses
 * one), identity otherwise.
 */
export function negotiateEncoding(acceptEncoding: null | string): Encoding {
  const accepted = new Set<string>();
  for (const part of (acceptEncoding ?? '').split(',')) {
    const [rawName = '', ...params] = part.toLowerCase().split(';');
    const name = rawName.trim();
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    if (name !== '' && (q === undefined || Number(q.slice(2)) > 0)) {
      accepted.add(name);
    }
  }
  if (accepted.has('br')) {
    return 'br';
  }
  return accepted.has('gzip') ? 'gzip' : 'identity';
}

function route(bytes: Uint8Array<ArrayBuffer>, type: string, cacheControl: string): PageRoute {
  const variants = variantsOf(bytes, type);
  const etag = `"${Bun.hash(bytes).toString(16)}"`;
  const compressed = variants.length > 1;
  return (request) => {
    const headers = new Headers({
      ...SECURITY_HEADERS,
      'Cache-Control': cacheControl,
      'Content-Type': type,
      ETag: etag,
      ...(compressed ? { Vary: 'Accept-Encoding' } : {}),
    });
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { headers, status: 304 });
    }
    const wanted = negotiateEncoding(request.headers.get('accept-encoding'));
    const variant =
      variants.find((candidate) => candidate.encoding === wanted) ??
      variants.find((candidate) => candidate.encoding === 'identity');
    if (variant === undefined) {
      throw new Error('A page route always has an identity variant');
    }
    if (variant.encoding !== 'identity') {
      headers.set('Content-Encoding', variant.encoding);
    }
    return new Response(variant.body, { headers });
  };
}

function variantsOf(bytes: Uint8Array<ArrayBuffer>, type: string): Variant[] {
  const identity: Variant = { body: bytes, encoding: 'identity' };
  if (!COMPRESSIBLE.test(type) || bytes.byteLength < MIN_COMPRESS_BYTES) {
    return [identity];
  }
  return [
    {
      body: new Uint8Array(
        brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
      ),
      encoding: 'br',
    },
    { body: Bun.gzipSync(bytes, { level: 9 }), encoding: 'gzip' },
    identity,
  ];
}

/**
 * The search-engine links of a page: its canonical URL and one alternate per locale, plus
 * `x-default` (the unprefixed path, which redirects by language). URLs are absolute, as search
 * engines require. The chat is `noindex` and gets none.
 */
export function seoLinks(publicOrigin: string, locale: Locale, page: Page): string {
  if (page === 'chat') {
    return '';
  }
  const origin = publicOrigin.replace(/\/+$/u, '');
  const unprefixed = PAGE_PATHS[page] === '' ? '/' : PAGE_PATHS[page];
  return [
    `<link rel="canonical" href="${origin}${localePath(locale, page)}">`,
    ...LOCALES.map(
      (other) =>
        `<link rel="alternate" hreflang="${other}" href="${origin}${localePath(other, page)}">`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${origin}${unprefixed}">`,
  ].join('');
}

/**
 * Drops the `<script>` of an empty entry chunk (Bun emits one for every page, even a page without a
 * script of its own, and the browser would still request it) and appends `headLinks` to the
 * `<head>`.
 */
async function finishPage(
  html: string,
  emptyScripts: ReadonlySet<string>,
  headLinks: string,
): Promise<string> {
  const rewritten = new HTMLRewriter()
    .on('script[src]', {
      element: (element) => {
        if (emptyScripts.has(element.getAttribute('src') ?? '')) {
          element.remove();
        }
      },
    })
    .on('head', {
      element: (element) => {
        element.append(headLinks, { html: true });
      },
    })
    .transform(new Response(html));
  return rewritten.text();
}

/** Bun.build output paths (`./chat-1a2b.js`, `./auth/sign-in.html`) as served paths. */
function publicPath(path: string): string {
  return `/${path.replace(/^\.\//u, '')}`;
}

/**
 * Bundles the pages (minified) and returns one route per page and per asset. `publicOrigin`
 * (`https://chat.example.com`) makes the canonical and hreflang URLs absolute.
 */
export async function buildPages(publicOrigin: string): Promise<Record<string, PageRoute>> {
  const root = Bun.fileURLToPath(FRONTEND);
  const result = await Bun.build({
    entrypoints: [...new Set(Object.values(PAGE_SOURCES))].map((source) => `${root}${source}`),
    minify: true,
    naming: {
      asset: '[name]-[hash].[ext]',
      chunk: '[name]-[hash].[ext]',
      entry: '[dir]/[name].[ext]',
    },
    publicPath: '/',
    root,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'The pages failed to bundle');
  }
  const emptyScripts = new Set(
    result.outputs
      .filter((output) => output.path.endsWith('.js') && output.size === 0)
      .map((output) => publicPath(output.path)),
  );
  // Asset and chunk names carry a content hash, so they never change under the same path.
  const assets = result.outputs.filter(
    (output) => !output.path.endsWith('.html') && !emptyScripts.has(publicPath(output.path)),
  );
  const assetRoutes = await Promise.all(
    assets.map(async (output) => {
      const bytes = new Uint8Array(await output.arrayBuffer());
      return [
        publicPath(output.path),
        route(bytes, output.type, 'public, max-age=31536000, immutable'),
      ] as const;
    }),
  );
  const pageRoutes = await Promise.all(
    LOCALES.flatMap((locale) =>
      PAGES.map(async (page) => {
        const path = localePath(locale, page);
        const source = PAGE_SOURCES[path] ?? '';
        const output = result.outputs.find(
          (candidate) => publicPath(candidate.path) === `/${source}`,
        );
        if (output === undefined) {
          throw new Error(`The bundle has no output for ${source}`);
        }
        const html = await finishPage(
          await output.text(),
          emptyScripts,
          seoLinks(publicOrigin, locale, page),
        );
        return [path, route(new TextEncoder().encode(html), output.type, 'no-cache')] as const;
      }),
    ),
  );
  const routes: Record<string, PageRoute> = Object.fromEntries([...assetRoutes, ...pageRoutes]);
  return routes;
}
