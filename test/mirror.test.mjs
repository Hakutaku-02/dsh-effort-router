/**
 * 部署镜像的行为：把依赖里的 laya 包复制到稳定目录，版本没变就不重复复制。
 * 全程在临时目录里做，不碰真的 ~/.dsh。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'router-effort-home-'))
process.env.ROUTER_EFFORT_HOME = home
process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
const { mirrorLaya } = await import('../index.js')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

/** 造一个最小可用的来源包。 */
function sourcePackage(version) {
  const dir = mkdtempSync(join(tmpdir(), 'laya-src-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-router-laya', version }))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'setup.mjs'), '// stub\n')
  return dir
}

const source = sourcePackage('1.0.0')
const first = mirrorLaya(source)
check('镜像目录在部署根下', first, join(home, 'laya'))
check('镜像里有 setup 脚本', existsSync(join(first, 'bin', 'setup.mjs')), true)

// 复制完成后往镜像里写个标记；同版本再调一次不该把标记冲掉
const marker = join(first, 'keep.txt')
writeFileSync(marker, 'stale')
// 镜像里的 package.json 被别的东西碰过（mtime 变了），但版本号没变：不该重新复制
utimesSync(join(home, 'laya', 'package.json'), new Date(), new Date())
writeFileSync(join(source, 'keep.txt'), 'fresh')
const second = mirrorLaya(source)
check('同版本不重复制', readFileSync(join(second, 'keep.txt'), 'utf8'), 'stale')

// 版本变了要重新复制
writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-router-laya', version: '1.1.0' }))
const third = mirrorLaya(source)
check('换版本会重复制', readFileSync(join(third, 'keep.txt'), 'utf8'), 'fresh')
check('重复制后版本更新', JSON.parse(readFileSync(join(third, 'package.json'), 'utf8')).version, '1.1.0')

rmSync(home, { recursive: true, force: true })
rmSync(source, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
