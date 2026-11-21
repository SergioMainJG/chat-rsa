// Security headers every HTTP response carries: each place that builds a Response spreads them in. The pages keep their full CSP in a <meta> (see
// CLAUDE.md); `frame-ancestors` only works from a header, so the header CSP adds just that.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  // Browsers honour it only over HTTPS (behind the tunnel); no includeSubDomains, so other hosts
  // of the same domain are not forced onto HTTPS.
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
