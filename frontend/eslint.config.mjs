// ESLint flat config — 让 package.json 里形同虚设的 `pnpm lint` 真正生效。
// 原则: 只开能抓真问题的规则 (unused/hook 依赖/明显错误),
// 不开风格类规则 (交给 tsconfig + review), no-explicit-any 暂关 (存量 240 处, 渐进清理)。
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'vite.config.js', 'vite.config.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoizations': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,   // const { del, ...rest } = obj 的解构剔除惯用法
      }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // hook 依赖先作为 warning 存量治理 (15 处 disable 已逐条处理), 不阻塞构建
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
