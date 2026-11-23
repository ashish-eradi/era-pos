import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ['**/dist/**', '**/coverage/**', '.npm-cache/**'],
}, {
  files: ['tests/smoke/*.mjs'],
  languageOptions: { globals: globals.node },
});
