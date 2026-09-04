import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The real package throws when imported outside an RSC graph. Stubbing it
      // here does not weaken the guarantee: `server-only` is enforced by the
      // Next build, and tests/source-security.test.ts asserts every secret-
      // handling module still imports it.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
