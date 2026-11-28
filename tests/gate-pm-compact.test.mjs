// 压缩之后由门禁要求重读角色正文（pm-compact，SessionStart，来源 compact）：门禁子进程这一层——
//   - 压缩事件给记过号的会话记「要重读」（reread: true），别的会话的条目不动；没记号的会话、别的来源、带身份的不写；
//   - 记号文件不在、读不出来时什么都不做（不建、不重建）；永不写 stdout、不 exit 2；
//   - 带标记的会话自检一次：拒、带「在线」、说不带条件的那一句，标记当场清掉；再自检回到原来的那一句；别的会话不受影响；
//   - 标记只影响自检那一句话：派发、写文件的判定有没有标记都一样；
//   - 每一条之后 .poundlock/ 下没有遗留的临时文件或锁。
// 纯函数那一层（compactOf、withReread、needsReread、roleFileNote）在 tests/pm-session.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, GATE, decisionOf, hermeticEnv } from './helpers/gate-runner.mjs'
import { markPm } from './helpers/pm-mark.mjs'
import { REREAD_HEAD, needsReread, readMarks } from '../hooks/lib/pm-session.mjs'
import { GATE_CHECK_ONLINE } from '../hooks/lib/gate-check.mjs'
import { PM_SESSIONS_FILE } from '../hooks/lib/control-files.mjs'

const INJECT = fileURLToPath(new URL('./helpers/inject-throw.cjs', import.meta.url))
const SLASH = String.fromCharCode(92)
const ROLE_FILE = `${resolve(dirname(GATE), '..').split(SLASH).join('/')}/agents/at-pm.md`

const compact = (sid = 's-1', over = {}) => ({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid, ...over })
const marksPath = (dir) => join(dir, '.poundlock', PM_SESSIONS_FILE)
const marksAt = (dir) => readMarks(readFileSync(marksPath(dir)))
const bytesAt = (dir) => readFileSync(marksPath(dir), 'utf8')
const pre = (dir, tool_name, tool_input, sid) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: sid })
const selfCheck = (dir, sid) =>
  run('writepath', pre(dir, 'Write', { file_path: join(dir, '.poundlock', 'gate-check'), content: 'x' }, sid), GATE, dir)
const reasonOf = (out) => decisionOf(out.stdout)?.permissionDecisionReason ?? ''
const dispatch = (dir, sid) =>
  run('delegation', pre(dir, 'Agent', { subagent_type: 'at-backend', description: 'x', prompt: 'x' }, sid), GATE, dir)
const writeOther = (dir, sid) =>
  run('writepath', pre(dir, 'Write', { file_path: join(dir, 'src', 'a.js'), content: 'x' }, sid), GATE, dir)

function withProject(body) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'poundlock-pmcompact-')))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function noLeftovers(dir) {
  const left = existsSync(join(dir, '.poundlock')) ? readdirSync(join(dir, '.poundlock')).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')) : []
  assert.deepEqual(left, [], '.poundlock/ 下遗留了临时文件或锁')
}

test('压缩事件：记过号的 s-1 记上 reread，s-2 的条目原样，stdout 为空', () => {
  withProject((dir) => {
    markPm(dir, 's-1', 's-2')
    const before = marksAt(dir)
    const r = run('pm-compact', compact('s-1'), GATE, dir)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    const after = marksAt(dir)
    assert.equal(after.sessions['s-1'].reread, true)
    assert.equal(after.sessions['s-1'].command, before.sessions['s-1'].command)
    assert.deepEqual(after.sessions['s-2'], before.sessions['s-2'])
    noLeftovers(dir)
  })
})

test('压缩事件：没记号的会话、来源是 resume、带 agent_type、没有会话 id——记号文件字节不变，stdout 为空', () => {
  withProject((dir) => {
    markPm(dir, 's-1')
    const before = bytesAt(dir)
    for (const input of [compact('s-9'), compact('s-1', { source: 'resume' }), compact('s-1', { agent_type: 'poundlock:at-pm' }), compact('')]) {
      const r = run('pm-compact', input, GATE, dir)
      assert.equal(r.status, 0, JSON.stringify(input))
      assert.equal(r.stdout, '', JSON.stringify(input))
      assert.equal(bytesAt(dir), before, JSON.stringify(input))
    }
    noLeftovers(dir)
  })
})

test('压缩事件：记号文件不在不建、写成 x 不重建，exit 0、stdout 为空', () => {
  withProject((dir) => {
    const r = run('pm-compact', compact('s-1'), GATE, dir)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(existsSync(marksPath(dir)), false)
    mkdirSync(join(dir, '.poundlock'), { recursive: true })
    writeFileSync(marksPath(dir), 'x')
    const r2 = run('pm-compact', compact('s-1'), GATE, dir)
    assert.equal(r2.status, 0)
    assert.equal(r2.stdout, '')
    assert.equal(bytesAt(dir), 'x')
    noLeftovers(dir)
  })
})

test('自检：标记在的 s-1 被拒、带「在线」与不带条件的那一句、标记当场清掉但号还在；紧接着再自检回到原来的那一句', () => {
  withProject((dir) => {
    markPm(dir, 's-1')
    run('pm-compact', compact('s-1'), GATE, dir)
    assert.equal(needsReread(marksAt(dir), 's-1'), true)
    const first = selfCheck(dir, 's-1')
    const reason = reasonOf(first)
    assert.equal(decisionOf(first.stdout)?.permissionDecision, 'deny')
    assert.ok(reason.includes(GATE_CHECK_ONLINE), reason)
    assert.ok(reason.includes(REREAD_HEAD), reason)
    assert.ok(reason.includes(ROLE_FILE), reason)
    assert.ok(!reason.includes('眼前没有'), reason)
    const after = marksAt(dir)
    assert.equal(after.ok, true)
    assert.equal('reread' in after.sessions['s-1'], false)
    assert.equal(after.sessions['s-1'].command, 'at')
    noLeftovers(dir)
    const second = reasonOf(selfCheck(dir, 's-1'))
    assert.ok(second.includes(GATE_CHECK_ONLINE), second)
    assert.ok(!second.includes(REREAD_HEAD), second)
    assert.ok(second.includes('眼前没有'), second)
    noLeftovers(dir)
  })
})

test('自检：s-1 标记在时 s-2 自检不说那一句，s-1 的标记还在', () => {
  withProject((dir) => {
    markPm(dir, 's-1', 's-2')
    run('pm-compact', compact('s-1'), GATE, dir)
    const reason = reasonOf(selfCheck(dir, 's-2'))
    assert.ok(reason.includes(GATE_CHECK_ONLINE), reason)
    assert.ok(!reason.includes(REREAD_HEAD), reason)
    assert.equal(needsReread(marksAt(dir), 's-1'), true)
    noLeftovers(dir)
  })
})

test('标记只影响自检那一句：有标记与没标记，派团队角色、写别的文件的判定逐字相同，标记还在', () => {
  withProject((dir) => {
    markPm(dir, 's-1')
    const plain = { d: dispatch(dir, 's-1'), w: writeOther(dir, 's-1') }
    run('pm-compact', compact('s-1'), GATE, dir)
    assert.equal(needsReread(marksAt(dir), 's-1'), true)
    const marked = { d: dispatch(dir, 's-1'), w: writeOther(dir, 's-1') }
    for (const k of ['d', 'w']) {
      assert.equal(marked[k].status, plain[k].status, k)
      assert.equal(marked[k].stdout, plain[k].stdout, k)
      assert.equal(marked[k].stderr, plain[k].stderr, k)
    }
    assert.equal(needsReread(marksAt(dir), 's-1'), true)
    noLeftovers(dir)
  })
})

test('清标记改名不成：自检照样拒、带「在线」、说那一句，stderr 留一行，不留临时文件；标记还在', () => {
  withProject((dir) => {
    markPm(dir, 's-1')
    run('pm-compact', compact('s-1'), GATE, dir)
    const env = { ...hermeticEnv(), POUNDLOCK_TEST_THROW: 'rename:.tmp' }
    const input = pre(dir, 'Write', { file_path: join(dir, '.poundlock', 'gate-check'), content: 'x' }, 's-1')
    const out = run('writepath', input, GATE, dir, env, { nodeArgs: ['-r', INJECT] })
    const reason = reasonOf(out)
    assert.equal(decisionOf(out.stdout)?.permissionDecision, 'deny')
    assert.ok(reason.includes(GATE_CHECK_ONLINE), reason)
    assert.ok(reason.includes(REREAD_HEAD), reason)
    assert.match(out.stderr, /pm-compact/)
    assert.equal(needsReread(marksAt(dir), 's-1'), true)
    noLeftovers(dir)
  })
})

test('自检：记号文件读不出来时没有标记可言，回答不变（不抛、不 exit 2）', () => {
  withProject((dir) => {
    mkdirSync(join(dir, '.poundlock'), { recursive: true })
    writeFileSync(marksPath(dir), 'x')
    const out = selfCheck(dir, 's-1')
    assert.equal(decisionOf(out.stdout)?.permissionDecision, 'deny')
    assert.ok(!reasonOf(out).includes(REREAD_HEAD))
    assert.equal(bytesAt(dir), 'x')
  })
})
