/**
 * Flat config, using eslint-config-next's own flat exports directly.
 *
 * Not routed through `FlatCompat`: with eslint 9 + eslint-config-next 16 that
 * shim throws on a circular reference while validating the legacy schema. These
 * entries are already flat configs, so the shim was never needed.
 */

import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'data/**', 'models/**', 'public/**'],
  },
  {
    rules: {
      // Detection tensors, ONNX bindings and JSON columns are legitimately
      // untyped at their boundaries; the typed shape is asserted right after.
      '@typescript-eslint/no-explicit-any': 'off',
      // Media is served from a local content-addressed route, not optimised by
      // next/image — the bytes at a given URL never change.
      '@next/next/no-img-element': 'off',
      // Native addons and the worker entry are required at runtime on purpose;
      // see the comments at each call site.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]

export default eslintConfig
