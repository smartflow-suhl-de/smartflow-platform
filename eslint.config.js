import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'data/**',
      // The site template is its own Astro package, copied into the build; the
      // root lint config does not apply to it.
      'templates/**',
      'api/src/kernel/plugin-registry.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['eslint.config.js', 'api/**/*.ts', 'api/**/*.mjs', '.github/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler lint rules. The SPA is built by Vite without the React
      // Compiler, and the inherited components use the established patterns
      // (reset state when a prop changes, a latest-value ref). Surfacing them
      // as warnings keeps the signal without rewriting working UI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    rules: {
      // The kernel and plugins deal with validated external payloads, so `any`
      // shows up where a schema already guards the shape. Keep it visible as a
      // warning instead of rewriting working code for a cosmetic rule.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
