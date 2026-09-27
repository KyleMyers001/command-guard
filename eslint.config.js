import {createRequire} from 'node:module';
import globals from 'globals';

const require = createRequire(import.meta.url);
const googleStyle = require('gts');

export default [
  {ignores: ['.codegraph/**', 'coverage/**', 'dist/**']},
  {languageOptions: {globals: globals.node}},
  ...googleStyle,
  {files: ['eslint.config.js'], languageOptions: {sourceType: 'module'}},
  {
    files: ['tests/**/*.test.ts'],
    // node:test owns the promises returned by test registration.
    rules: {'@typescript-eslint/no-floating-promises': 'off'},
  },
  {
    files: [
      'extensions/command-guard/policy.ts',
      'tests/command-guard.test.ts',
    ],
    rules: {'no-control-regex': 'off'},
  },
];
