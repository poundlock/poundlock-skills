// 门禁自检（M3t，docs/28，全量审查第 4 条）。
//
// 门禁全是 command hook，起不来时平台一律放行、错误不进模型的上下文——PM 自己察觉不到门禁没在跑。
// 所以反过来查：PM 用 Write 写 .poundlock/gate-check，门禁在线时 H3 必拒、理由里带着固定串；写入
// 成功就说明门禁没在跑。这份判据钉门禁这一半：什么样的写入拿得到「在线」、什么样的拿不到。
// 协议那一半（PM 怎么判、怎么收尾）在 agents/at-pm.md，由 tests/gate-check-prose.test.mjs 钉着。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, decisionOf, hermeticEnv } from './helpers/gate-runner.mjs'
import { makeRun } from './fixtures/make-run.mjs'
import { CHECKS } from '../hooks/lib/checks.mjs'
import { GATE_CHECK_PATH, GATE_CHECK_ONLINE, isGateCheck, gateCheckReason, selfCheckIdentity } from '../hooks/lib/gate-check.mjs'
import { OUTSIDE_HEAD } from '../hooks/lib/pm-session.mjs'

const BS = String.fromCharCode(92)
// 反斜杠只在 Windows 上是分隔符：Linux / macOS 上 `.poundlock\gate-check` 是一个字面名字的文件，本来就不算自检。
const WIN = process.platform === 'win32'

// ---- 路径判定 ----

test('isGateCheck：末两段恰好是 .poundlock/gate-check 才算——写法（分隔符、大小写、相对路径）不影响', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'poundlock-gc-')))
  try {
    for (const p of [
      join(base, '.poundlock', 'gate-check'),
      join(base, 'sub', '.poundlock', 'gate-check'),
      `${base}/.poundlock/gate-check`,
      join(base, '.POUNDLOCK', 'Gate-Check'),
      GATE_CHECK_PATH,
      ...(WIN ? [GATE_CHECK_PATH.split('/').join(BS)] : []),
    ]) {
      assert.ok(isGateCheck(p), p)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// 匹配过宽的代价是真的：被误认的正当写入会收到「预期的拒绝，接着往下做」，写入就悄悄丢了。
test('isGateCheck：相似的路径都不算', () => {
  for (const p of [
    '.poundlock/gate-check.txt',
    '.poundlock/gate-checkx',
    'x/gate-check',
    'gate-check',
    '.poundlock/sub/gate-check',
    'x.poundlock/gate-check',
    'x/y.poundlock/gate-check',
    '.poundlock',
    '',
    null,
    42,
  ]) {
    assert.ok(!isGateCheck(p), String(p))
  }
})

test('gateCheckReason：以固定串开头，带着门禁用的 node 版本与路径，说明拒绝是预期的', () => {
  const r = gateCheckReason({ version: 'v24.1.0', execPath: '/opt/node/bin/node' })
  assert.ok(r.startsWith(GATE_CHECK_ONLINE), r)
  assert.ok(r.includes('v24.1.0') && r.includes('/opt/node/bin/node'), r)
  assert.match(r, /预期/)
})

// 结果的有效期：只管这一轮。复核实测，续会话之后没有提醒时，PM 会拿上一个进程的「在线」对用户说
// 「自检通过」（0/4）；理由里写明有效期之后 4/4 重新自检（docs/28 §3）。
test('gateCheckReason：写明这个结果只管这一轮，之后每一轮都要重新自检', () => {
  const r = gateCheckReason()
  assert.match(r, /只管到这一轮/)
  assert.match(r, /重新自检/)
  assert.match(r, /继续/)
})

// node 的版本与路径由门禁自己取，但路径可以带任何字符（目录名里的 U+2028 在 NTFS 上合法）：
// 拼进理由也只许占一行（docs/27）。
test('gateCheckReason：版本与路径里的换行字符都不会让理由另起一行', () => {
  const breaks = [10, 13, 11, 12, 0x85, 0x2028, 0x2029].map((c) => String.fromCharCode(c))
  for (const b of breaks) {
    for (const r of [gateCheckReason({ version: `v24${b}伪造`, execPath: '/n' }), gateCheckReason({ version: 'v24', execPath: `/a${b}伪造` })]) {
      assert.ok(r.startsWith(GATE_CHECK_ONLINE), r)
      assert.ok(!breaks.some((c) => r.includes(c)), JSON.stringify(r))
    }
  }
})

// ---- 门禁子进程：谁写、在什么项目里写，都拿到「在线」 ----

const write = (agent, file_path, tool = 'Write') => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  ...(agent ? { agent_type: agent } : {}),
  tool_input: tool === 'NotebookEdit' ? { notebook_path: file_path, new_source: 'x' } : { file_path, content: 'x' },
})

// 三种项目状态：连 .poundlock 都没有（/at-init 之前）、run 好好的、run 读不出来（current-run 指向不存在的目录）。
function withProject(state, fn) {
  if (state === 'bare') {
    const p = realpathSync(mkdtempSync(join(tmpdir(), 'poundlock-gc-bare-')))
    try {
      return fn(p)
    } finally {
      rmSync(p, { recursive: true, force: true })
    }
  }
  const dirs = makeRun({ runId: 'r1', stage: 'S1', project: { paths: { 'at-backend': ['src/server/'] } } })
  try {
    if (state === 'unreadable') writeFileSync(join(dirs.projectDir, '.poundlock', 'current-run'), 'r-missing')
    return fn(dirs.projectDir)
  } finally {
    rmSync(dirs.projectDir, { recursive: true, force: true })
    rmSync(dirs.pluginDir, { recursive: true, force: true })
  }
}

const CALLERS = [
  ['主线程（没有 agent_type）', undefined],
  ['被钉成主线程的 at-pm', 'poundlock:at-pm'],
  ['执行角色', 'poundlock:at-backend'],
]

for (const state of ['bare', 'ok', 'unreadable']) {
  for (const [who, agent] of CALLERS) {
    test(`H3：${who}在「${state}」项目里写 .poundlock/gate-check → 拒，理由里有「在线」`, () => {
      withProject(state, (p) => {
        for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
          const r = run('writepath', write(agent, join(p, '.poundlock', 'gate-check'), tool), undefined, p)
          const d = decisionOf(r.stdout)
          assert.equal(d?.permissionDecision, 'deny', `${tool}：${r.stdout}${r.stderr}`)
          assert.ok(d.permissionDecisionReason.startsWith(GATE_CHECK_ONLINE), d.permissionDecisionReason)
        }
      })
    })
  }
}

// 项目根不锚定：用户 /cd 到别的目录再跑 /at-init 时，门禁认的项目根（CLAUDE_PROJECT_DIR）不是那里。
// 锚定项目根的写法会让自检在门禁好好的时候拿不到「在线」、PM 误报门禁没在跑。
test('H3：CLAUDE_PROJECT_DIR 指向别处、目标项目里还没有 .poundlock——照样拿到「在线」', () => {
  withProject('ok', (a) => {
    withProject('bare', (b) => {
      const env = { ...hermeticEnv(), CLAUDE_PROJECT_DIR: a }
      const r = run('writepath', write('poundlock:at-pm', join(b, '.poundlock', 'gate-check')), undefined, a, env)
      assert.ok(decisionOf(r.stdout)?.permissionDecisionReason?.startsWith(GATE_CHECK_ONLINE), r.stdout + r.stderr)
    })
  })
})

test('H3：路径写成反斜杠、大写、相对路径——照样拿到「在线」', () => {
  withProject('ok', (p) => {
    for (const fp of [
      ...(WIN ? [`${p}${BS}.poundlock${BS}gate-check`] : []),
      join(p, '.POUNDLOCK', 'GATE-CHECK'),
      GATE_CHECK_PATH,
    ]) {
      const r = run('writepath', write('poundlock:at-pm', fp), undefined, p)
      assert.ok(decisionOf(r.stdout)?.permissionDecisionReason?.startsWith(GATE_CHECK_ONLINE), `${fp}：${r.stdout}${r.stderr}`)
    }
  })
})

test('H3：相似的路径拿不到「在线」', () => {
  withProject('ok', (p) => {
    for (const fp of [
      join(p, '.poundlock', 'gate-check.txt'),
      join(p, '.poundlock', 'gate-checkx'),
      join(p, 'x', 'gate-check'),
      join(p, 'x.poundlock', 'gate-check'),
      join(p, 'x', 'y.poundlock', 'gate-check'),
    ]) {
      for (const [, agent] of CALLERS) {
        const r = run('writepath', write(agent, fp), undefined, p)
        assert.ok(!(r.stdout + r.stderr).includes(GATE_CHECK_ONLINE), `${fp}：${r.stdout}`)
      }
    }
  })
})

// 平台对同一次调用并行跑同组的全部 PreToolUse hook，模型只看到其中一条拒绝理由。会跑自检的是 PM
// （主线程或被钉住的 at-pm）：对它们，同组其余检查项必须一声不出，否则那条理由可能盖掉「在线」。
// 同组的检查项从 CHECKS 里取，将来往这一组加检查项会自动被纳入。
test('同组的其余检查项对 PM 的自检写入一声不出——模型看到的只会是「在线」那一条', () => {
  const siblings = Object.entries(CHECKS)
    .filter(([name, s]) => name !== 'writepath' && s.event === CHECKS.writepath.event &&
      JSON.stringify(s.toolNames) === JSON.stringify(CHECKS.writepath.toolNames))
    .map(([name]) => name)
  assert.ok(siblings.length > 0, '同组没有别的检查项——这条判据在空集合上空转')
  for (const state of ['bare', 'ok', 'unreadable']) {
    withProject(state, (p) => {
      for (const agent of [undefined, 'poundlock:at-pm']) {
        for (const check of siblings) {
          const r = run(check, write(agent, join(p, '.poundlock', 'gate-check')), undefined, p)
          assert.equal(r.stdout.trim(), '', `${state} · ${agent ?? '主线程'} · ${check}：${r.stdout}`)
          assert.equal(r.status, 0, `${state} · ${check}：${r.stderr}`)
        }
      }
    })
  }
})

// .poundlock 本身是链接（junction / 软链）、指向一个名字不同的目录时——比如把状态目录挪到别处再链回来
// ——norm() 解析出的物理路径末两段不是 .poundlock/gate-check。只按物理路径认，自检就永远拿不到
// 「在线」：门禁明明好好的，PM 却判它没在跑、给出一份查不出原因的排查清单（复核抓到的回归，
// docs/28 §3）。所以字面路径与物理路径任一命中都算。
const linkDir = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

test('H3：.poundlock 是指向别名目录的链接——照样拿到「在线」（有 run、没有 run；绝对、相对路径；三种调用者）', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'poundlock-gc-link-')))
  try {
    for (const withRun of [true, false]) {
      const p = join(base, withRun ? 'proj-run' : 'proj-bare')
      const store = join(base, withRun ? 'store-run' : 'store-bare', 'state-of-p')
      mkdirSync(join(store, 'runs', 'r1'), { recursive: true })
      mkdirSync(p, { recursive: true })
      if (withRun) {
        writeFileSync(join(store, 'current-run'), 'r1')
        writeFileSync(join(store, 'runs', 'r1', 'state.json'), JSON.stringify({ run_id: 'r1', stage: 'S1', contract_sha: 'PENDING', roster: [], artifacts: {}, rework: {}, never_invoked: [], escalations: [], history: [{ stage: 'S1', at: 't' }] }))
      } else {
        rmSync(join(store, 'runs'), { recursive: true, force: true })
      }
      linkDir(store, join(p, '.poundlock'))
      assert.ok(isGateCheck(join(p, '.poundlock', 'gate-check')), '链接下的自检路径没被认出来')
      for (const fp of [join(p, '.poundlock', 'gate-check'), GATE_CHECK_PATH]) {
        for (const [who, agent] of CALLERS) {
          const r = run('writepath', write(agent, fp), undefined, p)
          assert.ok(decisionOf(r.stdout)?.permissionDecisionReason?.startsWith(GATE_CHECK_ONLINE), `${withRun ? '有 run' : '没有 run'} · ${who} · ${fp}：${r.stdout}${r.stderr}`)
        }
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// M4i（docs/44，审查第 22 条）：主会话被设置里别的 agent 盖住时（带 agent_type、不是项目经理、没有 agent_id——子代理才带 agent_id），
// 自检照样回「在线」，可这样跑不了团队：H1 不管它的派发（花名册外的调用者），第一次写 state.json 就被拒。自检的回传里说清身份与出路。
const IDENTITY_NOTE = "注意：发起这次自检的是 \"my-main\"，不是 poundlock 的项目经理（poundlock:at-pm）——设置里的 agent 或者启动时的 --agent 换掉了主会话。这样跑不了这支团队：门禁不把你当项目经理，建 run、记 state.json 这些项目经理的写入会被拒。停下来告诉用户：去掉设置里的那一项 agent，不带别的 --agent 起一个会话、在里面敲团队命令（比如 /poundlock:at <需求>），或者用 claude --agent poundlock:at-pm 起会话。"
test('M4i 第 22 条：selfCheckIdentity——只对带 agent_type、不是项目经理、没有 agent_id 的调用者说身份', () => {
  assert.equal(selfCheckIdentity({ agent_type: 'my-main' }), IDENTITY_NOTE)
  // 复核（docs/44 §8）：agent_id 是空串的当没有（M08）；--agent 换成团队里别的角色时同样说，而且不说「派发不归花名册管」（低-3）；
  // 写入那一支的动作词（低-8）。
  assert.equal(selfCheckIdentity({ agent_type: 'my-main', agent_id: '' }), IDENTITY_NOTE)
  assert.equal(selfCheckIdentity({ agent_type: 'poundlock:at-architect' }), "注意：发起这次自检的是 \"poundlock:at-architect\"，不是 poundlock 的项目经理（poundlock:at-pm）——设置里的 agent 或者启动时的 --agent 换掉了主会话。这样跑不了这支团队：门禁不把你当项目经理，建 run、记 state.json 这些项目经理的写入会被拒。停下来告诉用户：去掉设置里的那一项 agent，不带别的 --agent 起一个会话、在里面敲团队命令（比如 /poundlock:at <需求>），或者用 claude --agent poundlock:at-pm 起会话。")
  assert.equal(selfCheckIdentity({ agent_type: 'my-main' }, '写入'), "注意：发起这次写入的是 \"my-main\"，不是 poundlock 的项目经理（poundlock:at-pm）——设置里的 agent 或者启动时的 --agent 换掉了主会话。这样跑不了这支团队：门禁不把你当项目经理，建 run、记 state.json 这些项目经理的写入会被拒。停下来告诉用户：去掉设置里的那一项 agent，不带别的 --agent 起一个会话、在里面敲团队命令（比如 /poundlock:at <需求>），或者用 claude --agent poundlock:at-pm 起会话。")
  for (const input of [{}, { agent_type: null }, { agent_type: 'poundlock:at-pm' }, { agent_type: 'at-pm' }, { agent_type: 'poundlock:at-backend', agent_id: 'a0000000000000d01' }, { agent_type: '' }, { agent_type: 7 }, { agent_type: '__main__' }]) {
    assert.equal(selfCheckIdentity(input), '', JSON.stringify(input))
  }
})

// 跑命令才成为项目经理那份设计 §5.4、§5.6：被换成花名册外 agent 的主会话是团队之外的人，自检不回答「在线」，拒绝理由末尾照旧说身份。
test('M4i 第 22 条：门禁子进程——盖住了主会话的别的 agent 来自检，不给「在线」、理由末尾跟着身份那一句', () => {
  withProject('ok', (p) => {
    const reasonOf = (input) => decisionOf(run('writepath', input, undefined, p).stdout)?.permissionDecisionReason ?? ''
    const target = join(p, '.poundlock', 'gate-check')
    const other = reasonOf(write('my-main', target))
    assert.ok(other.startsWith(OUTSIDE_HEAD) && !other.includes(GATE_CHECK_ONLINE) && other.endsWith(IDENTITY_NOTE), other)
    for (const agent of [undefined, 'poundlock:at-pm']) assert.ok(!reasonOf(write(agent, target)).includes('不是 poundlock 的项目经理'), String(agent))
    const sub = reasonOf({ ...write('poundlock:at-backend', target), agent_id: 'a0000000000000d01' })
    assert.ok(sub.startsWith(GATE_CHECK_ONLINE) && !sub.includes('不是 poundlock 的项目经理'), sub)
  })
})

// M4i 复核第二步（docs/44 §8）：H1 的拒绝末尾也接身份那一句（动作词「派发」）——M10e 里被 --agent 换成主会话的架构师派 at-product，收到的是
// 「冒泡给上级」，它没有上级。带 agent_id 的子代理、项目经理、认不出的调用者不接。
test('M4i 复核：门禁子进程——H1 拒绝被换掉的主会话时，理由末尾说身份', () => {
  withProject('ok', (p) => {
    const dispatch = (agent, target, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', ...(agent === undefined ? {} : { agent_type: agent }), tool_input: { subagent_type: target }, ...extra })
    const reasonOf = (input) => decisionOf(run('delegation', input, undefined, p).stdout)?.permissionDecisionReason ?? ''
    const arch = reasonOf(dispatch('poundlock:at-architect', 'poundlock:at-product'))
    assert.ok(arch.startsWith('角色 at-architect 不得派发给 at-product。') && arch.endsWith("注意：发起这次派发的是 \"poundlock:at-architect\"，不是 poundlock 的项目经理（poundlock:at-pm）——设置里的 agent 或者启动时的 --agent 换掉了主会话。这样跑不了这支团队：门禁不把你当项目经理，建 run、记 state.json 这些项目经理的写入会被拒。停下来告诉用户：去掉设置里的那一项 agent，不带别的 --agent 起一个会话、在里面敲团队命令（比如 /poundlock:at <需求>），或者用 claude --agent poundlock:at-pm 起会话。"), arch)
    // 被换成花名册外 agent 的主会话是团队之外的人（跑命令才成为项目经理那份设计 §5.4）：派花名册里的名字（这里是 at-pm）一律拒，理由末尾照旧说身份。
    const main = reasonOf(dispatch('my-main', 'poundlock:at-pm'))
    assert.ok(main.startsWith(OUTSIDE_HEAD), main)
    assert.ok(main.endsWith("注意：发起这次派发的是 \"my-main\"，不是 poundlock 的项目经理（poundlock:at-pm）——设置里的 agent 或者启动时的 --agent 换掉了主会话。这样跑不了这支团队：门禁不把你当项目经理，建 run、记 state.json 这些项目经理的写入会被拒。停下来告诉用户：去掉设置里的那一项 agent，不带别的 --agent 起一个会话、在里面敲团队命令（比如 /poundlock:at <需求>），或者用 claude --agent poundlock:at-pm 起会话。"), main)
    for (const input of [dispatch('poundlock:at-architect', 'poundlock:at-product', { agent_id: 'a0000000000000f01' }), dispatch('poundlock:at-pm', 'poundlock:at-backend'), dispatch(undefined, 'poundlock:at-backend'), dispatch('poundlock:', 'poundlock:at-backend')]) {
      const r = reasonOf(input)
      assert.ok(r && !r.includes('注意：发起这次'), r)
    }
  })
})
