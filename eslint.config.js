const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['src/vendor/**', 'node_modules/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker, importScripts: 'readonly' },
    },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  { rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] } },
];
