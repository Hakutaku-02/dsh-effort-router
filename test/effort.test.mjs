import { pickEffort, strengthOf } from '../index.js'

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${String(actual)}${ok ? '' : ` (期望 ${String(expected)})`}`)
}

// 各厂商真实词汇
const deepseek = ['low', 'high', 'max']
const minimax = ['low', 'medium', 'high', 'xhigh', 'max']
const qwen = ['low', 'medium', 'xhigh']
const noReasoning = []

check('deepseek 目标 low', pickEffort(deepseek, 'low'), 'low')
check('deepseek 目标 high', pickEffort(deepseek, 'high'), 'high')
check('deepseek 目标 max', pickEffort(deepseek, 'max'), 'max')
check('minimax 目标 low', pickEffort(minimax, 'low'), 'low')
check('minimax 目标 high', pickEffort(minimax, 'high'), 'high')
check('minimax 目标 max', pickEffort(minimax, 'max'), 'max')
check('qwen 目标 high（无 high，退到 medium）', pickEffort(qwen, 'high'), 'medium')
check('qwen 目标 max（无 max，退到 xhigh）', pickEffort(qwen, 'max'), 'xhigh')
check('只有强档（目标 low，给最弱）', pickEffort(['high', 'max'], 'low'), 'high')
check('没有可用档', pickEffort(noReasoning, 'max'), undefined)
check('全是未知档', pickEffort(['ultra', 'turbo'], 'max'), undefined)
check('目标档未知', pickEffort(deepseek, 'insane'), undefined)
check('缺省 available', pickEffort(undefined, 'low'), undefined)
check('强度序 off < low < max', strengthOf('off') < strengthOf('low') && strengthOf('low') < strengthOf('max'), true)
check('未知强度', strengthOf('turbo'), undefined)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
