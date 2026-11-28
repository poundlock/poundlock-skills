// 团队之外的人——门禁子进程那一层（设计 §5.1、§5.4、§5.6、§5.7）：没记过号的普通会话的主线程（N）、被换成花名册外 agent 的主会话（R）、
// 花名册外的子代理（A）走一条不依赖运行上下文的判定。四种项目状态都跑一遍，结果相同：
//   甲，跑过 at-init、没有 run；乙，一趟读得出的 run；丙，state.json 写坏的 run；丁，乙加上别的会话开着的一趟微调、它认领了 src/a.js。
// 判定本身（standingOf、inPoundlock、outsiderReason、unjudgedNote）的单测在 tests/pm-session.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { makeRun } from './fixtures/make-run.mjs'
import { run, decisionOf, GATE } from './helpers/gate-runner.mjs'
import { markPm } from './helpers/pm-mark.mjs'
import { NOT_PM_HEAD, OUTSIDE_HEAD, unjudgedNote } from '../hooks/lib/pm-session.mjs'
import { GATE_CHECK_ONLINE, selfCheckIdentity } from '../hooks/lib/gate-check.mjs'
import { PM_SESSIONS_FILE } from '../hooks/lib/control-files.mjs'
import { claimLine } from '../hooks/lib/claims.mjs'
import { ownerRecord } from '../hooks/lib/owner.mjs'
import { reworkFromHistory } from '../hooks/lib/state.mjs'
import { approvalLabel } from '../hooks/lib/budget.mjs'
import { norm } from '../hooks/lib/path-norm.mjs'
import { dispatchLine } from '../hooks/lib/completion.mjs'

const NL = String.fromCharCode(10)
const AT = '2026-11-28T10:00:00Z'
const PROJECT = { paths: { 'at-backend': ['src/'], 'at-frontend': ['web/'] }, available_roles: ['at-backend', 'at-frontend'] }

const N = {}
const R = { agent_type: 'general-purpose' }
const A = { agent_type: 'general-purpose', agent_id: 'a-9' }
const WHO = { N, R, A }
const pre = (tool_name, tool_input, who) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's-9', ...who })
const post = (tool_name, tool_input, tool_response, who) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, session_id: 's-9', ...who })

const reasonOf = (out) => decisionOf(out.stdout)?.permissionDecisionReason ?? ''
const denied = (out) => decisionOf(out.stdout)?.permissionDecision === 'deny'
const headOf = (who) => (who === N ? NOT_PM_HEAD : OUTSIDE_HEAD)

function tweakRun(projectDir) {
  const dir = join(projectDir, '.poundlock', 'runs', 't1')
  mkdirSync(dir, { recursive: true })
  const history = ['S1', 'S4', 'S5'].map((stage) => ({ stage, at: AT }))
  const state = {
    run_id: 't1', mode: 'tweak', stage: 'S5', contract_sha: 'PENDING', roster: [], stage_roles: {}, trimmed: {}, artifacts: {},
    rework: reworkFromHistory(history), rework_base: {}, never_invoked: [], escalations: [], closed_at: null, history,
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2))
  writeFileSync(join(dir, 'owner.json'), JSON.stringify(ownerRecord({ sessionId: 's-1', at: AT, via: 'create' })))
  writeFileSync(
    join(dir, 'user-words.json'),
    JSON.stringify({ at: AT, session_id: 's-1', args: '改 t1', source: 'command', command: 'at-tweak', runs_before: [], binding: null, bound: 't1', dropped: null, bound_at: AT }),
  )
  writeFileSync(join(dir, '00-contract.md'), '# 契约' + NL + NL + '内容' + NL)
  const file = join(projectDir, 'src', 'a.js')
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  writeFileSync(file, 'x')
  writeFileSync(join(dir, 'claims.jsonl'), claimLine({ at: AT, key: norm(file), path: 'src/a.js', role: 'at-backend' }) + NL)
}

// 四种项目状态。每一种回 { projectDir, cleanup }。
const STATES = {
  甲: () => {
    const d = makeRun({ project: PROJECT })
    rmSync(join(d.projectDir, '.poundlock', 'runs'), { recursive: true, force: true })
    rmSync(join(d.projectDir, '.poundlock', 'current-run'), { force: true })
    return d
  },
  乙: () => makeRun({ project: PROJECT, stage: 'S2' }),
  丙: () => {
    const d = makeRun({ project: PROJECT, stage: 'S2' })
    writeFileSync(join(d.projectDir, '.poundlock', 'runs', 'r1', 'state.json'), '{')
    return d
  },
  丁: () => {
    const d = makeRun({ project: PROJECT, stage: 'S2' })
    tweakRun(d.projectDir)
    return d
  },
}

function withState(name, body) {
  const d = STATES[name]()
  try {
    return body(d.projectDir)
  } finally {
    rmSync(d.projectDir, { recursive: true, force: true })
    rmSync(d.pluginDir, { recursive: true, force: true })
  }
}

function eachCase(body, whoNames = ['N', 'R', 'A']) {
  for (const s of Object.keys(STATES)) {
    for (const w of whoNames) withState(s, (p) => body(p, WHO[w], `${s}×${w}`))
  }
}

const agent = (p, target, who, check = 'delegation') =>
  run(check, pre('Agent', target === undefined ? { description: 'x', prompt: 'x' } : { subagent_type: target, description: 'x', prompt: 'x' }, who), GATE, p)
const write = (p, file, who, check = 'writepath') => run(check, pre('Write', { file_path: file, content: 'x' }, who), GATE, p)

function assertSilentPass(out, label) {
  assert.equal(out.status, 0, label)
  assert.equal(out.stdout, '', `${label}：stdout`)
  assert.equal(out.stderr, '', `${label}：stderr`)
}

function filesUnder(dir) {
  const list = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const f = join(d, name)
      if (statSync(f).isDirectory()) walk(f)
      else list.push(relative(dir, f))
    }
  }
  walk(dir)
  return list.sort()
}

test('delegation：团队之外的人派花名册里的角色，拒；N 以 NOT_PM_HEAD 打头，R、A 以 OUTSIDE_HEAD 打头；R 的理由末尾带身份那一句', () => {
  eachCase((p, who, label) => {
    for (const target of ['poundlock:at-backend', 'at-product']) {
      const out = agent(p, target, who)
      assert.equal(denied(out), true, `${label} ${target}`)
      const reason = reasonOf(out)
      assert.ok(reason.startsWith(headOf(who)), `${label} ${target}：${reason}`)
      if (who === R) {
        const identity = selfCheckIdentity(pre('Agent', {}, R), '派发')
        assert.notEqual(identity, '')
        assert.ok(reason.endsWith(identity), `${label} ${target}：身份那一句`)
      }
    }
  })
})

test('delegation：团队之外的人派花名册外的目标（Explore、general-purpose、不写），放行、两个流都空', () => {
  eachCase((p, who, label) => {
    for (const target of ['Explore', 'general-purpose', undefined]) assertSilentPass(agent(p, target, who), `${label} ${target}`)
  })
})

test('readiness、contract、rework：团队之外的人一律放行、两个流都空', () => {
  eachCase((p, who, label) => {
    for (const target of ['poundlock:at-backend', 'at-architect', 'Explore', undefined]) assertSilentPass(agent(p, target, who, 'readiness'), `${label} readiness ${target}`)
    const files = [
      join(p, 'src', 'a.js'),
      join(p, '.poundlock', 'runs', 'r1', '00-contract.md'),
      join(p, '.poundlock', 'runs', 'r1', 'state.json'),
      join(p, '.poundlock', 'runs', 't1', '00-contract.md'),
      join(p, '.poundlock', 'project.json'),
    ]
    for (const check of ['contract', 'rework']) for (const f of files) assertSilentPass(write(p, f, who, check), `${label} ${check} ${f}`)
  })
})

test('writepath：团队之外的人写 .poundlock 之外的项目文件，放行、两个流都空（run 读不出来、微调认领了它也放行）', () => {
  eachCase((p, who, label) => {
    assertSilentPass(write(p, join(p, 'src', 'a.js'), who), label)
    assertSilentPass(write(p, join(p, 'README.md'), who), `${label} README`)
  })
})

test('writepath：团队之外的人写 .poundlock 之下（控制文件、产物、别的文件、大小写与穿越写法），拒，理由以对应的固定串打头', () => {
  eachCase((p, who, label) => {
    const targets = [
      join(p, '.poundlock', 'project.json'),
      join(p, '.poundlock', 'current-run'),
      join(p, '.poundlock', 'runs', 'r1', 'state.json'),
      join(p, '.poundlock', 'runs', 'r1', '00-contract.md'),
      join(p, '.poundlock', 'notes.md'),
      join(p, '.POUNDLOCK', 'notes.md'),
      join(p, 'src') + '/../.poundlock/notes.md',
    ]
    for (const f of targets) {
      const out = write(p, f, who)
      assert.equal(denied(out), true, `${label} ${f}`)
      assert.ok(reasonOf(out).startsWith(headOf(who)), `${label} ${f}：${reasonOf(out)}`)
      if (who === R) assert.ok(reasonOf(out).endsWith(selfCheckIdentity(pre('Write', {}, R), '写入')), `${label} ${f}：身份`)
    }
  })
})

test('writepath：团队之外的人经指向 .poundlock 的链接写，拒（建不了链接就跳过）', (t) => {
  let skipped = false
  eachCase((p, who, label) => {
    if (skipped) return
    const link = join(p, 'lnk')
    if (!existsSync(link)) {
      try {
        symlinkSync(join(p, '.poundlock'), link, 'junction')
      } catch {
        skipped = true
        return
      }
    }
    const out = write(p, join(link, 'notes.md'), who)
    assert.equal(denied(out), true, label)
    assert.ok(reasonOf(out).startsWith(headOf(who)), label)
  })
  if (skipped) t.skip('建不了链接')
})

test('writepath：团队之外的人写 .poundlock/gate-check，拒，理由不含「在线」；写 runs/r1/owner.json 照旧是门禁专属文件的理由', () => {
  eachCase((p, who, label) => {
    const out = write(p, join(p, '.poundlock', 'gate-check'), who)
    assert.equal(denied(out), true, label)
    assert.ok(!reasonOf(out).includes(GATE_CHECK_ONLINE), `${label}：${reasonOf(out)}`)
    assert.ok(reasonOf(out).startsWith(headOf(who)), label)
    const own = write(p, join(p, '.poundlock', 'runs', 'r1', 'owner.json'), who)
    assert.equal(denied(own), true, `${label} owner.json`)
    assert.ok(reasonOf(own).startsWith('poundlock 门禁：不得写 '), `${label} owner.json：${reasonOf(own)}`)
    assert.match(reasonOf(own), /门禁记下的这一趟归哪个会话/)
  })
})

test('ledger、deliverable、completion、approval-ask、approval-prompt：普通会话不出声、不记任何文件', () => {
  eachCase((p, who, label) => {
    const before = filesUnder(p)
    const inputs = [
      ['ledger', post('Write', { file_path: join(p, '.poundlock', 'runs', 'r1', 'state.json'), content: 'x' }, { success: true }, who)],
      ['ledger', post('Write', { file_path: join(p, 'src', 'b.js'), content: 'x' }, { success: true }, who)],
      ['ledger', post('Write', { file_path: join(p, '.poundlock', 'project.json'), content: 'x' }, { success: true }, who)],
      ['deliverable', post('Agent', { subagent_type: 'poundlock:at-product', description: 'x', prompt: 'x' }, { status: 'completed', agentId: 'a0000000000000001', content: [] }, who)],
      ['deliverable', post('Agent', { subagent_type: 'Explore', description: 'x', prompt: 'x' }, { status: 'async_launched', agentId: 'a0000000000000002' }, who)],
      [
        'approval-ask',
        post(
          'AskUserQuestion',
          { questions: [{ question: '回到哪一段？', options: [{ label: approvalLabel('S2') }, { label: '停在这里' }] }] },
          { questions: [{ question: '回到哪一段？' }], answers: { '回到哪一段？': approvalLabel('S2') } },
          who,
        ),
      ],
      ['approval-prompt', { hook_event_name: 'UserPromptSubmit', prompt: approvalLabel('S2'), session_id: 's-9', ...who }],
      ['approval-prompt', { hook_event_name: 'UserPromptSubmit', prompt: '照现状交付', session_id: 's-9', ...who }],
      [
        'completion',
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 's-9',
          ...who,
          prompt:
            '<task-notification>\n<task-id>a0000000000000001</task-id>\n<tool-use-id>toolu_01AAAA</tool-use-id>\n<status>completed</status>\n' +
            '<summary>Agent "x" finished</summary>\n<result>写完了。</result>\n</task-notification>',
        },
      ],
    ]
    for (const [check, input] of inputs) {
      const out = run(check, input, GATE, p)
      assert.equal(out.status, 0, `${label} ${check}`)
      assert.equal(out.stdout, '', `${label} ${check}：stdout`)
    }
    assert.deepEqual(filesUnder(p), before, `${label}：没有新出现的文件`)
  }, ['N'])
})

// 对照：同一份输入，记过号的会话会记、会说——上一条的「不出声、不记」是分流挡下的，不是这份输入本来就什么都不触发。
test('对照：返工到上限时单独发批准标签、完成通知对得上派发记录——普通会话不记不说，记过号之后记、说', () => {
  withState('乙', (p) => {
    const runDir = join(p, '.poundlock', 'runs', 'r1')
    const ids = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S5', 'S6', 'S5', 'S6', 'S5', 'S6']
    const history = ids.map((stage) => ({ stage, at: AT }))
    const state = { run_id: 'r1', stage: 'S6', contract_sha: 'PENDING', roster: ['at-product'], artifacts: {}, rework: reworkFromHistory(history), never_invoked: [], escalations: [], history }
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state, null, 2))
    writeFileSync(join(runDir, 'dispatches.jsonl'), dispatchLine({ at: AT, agentId: 'a0000000000000001', toolUseId: 'toolu_01AAAA', role: 'at-product', stage: 'S2', caller: 'at-pm', callerId: null, mode: 'async' }) + NL)
    const label = { hook_event_name: 'UserPromptSubmit', prompt: approvalLabel('S5'), session_id: 's-9' }
    const notice = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's-9',
      prompt:
        '<task-notification>\n<task-id>a0000000000000001</task-id>\n<tool-use-id>toolu_01AAAA</tool-use-id>\n<status>completed</status>\n' +
        '<summary>Agent "x" finished</summary>\n<result>写完了。</result>\n</task-notification>',
    }
    const approvals = join(runDir, 'approvals.jsonl')
    assert.equal(run('approval-prompt', label, GATE, p).stdout, '')
    assert.equal(existsSync(approvals), false, '普通会话不记批准')
    assert.equal(run('completion', notice, GATE, p).stdout, '', '普通会话不说')
    markPm(p, 's-9')
    run('approval-prompt', label, GATE, p)
    assert.equal(existsSync(approvals), true, '记过号之后记下批准')
    assert.notEqual(run('completion', notice, GATE, p).stdout, '', '记过号之后完成核验说话')
  })
})

test('乙里记过号的普通会话主线程当项目经理：派 Explore 被拒（主会话那一行），自检拿到「在线」', () => {
  withState('乙', (p) => {
    markPm(p, 's-9')
    const out = agent(p, 'Explore', N)
    assert.equal(denied(out), true)
    assert.ok(!reasonOf(out).startsWith(NOT_PM_HEAD))
    const gc = write(p, join(p, '.poundlock', 'gate-check'), N)
    assert.equal(denied(gc), true)
    assert.ok(reasonOf(gc).includes(GATE_CHECK_ONLINE))
    assert.equal(unjudgedNote(null), '')
  })
})

test('乙里不带 session_id 的主线程当项目经理，理由末尾带「没有拿到会话 id」那一句', () => {
  withState('乙', (p) => {
    const input = (tool, ti) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: ti })
    const note = unjudgedNote('no-session-id')
    assert.notEqual(note, '')
    const out = run('delegation', input('Agent', { subagent_type: 'Explore', description: 'x', prompt: 'x' }), GATE, p)
    assert.equal(denied(out), true)
    assert.ok(reasonOf(out).endsWith(note), reasonOf(out))
    const gc = run('writepath', input('Write', { file_path: join(p, '.poundlock', 'gate-check'), content: 'x' }), GATE, p)
    assert.equal(denied(gc), true)
    assert.ok(reasonOf(gc).includes(GATE_CHECK_ONLINE))
    assert.ok(reasonOf(gc).endsWith(note), reasonOf(gc))
  })
})

test('乙里记号文件读不出来：不带 agent_type 的主线程当团队之外的人，拒绝理由末尾带「读不出记号文件」那一句', () => {
  withState('乙', (p) => {
    writeFileSync(join(p, '.poundlock', PM_SESSIONS_FILE), 'x')
    assert.throws(() => markPm(p, 's-9'))
    const note = unjudgedNote('marks-unreadable')
    assert.notEqual(note, '')
    assertSilentPass(agent(p, 'Explore', N), 'Explore')
    const out = agent(p, 'poundlock:at-backend', N)
    assert.equal(denied(out), true)
    assert.ok(reasonOf(out).startsWith(NOT_PM_HEAD))
    assert.ok(reasonOf(out).endsWith(note), reasonOf(out))
    const gc = write(p, join(p, '.poundlock', 'gate-check'), N)
    assert.equal(denied(gc), true)
    assert.ok(!reasonOf(gc).includes(GATE_CHECK_ONLINE))
    assert.ok(reasonOf(gc).endsWith(note), reasonOf(gc))
  })
  // 记号文件的位置是个目录（读错不是 ENOENT）：同样算读不出来。
  withState('乙', (p) => {
    mkdirSync(join(p, '.poundlock', PM_SESSIONS_FILE))
    assertSilentPass(agent(p, 'Explore', N), '目录：Explore')
    const out = agent(p, 'poundlock:at-backend', N)
    assert.equal(denied(out), true)
    assert.ok(reasonOf(out).startsWith(NOT_PM_HEAD) && reasonOf(out).endsWith(unjudgedNote('marks-unreadable')), reasonOf(out))
  })
})

test('乙里带 poundlock:at-pm 身份、没有记号：当项目经理——写 state.json 不因身份被拒，自检拿到「在线」', () => {
  withState('乙', (p) => {
    const PMW = { agent_type: 'poundlock:at-pm' }
    const out = write(p, join(p, '.poundlock', 'runs', 'r1', 'state.json'), PMW)
    assert.equal(denied(out), false, reasonOf(out))
    const gc = write(p, join(p, '.poundlock', 'gate-check'), PMW)
    assert.equal(denied(gc), true)
    assert.ok(reasonOf(gc).includes(GATE_CHECK_ONLINE))
  })
})
