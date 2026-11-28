// 项目经理会话的记号（pm-session，UserPromptExpansion）：门禁子进程这一层——
//   - 用户敲五条团队命令之一时，把这个会话记进项目的 .poundlock/pm-sessions.json（.poundlock 不在就建），回传【身份】；
//   - 同一个会话再敲不改原来那条、回传不再说「对用户说一句」；别的命令、经 Skill 调的、带身份的调用不记、不出声；
//   - 记号文件读不出来时从空表重建、只记这个会话，留一行 stderr；
//   - 并行的两个门禁进程不互相覆盖（锁）；回传不带会话 id；永不 exit 2。
// 纯函数那一层（markOf、readMarks、withMark、identityNotice）在 tests/pm-session.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { run, runAsync, GATE } from './helpers/gate-runner.mjs'
import { IDENTITY_TAG, readMarks } from '../hooks/lib/pm-session.mjs'
import { PM_SESSIONS_FILE } from '../hooks/lib/control-files.mjs'

const SLASH = String.fromCharCode(92)
const ROLE_FILE = `${resolve(dirname(GATE), '..').split(SLASH).join('/')}/agents/at-pm.md`
const TELL = '对用户说一句'

const expand = (command, sid = 's-1', over = {}) => ({
  hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
  command_name: `poundlock:${command}`, command_args: '', session_id: sid, ...over,
})
const marksPath = (dir) => join(dir, '.poundlock', PM_SESSIONS_FILE)
const marksAt = (dir) => readMarks(readFileSync(marksPath(dir)))
const contextOf = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '')

function tempProject({ poundlock = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'poundlock-pmsess-')))
  if (poundlock) mkdirSync(join(dir, '.poundlock'))
  return dir
}

function withProject(opts, body) {
  const dir = tempProject(opts)
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('pm-session：没有 .poundlock 的空目录里敲 at-init——建 .poundlock、记下这个会话，回传【身份】、角色正文的路径与「对用户说一句」', () => {
  withProject({}, (dir) => {
    const r = run('pm-session', expand('at-init'), GATE, dir)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(marksPath(dir)), '记号文件没建出来')
    const m = marksAt(dir)
    assert.equal(m.ok, true)
    assert.equal(m.sessions['s-1'].command, 'at-init')
    const ctx = contextOf(r)
    assert.ok(ctx.includes(IDENTITY_TAG), ctx)
    assert.ok(ctx.includes('agents/at-pm.md'), ctx)
    assert.ok(ctx.includes(ROLE_FILE), `回传里的角色正文路径应是 ${ROLE_FILE}：${ctx}`)
    assert.ok(ctx.includes(TELL), ctx)
  })
})

test('pm-session：同一个会话再敲 at-resume——文件字节不变，回传【身份】、不再「对用户说一句」', () => {
  withProject({}, (dir) => {
    run('pm-session', expand('at-init'), GATE, dir)
    const before = readFileSync(marksPath(dir))
    const r = run('pm-session', expand('at-resume'), GATE, dir)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(readFileSync(marksPath(dir)).equals(before), '已经记过的会话不该改文件')
    const ctx = contextOf(r)
    assert.ok(ctx.includes(IDENTITY_TAG), ctx)
    assert.ok(!ctx.includes(TELL), ctx)
  })
})

test('pm-session：另一个会话 s-2 敲 at——两条都在，s-1 那条原样', () => {
  withProject({}, (dir) => {
    run('pm-session', expand('at-init'), GATE, dir)
    const s1 = marksAt(dir).sessions['s-1']
    const r = run('pm-session', expand('at', 's-2'), GATE, dir)
    assert.equal(r.status, 0, r.stderr)
    const m = marksAt(dir)
    assert.deepEqual(Object.keys(m.sessions).sort(), ['s-1', 's-2'])
    assert.deepEqual(m.sessions['s-1'], s1)
    assert.equal(m.sessions['s-2'].command, 'at')
    assert.ok(contextOf(r).includes(TELL))
  })
})

test('pm-session：at-status、经 Skill 调的（expansion_type 不是 slash_command）、带 agent_type 的——不记、stdout 为空', () => {
  for (const [label, input] of [
    ['at-status', expand('at-status')],
    ['expansion_type: skill', expand('at', 's-1', { expansion_type: 'skill' })],
    ['带 agent_type', expand('at', 's-1', { agent_type: 'poundlock:at-pm' })],
  ]) {
    withProject({}, (dir) => {
      const r = run('pm-session', input, GATE, dir)
      assert.equal(r.status, 0, `${label}：${r.stderr}`)
      assert.equal(r.stdout, '', label)
      assert.ok(!existsSync(marksPath(dir)), `${label}：记号文件不该出现`)
    })
    withProject({ poundlock: true }, (dir) => {
      writeFileSync(marksPath(dir), '{"sessions":{}}\n')
      const r = run('pm-session', input, GATE, dir)
      assert.equal(r.stdout, '', label)
      assert.equal(readFileSync(marksPath(dir), 'utf8'), '{"sessions":{}}\n', `${label}：记号文件不该变`)
    })
  }
})

test('pm-session：记号文件读不出来（写成 x）——从空表重建、只记这个会话，回传照发，stderr 留一行，exit 0', () => {
  withProject({ poundlock: true }, (dir) => {
    writeFileSync(marksPath(dir), 'x')
    const r = run('pm-session', expand('at'), GATE, dir)
    assert.equal(r.status, 0, r.stderr)
    const m = marksAt(dir)
    assert.equal(m.ok, true, '重建之后应读得出')
    assert.deepEqual(Object.keys(m.sessions), ['s-1'])
    const ctx = contextOf(r)
    assert.ok(ctx.includes(IDENTITY_TAG), ctx)
    assert.ok(ctx.includes(TELL), ctx)
    assert.notEqual(r.stderr, '')
  })
})

test('pm-session：会话的 cwd 是项目的子目录、.poundlock 在上层——记在上层那一份，子目录里不新建 .poundlock', () => {
  withProject({ poundlock: true }, (dir) => {
    const sub = join(dir, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    const r = run('pm-session', expand('at'), GATE, sub)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(marksAt(dir).sessions['s-1'].command, 'at')
    assert.ok(!existsSync(join(sub, '.poundlock')), '子目录里不该新建 .poundlock')
    assert.ok(!existsSync(join(dir, 'src', '.poundlock')), '中间目录里不该新建 .poundlock')
  })
})

test('pm-session：s-1、s-2 两个门禁进程同时敲 at（10 轮）——每一轮两条都在', async () => {
  for (let round = 0; round < 10; round++) {
    const dir = tempProject({ poundlock: true })
    try {
      const rs = await Promise.all([
        runAsync('pm-session', expand('at', 's-1'), { cwd: dir }),
        runAsync('pm-session', expand('at', 's-2'), { cwd: dir }),
      ])
      for (const r of rs) assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(Object.keys(marksAt(dir).sessions).sort(), ['s-1', 's-2'], `第 ${round + 1} 轮`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('pm-session：回传不带会话 id', () => {
  withProject({}, (dir) => {
    const r = run('pm-session', expand('at'), GATE, dir)
    const ctx = contextOf(r)
    assert.ok(ctx.includes(IDENTITY_TAG), ctx)
    assert.ok(!contextOf(r).includes('s-1'), ctx)
  })
})

test('pm-session：读不出 hook 输入（不是 JSON）——exit 0、stdout 为空，stderr 说这个会话没有记成项目经理会话', () => {
  withProject({}, (dir) => {
    const r = run('pm-session', 'not json', GATE, dir)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes('没有记成项目经理会话'), r.stderr)
    assert.ok(!existsSync(join(dir, '.poundlock')), '读不出输入时什么都不建')
  })
})

test('pm-session：记号文件写不进（同名的是一个目录）——exit 0、不回传，stderr 留一行', () => {
  withProject({ poundlock: true }, (dir) => {
    mkdirSync(marksPath(dir))
    const r = run('pm-session', expand('at'), GATE, dir)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes('没有记成项目经理会话'), r.stderr)
  })
})
