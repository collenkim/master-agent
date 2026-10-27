const readonly = names => Object.fromEntries(names.split(' ').map(name => [name, 'readonly']));
const shared = readonly('console setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask fetch URL URLSearchParams AbortController AbortSignal structuredClone TextEncoder TextDecoder performance btoa atob crypto Event EventTarget');
const node = readonly('process Buffer global');
const browser = readonly('window document navigator location history sessionStorage localStorage CustomEvent FormData HTMLElement HTMLInputElement HTMLSelectElement HTMLTextAreaElement WebSocket EventSource requestAnimationFrame cancelAnimationFrame alert confirm');
export default [
  {
    files: ['apps/**/*.mjs', 'packages/**/*.mjs', 'packages/**/*.cjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 'latest', globals: { ...shared, ...node } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  { files: ['apps/dashboard/*.mjs', 'scripts/*.mjs'], languageOptions: { globals: browser } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
