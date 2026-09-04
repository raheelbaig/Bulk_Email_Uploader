import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // process.env access must go through the validated accessors in lib/env.ts
      // so that a missing variable fails loudly at startup rather than becoming
      // `undefined` deep inside a request.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@supabase/supabase-js'],
              importNames: ['createClient'],
              message:
                'Use lib/supabase/server.ts (RLS-scoped) or lib/db/service.ts (service role, workspace-scoped). Creating a client directly bypasses both.',
            },
          ],
        },
      ],
    },
  },
  {
    // lib/db/service.ts is the one sanctioned home for the service-role client.
    files: ['src/lib/db/service.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.*', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];

export default config;
