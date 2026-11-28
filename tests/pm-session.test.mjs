import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BLOCKED_TOOLS, IDENTITY_TAG, MARK_COMMANDS, NOT_PM_HEAD, OUTSIDE_HEAD, OUTSIDER_CHECKS, REREAD_HEAD,
  blockedToolReason, compactOf, identityNotice, needsReread, inPoundlock, markOf, marksText, outsiderReason, outsiderVerdict, readMarks, roleFileNote, standingOf, unjudgedNote, withMark, withReread,
} from '../hooks/lib/pm-session.mjs'
import { GATE_CHECK_ONLINE } from '../hooks/lib/gate-check.mjs'
import { isGateFile, PM_SESSIONS_FILE } from '../hooks/lib/control-files.mjs'

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'))
const main = (over = {}) => ({ session_id: 's-1', ...over })
const marks = (...ids) => ({ ok: true, sessions: Object.fromEntries(ids.map((id) => [id, { at: 't', command: 'at' }])) })
const S = (input, m = marks()) => standingOf({ input, roster, marks: m })
const PM = { outsider: false, pm: true, kind: null, unjudged: null }
const LEGACY = { outsider: false, pm: false, kind: null, unjudged: null }

test('不带 agent_type 的主线程：记过号是项目经理，没记过是团队之外的人', () => {
  assert.deepEqual(S(main(), marks('s-1')), PM)
  assert.deepEqual(S(main(), marks('s-2')), { outsider: true, pm: false, kind: 'unmarked', unjudged: null })
  // 会话 id 撞上原型链上的名字时不算记过
  assert.deepEqual(S(main({ session_id: 'constructor' }), marks()), { outsider: true, pm: false, kind: 'unmarked', unjudged: null })
})

test('没有会话 id 当项目经理；记号文件读不出来谁都不靠记号当项目经理', () => {
  assert.deepEqual(S({}), { ...PM, unjudged: 'no-session-id' })
  assert.deepEqual(S(main({ session_id: '' })), { ...PM, unjudged: 'no-session-id' })
  assert.deepEqual(S(main(), { ok: false }), { outsider: true, pm: false, kind: 'unmarked', unjudged: 'marks-unreadable' })
  // 带 at-pm 身份的不看记号
  assert.deepEqual(S(main({ agent_type: 'poundlock:at-pm' }), { ok: false }), PM)
})

test('上一版的状态：带 at-pm 身份的主线程没有记号也是项目经理', () => {
  assert.deepEqual(S(main({ agent_type: 'poundlock:at-pm' })), PM)
  assert.deepEqual(S(main({ agent_type: 'at-pm' })), PM)
})

test('被换掉的主会话、花名册外的子代理是团队之外的人；团队角色与认不出的调用者交给原来的代码', () => {
  assert.deepEqual(S(main({ agent_type: 'general-purpose' })), { outsider: true, pm: false, kind: 'replaced', unjudged: null })
  assert.deepEqual(S(main({ agent_type: 'Explore', agent_id: 'a1' })), { outsider: true, pm: false, kind: 'subagent', unjudged: null })
  assert.deepEqual(S(main({ agent_type: 'other:at-backend', agent_id: 'a1' })), { outsider: true, pm: false, kind: 'subagent', unjudged: null })
  assert.deepEqual(S(main({ agent_type: 'poundlock:at-backend', agent_id: 'a1' })), LEGACY)
  assert.deepEqual(S(main({ agent_type: 'poundlock:at-architect' })), LEGACY)
  assert.deepEqual(S(main({ agent_type: 'poundlock:at-pm', agent_id: 'a1' })), LEGACY)
  assert.deepEqual(S(main({ agent_type: 42 })), LEGACY)
  assert.deepEqual(standingOf({ input: main(), roster: {}, marks: marks() }), LEGACY)
})

// CLI 的内部分叉带的是主线程的 agent_type 加它自己的 agent_id；主线程不带 agent_type 时，分叉就是这个形状——按所在会话的记号认。
test('带 agent_id、不带 agent_type 的调用者按所在会话的记号认：记过号或没有会话 id 交给原来的代码，没记号、读不出来是团队之外的人', () => {
  const fork = (over = {}) => main({ agent_id: 'a-1', ...over })
  assert.deepEqual(S(fork(), marks('s-1')), LEGACY)
  assert.deepEqual(S(fork({ agent_type: null }), marks('s-1')), LEGACY)
  assert.deepEqual(S(fork({ session_id: undefined })), LEGACY)
  assert.deepEqual(S(fork({ session_id: '' }), { ok: false }), LEGACY)
  assert.deepEqual(S(fork(), marks('s-2')), { outsider: true, pm: false, kind: 'subagent', unjudged: null })
  assert.deepEqual(S(fork({ session_id: 'constructor' })), { outsider: true, pm: false, kind: 'subagent', unjudged: null })
  assert.deepEqual(S(fork(), { ok: false }), { outsider: true, pm: false, kind: 'subagent', unjudged: 'marks-unreadable' })
})

test('记号文件：不在是一个项目经理会话都没有，读不懂是读不出来', () => {
  assert.deepEqual(readMarks(null), { ok: true, sessions: {} })
  assert.deepEqual(readMarks(marksText(marks('s-1'))), marks('s-1'))
  for (const bad of ['', 'x', '[]', 'null', '{"sessions":[]}', '{}']) assert.deepEqual(readMarks(bad), { ok: false }, bad)
  assert.equal(marksText(marks('s-1')), '{\n  "sessions": {\n    "s-1": {\n      "at": "t",\n      "command": "at"\n    }\n  }\n}\n')
  assert.equal(withMark(marks('s-1'), 's-1', { at: 't2', command: 'at-init' }), null)
  assert.deepEqual(Object.keys(withMark(marks('s-1'), 's-2', { at: 't2', command: 'at-init' }).sessions), ['s-1', 's-2'])
})

test('记号只认用户敲的五条命令、不带身份的会话', () => {
  const e = (command_name, over = {}) => ({ expansion_type: 'slash_command', command_name, session_id: 's-1', ...over })
  for (const c of MARK_COMMANDS) assert.deepEqual(markOf(e(`poundlock:${c}`)), { sessionId: 's-1', command: c })
  for (const input of [e('poundlock:at-status'), e('at'), e('other:at'), e('poundlock:at', { expansion_type: 'skill' }), e('poundlock:at', { session_id: '' }), e('poundlock:at', { agent_type: 'poundlock:at-pm' })]) {
    assert.equal(markOf(input), null, JSON.stringify(input))
  }
})

test('.poundlock 之下：按路径形状认，大小写、穿越都认', () => {
  for (const p of ['/p/.poundlock/x', '/p/.POUNDLOCK/runs/r/state.json', '/p/a/../.poundlock/x', '/p/.poundlock']) assert.equal(inPoundlock(p), true, p)
  // Windows 上指向同一个目录的写法：结尾的点与空格、流后缀
  for (const p of ['/p/.poundlock./x', '/p/.poundlock /x', '/p/.poundlock.. /x', '/p/.poundlock::$INDEX_ALLOCATION/x', '/p/.poundlock:s/x', '/p/.PoundLock./x']) assert.equal(inPoundlock(p), true, p)
  for (const p of ['/p/src/x', '/p/src/.poundlock.md', '/p/.poundlocks/x', '/p/x.poundlock/y', '', undefined]) assert.equal(inPoundlock(p), false, String(p))
})

test('文案：打头的固定串、出路、自检那一支不带在线', () => {
  const r = (kind, action, target) => outsiderReason({ kind, action, target })
  assert.ok(r('unmarked', 'dispatch', 'at-backend').startsWith(NOT_PM_HEAD))
  assert.match(r('unmarked', 'dispatch', 'at-backend'), /\/poundlock:at /)
  assert.ok(r('subagent', 'write').startsWith(OUTSIDE_HEAD))
  assert.ok(r('replaced', 'write').startsWith(OUTSIDE_HEAD))
  for (const kind of ['unmarked', 'replaced', 'subagent']) assert.ok(!r(kind, 'self-check').includes(GATE_CHECK_ONLINE), kind)
  assert.match(blockedToolReason('Skill'), /\/poundlock:at-skills/)
  for (const t of BLOCKED_TOOLS) assert.ok(blockedToolReason(t).includes(t), t)
  const first = identityNotice({ pluginRoot: '/plug', first: true })
  assert.ok(first.startsWith(IDENTITY_TAG))
  assert.match(first, /\/plug\/agents\/at-pm\.md/)
  assert.match(first, /CLAUDE_PLUGIN_ROOT/)
  assert.match(first, /对用户说一句/)
  assert.doesNotMatch(identityNotice({ pluginRoot: '/plug', first: false }), /对用户说一句/)
  assert.match(roleFileNote({ pluginRoot: '/plug' }), /\/plug\/agents\/at-pm\.md/)
})

test('unjudgedNote：两种说法各不相同，读不出来那句说怎么办', () => {
  assert.equal(unjudgedNote(null), '')
  const a = unjudgedNote('no-session-id')
  const b = unjudgedNote('marks-unreadable')
  assert.ok(a && b && a !== b)
  assert.match(b, /重新敲/)
  assert.equal(unjudgedNote('constructor'), '')
})

test('路径里的反斜杠折成正斜杠', () => {
  const root = 'C:' + String.fromCharCode(92) + 'plug'
  for (const text of [identityNotice({ pluginRoot: root, first: false }), roleFileNote({ pluginRoot: root })]) {
    assert.ok(text.includes('C:/plug/agents/at-pm.md'))
    assert.ok(!text.includes(String.fromCharCode(92)))
  }
})

test('调用方给的键撞上原型链上的名字时，不取到函数或对象', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    for (const text of [blockedToolReason(key), outsiderReason({ kind: 'unmarked', action: key })]) {
      for (const bad of ['function', '[object', '[native code]']) assert.ok(!text.includes(bad), key + ' ' + bad)
    }
  }
  const m = { ok: true, sessions: {} }
  assert.equal(S(main({ session_id: '__proto__' }), m).outsider, true)
  assert.equal(S(main({ session_id: '__proto__' }), withMark(m, '__proto__', { at: 't', command: 'at' })).pm, true)
})

test('记号文件是门禁专属文件', () => {
  assert.equal(PM_SESSIONS_FILE, 'pm-sessions.json')
  assert.equal(isGateFile('/p/.poundlock/pm-sessions.json'), true)
})

test('outsiderVerdict：不是团队之外的人回 null；派花名册里的名字拒、别的目标放行；写 .poundlock 之下拒、之外放行；别的检查项一律放行', () => {
  const out = S(main())
  assert.equal(out.outsider, true)
  for (const standing of [PM, LEGACY, null, undefined]) {
    for (const check of OUTSIDER_CHECKS) assert.equal(outsiderVerdict({ check, standing, roster, target: 'at-backend', filePath: '/p/.poundlock/x' }), null)
  }
  for (const target of ['poundlock:at-backend', 'at-product', 'at-pm', 'at-outsider']) {
    const v = outsiderVerdict({ check: 'delegation', standing: out, roster, target })
    assert.equal(v.action, '派发', target)
    assert.ok(v.deny.startsWith(NOT_PM_HEAD), target)
  }
  for (const target of ['Explore', 'general-purpose', undefined, '', 'poundlock:', 'constructor', '__proto__', 7]) {
    assert.deepEqual(outsiderVerdict({ check: 'delegation', standing: out, roster, target }), { allow: true }, String(target))
  }
  assert.deepEqual(outsiderVerdict({ check: 'delegation', standing: out, roster: {}, target: 'at-backend' }), { allow: true })
  const sub = S(main({ agent_type: 'general-purpose', agent_id: 'a-1' }))
  assert.ok(outsiderVerdict({ check: 'delegation', standing: sub, roster, target: 'at-qa' }).deny.startsWith(OUTSIDE_HEAD))
  const w = outsiderVerdict({ check: 'writepath', standing: out, roster, filePath: '/p/.poundlock/notes.md' })
  assert.equal(w.action, '写入')
  assert.ok(w.deny.startsWith(NOT_PM_HEAD))
  for (const filePath of ['/p/src/a.js', undefined, '', 5]) assert.deepEqual(outsiderVerdict({ check: 'writepath', standing: out, roster, filePath }), { allow: true }, String(filePath))
  for (const check of OUTSIDER_CHECKS.filter((c) => c !== 'delegation' && c !== 'writepath')) {
    assert.deepEqual(outsiderVerdict({ check, standing: out, roster, target: 'at-backend', filePath: '/p/.poundlock/state.json' }), { allow: true }, check)
  }
  assert.deepEqual([...OUTSIDER_CHECKS].sort(), ['approval-ask', 'approval-prompt', 'completion', 'contract', 'delegation', 'deliverable', 'ledger', 'readiness', 'rework', 'writepath'])
})

test('压缩：只认 SessionStart 来源是 compact、不带身份的会话', () => {
  const c = (over = {}) => ({ hook_event_name: 'SessionStart', source: 'compact', session_id: 's-1', ...over })
  assert.deepEqual(compactOf(c()), { sessionId: 's-1' })
  assert.deepEqual(compactOf(c({ agent_type: null })), { sessionId: 's-1' })
  for (const input of [c({ source: 'resume' }), c({ source: 'startup' }), c({ source: 'clear' }), c({ session_id: '' }), c({ session_id: 7 }), c({ agent_type: 'poundlock:at-pm' }), {}, null, undefined]) {
    assert.equal(compactOf(input), null, JSON.stringify(input))
  }
})

test('要重读的标记：只给记过号的会话记，记过不重复，清掉之后没有这个键', () => {
  const m = marks('s-1')
  assert.equal(needsReread(m, 's-1'), false)
  assert.equal(withReread(m, 's-2', true), null)
  assert.equal(withReread(m, 's-1', false), null)
  const on = withReread(m, 's-1', true)
  assert.equal(needsReread(on, 's-1'), true)
  assert.equal(on.sessions['s-1'].command, 'at')
  assert.equal(needsReread(m, 's-1'), false)
  assert.equal(withReread(on, 's-1', true), null)
  assert.deepEqual(readMarks(marksText(on)), on)
  const off = withReread(on, 's-1', false)
  assert.equal(needsReread(off, 's-1'), false)
  assert.equal('reread' in off.sessions['s-1'], false)
  assert.equal(needsReread({ ok: false }, 's-1'), false)
  assert.equal(withReread({ ok: false }, 's-1', true), null)
  assert.equal(needsReread(marks(), 'constructor'), false)
})

test('压缩之后那一句不带条件', () => {
  const must = roleFileNote({ pluginRoot: '/plug', must: true })
  assert.ok(must.startsWith(REREAD_HEAD), must)
  assert.match(must, /\/plug\/agents\/at-pm\.md/)
  assert.match(must, /CLAUDE_PLUGIN_ROOT/)
  assert.doesNotMatch(must, /眼前没有/)
  assert.ok(!roleFileNote({ pluginRoot: '/plug' }).includes(REREAD_HEAD))
  assert.match(roleFileNote({ pluginRoot: '/plug' }), /眼前没有/)
})
