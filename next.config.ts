import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Two years. No includeSubDomains: other hosts under the sending domain
          // (the inbound mail provider's, for one) are not this app's to commit.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
        ],
      },
      {
        // Everything except the unsubscribe endpoint (/u/<token>), which sets a
        // stricter policy of its own: default-src 'none' and no-referrer, because
        // its URL carries the token. A header set here would replace the route's.
        source: '/:path((?!u/).*)',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // No script-src: App Router hydration uses inline scripts, and a script
          // policy needs per-request nonces from middleware (a follow-up). These
          // directives break nothing and close framing, <base> hijacking, plugins
          // and cross-origin form posts. Template HTML is previewed in a
          // sandbox="" srcdoc frame, which this does not affect.
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
