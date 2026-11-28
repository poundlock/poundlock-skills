// 检查项 pm-tools：项目经理会话的主线程里拒掉五样绕得开门禁的工具；别的会话、子代理一律放行、一个字都不写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, decisionOf } from './helpers/gate-runner.mjs'
import { markPm } from './helpers/pm-mark.mjs'
import { CHECKS } from '../hooks/lib/checks.mjs'
import { BLOCKED_TOOLS, blockedToolReason, unjudgedNote } from '../hooks/lib/pm-session.mjs'

const SID = 's-pm'
const input = (tool_name, who = {}, withSession = true) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input: {},
  ...(withSession ? { session_id: SID } : {}),
  ...who,
})

function withProject(fn, { marked = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-pmtools-'))
  try {
    if (marked) markPm(dir, SID)
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const gate = (dir, inp) => run('pm-tools', inp, undefined, dir)
const reasonOf = (out) => decisionOf(out.stdout)?.permissionDecisionReason ?? ''
const denied = (out) => decisionOf(out.stdout)?.permissionDecision === 'deny'

test('记过号的主线程：五样工具逐个拒，理由就是 blockedToolReason；Skill 的理由指向 /poundlock:at-skills', () => {
  withProject((dir) => {
    for (const tool of BLOCKED_TOOLS) {
      const out = gate(dir, input(tool))
      assert.equal(out.status, 0, tool)
      assert.ok(denied(out), `${tool}：${out.stdout}`)
      assert.equal(reasonOf(out), blockedToolReason(tool), tool)
    }
    assert.ok(reasonOf(gate(dir, input('Skill'))).includes('/poundlock:at-skills'))
  })
})

test('没记号的主线程、花名册外的 agent、团队子代理：五样工具都放行，stdout 与 stderr 都空', () => {
  const whos = [{}, { agent_type: 'general-purpose' }, { agent_type: 'poundlock:at-backend', agent_id: 'a1' }]
  for (const marked of [false, true]) {
    withProject(
      (dir) => {
        for (const who of whos) {
          // 记过号的项目里，没记号的会话不是项目经理会话：用别的会话 id
          const base = marked && who.agent_type === undefined ? { session_id: 's-other' } : {}
          for (const tool of BLOCKED_TOOLS) {
            const out = gate(dir, { ...input(tool, who), ...base })
            assert.equal(out.status, 0, `${JSON.stringify(who)} ${tool}`)
            assert.equal(out.stdout, '', `${JSON.stringify(who)} ${tool} stdout`)
            assert.equal(out.stderr, '', `${JSON.stringify(who)} ${tool} stderr`)
          }
        }
      },
      { marked },
    )
  }
})

test('带 at-pm 身份的主线程：拒', () => {
  withProject(
    (dir) => {
      for (const tool of BLOCKED_TOOLS) {
        const out = gate(dir, input(tool, { agent_type: 'poundlock:at-pm' }))
        assert.ok(denied(out), tool)
        assert.ok(reasonOf(out).startsWith(blockedToolReason(tool)), tool)
      }
    },
    { marked: false },
  )
})

test('不带 session_id 的主线程：按项目经理拒，理由末尾带「没有会话 id」那一句', () => {
  withProject(
    (dir) => {
      for (const tool of BLOCKED_TOOLS) {
        const out = gate(dir, input(tool, {}, false))
        assert.ok(denied(out), tool)
        assert.equal(reasonOf(out), blockedToolReason(tool) + unjudgedNote('no-session-id'), tool)
      }
    },
    { marked: false },
  )
})

test('不在五样里的工具（Agent、Bash、Read）：记过号的主线程也放行，两个流都空', () => {
  withProject((dir) => {
    for (const tool of ['Agent', 'Bash', 'Read']) {
      const out = gate(dir, input(tool))
      assert.equal(out.status, 0, tool)
      assert.equal(out.stdout, '', tool)
      assert.equal(out.stderr, '', tool)
    }
  })
})

test('读不到 tool_name 时放行（failClosed 为假）：不拒、exit 0，只带统一的读不出输入的提示', () => {
  withProject((dir) => {
    const out = gate(dir, { hook_event_name: 'PreToolUse', session_id: SID })
    assert.equal(out.status, 0)
    assert.ok(!denied(out), out.stdout)
  })
})

test('登记：CHECKS[pm-tools].toolNames 与 BLOCKED_TOOLS 逐项相等，事件 PreToolUse，failClosed 为假', () => {
  assert.deepEqual(CHECKS['pm-tools'].toolNames, BLOCKED_TOOLS)
  assert.equal(CHECKS['pm-tools'].event, 'PreToolUse')
  assert.equal(CHECKS['pm-tools'].failClosed, false)
})
