/**
 * eslint 的规则集。
 *
 * 基线用 @eslint/js 的 recommended：它抓的是真缺陷（未定义变量、不可达代码、重复的
 * case、丢掉 return 的 getter、异步 Promise 执行器）。风格类的东西（缩进、分号、引号）
 * 交给 prettier 与编辑器，两边不重叠。
 *
 * 只调两处：
 * 1. `no-unused-vars` 不检查函数参数。这里的假宿主与假服务刻意照真机签名写，参数用不上
 *    是常态（例如 `describe(ref)`），报出来只会逼人把签名改歪。
 * 2. 浏览器全局只给 client.js：宿主侧代码里出现 `window` 是真错误，不该被放过。
 */
import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['.agents/**', 'docs/**', 'sessions/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 浏览器半边：client.js 是 lazy-CJS bundle，工厂里拿 require，只跑在页面里。
    files: ['client.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.node, ...globals.browser },
    },
  },
]
