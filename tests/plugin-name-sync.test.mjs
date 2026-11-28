import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { PLUGIN_PREFIX, PM_ROLE } from '../hooks/lib/decide.mjs'

test('PLUGIN_PREFIX 与 plugin.json 的 name 保持一致', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  )
  assert.equal(
    PLUGIN_PREFIX,
    `${manifest.name}:`,
    '插件改名后 PLUGIN_PREFIX 没跟着改：前缀归一化会失效，' +
      '门禁将回退到「一律拒绝」，而其余测试仍然全绿',
  )
})

// 默认接管去掉了（设计 §5.1）：插件根的 settings.json 写 agent 键，启用了插件的目录里每个新会话都被钉成项目经理，
// 用户只想在项目里装着插件、平时照常用 Claude Code 也不行。现在项目经理靠用户敲团队命令成为（门禁按会话的记号认），
// 所以插件根不能再有 settings.json——有人把 agent 键加回来，每个新会话又都成了项目经理，而别的判据照样全绿。
// agents/at-pm.md 留着：带 --agent 起的会话照旧是项目经理，升级之前开着的会话也靠它不被改判。
// M4o（docs/50）：原话记录器只认本插件的 at——hooks.json 的 matcher、checks.mjs 声明的 matcher、门禁认的命令名都从插件名来。插件改名时
// 三处没跟上，记录器就再也不触发，契约第 1 节一声不响地不再核。
test('M4o 原话记录器认的命令是 PLUGIN_PREFIX + at 与 at-tweak：hooks.json 与 checks.mjs 的 matcher、user-words.mjs 的 AT_COMMAND、tweak.mjs 的 TWEAK_COMMAND', async () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const { CHECKS } = await import('../hooks/lib/checks.mjs')
  const { AT_COMMAND } = await import('../hooks/lib/user-words.mjs')
  const { TWEAK_COMMAND } = await import('../hooks/lib/tweak.mjs')
  const want = `^${PLUGIN_PREFIX}(at|at-tweak)$`
  assert.equal(CHECKS['user-words'].matcher, want)
  assert.equal(hooks.hooks.UserPromptExpansion?.[0]?.matcher, want)
  assert.equal(AT_COMMAND, `${PLUGIN_PREFIX}at`)
  assert.equal(TWEAK_COMMAND, `${PLUGIN_PREFIX}at-tweak`)
  assert.ok(existsSync(new URL('../commands/at.md', import.meta.url)), '插件里得有 at 这条命令')
})

// 一趟只归一个会话：命令展开时告诉项目经理这一趟归另一个会话（session-notice），只认本插件的 at、at-resume、at-status 三条——插件改名时没跟上，
// 【会话】就再也不说，别的会话里起 /poundlock:at 的项目经理只能等到写入被拒才知道。
test('session-notice 认的命令是 PLUGIN_PREFIX + at / at-resume / at-status / at-tweak：hooks.json 与 checks.mjs 的 matcher 相同、四条命令都在', async () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const { CHECKS } = await import('../hooks/lib/checks.mjs')
  const want = `^${PLUGIN_PREFIX}(at|at-resume|at-status|at-tweak)$`
  assert.equal(CHECKS['session-notice'].matcher, want)
  const entry = (hooks.hooks.UserPromptExpansion ?? []).find((e) => (e.hooks ?? []).some((h) => (h.args ?? []).includes('session-notice')))
  assert.ok(entry, 'hooks.json 里要有一条跑 session-notice 的 UserPromptExpansion')
  assert.equal(entry.matcher, want)
  for (const c of ['at', 'at-resume', 'at-status', 'at-tweak']) assert.ok(existsSync(new URL(`../commands/${c}.md`, import.meta.url)), c)
})

test('插件根没有 settings.json——默认接管去掉了，项目经理靠敲命令成为', () => {
  assert.equal(existsSync(new URL('../settings.json', import.meta.url)), false, '加回 settings.json 的 agent 会让每个新会话都变成项目经理')
  assert.ok(existsSync(new URL(`../agents/${PM_ROLE}.md`, import.meta.url)))
})
