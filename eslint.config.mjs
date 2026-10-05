import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'max-len': [
        'error',
        {
          code: 100,
          ignoreComments: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreUrls: true,
        },
      ],
      'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'function', next: '*' },
      ],
    },
  },
  ...['wallet', 'broadcast', 'signer', 'activity-listener', 'ledger', 'user', 'sweep'].map(
    (application) => ({
      files: [`apps/${application}/src/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              'wallet',
              'broadcast',
              'signer',
              'activity-listener',
              'ledger',
              'user',
              'sweep',
            ]
              .filter((other) => other !== application)
              .map((other) => ({
                group: [`**/${other}/src/**`],
                message:
                  'Applications communicate through queue contracts; do not import another application.',
              })),
          },
        ],
      },
    }),
  ),
  {
    files: ['apps/*/src/**/*.ts'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read environment variables in configuration factories and inject validated settings.',
        },
      ],
    },
  },
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/**'],
              message: 'Shared packages cannot depend on application internals.',
            },
          ],
        },
      ],
    },
  },
);
