// 项目经理会话的记号与身份判定：纯函数，不读文件、不写文件、不碰进程。
//
// 新开的会话是普通会话；用户敲团队命令（MARK_COMMANDS）才成为项目经理会话，记录器把会话 id 记进
// .poundlock/pm-sessions.json（门禁专属文件）。门禁按这份记号认谁是项目经理，认不出来的主线程就是团队之外的人。
// 这里只定记号的格式、谁是团队之外的人、各处的文案；读写文件和接进 hook 的是别的模块。
import { resolve, sep } from 'node:path'
import { PM_ROLE, PLUGIN_PREFIX, isValidRoster, malformedCaller, stripPluginPrefix } from './decide.mjs'
import { norm } from './path-norm.mjs'
import { normalizeText } from './text-norm.mjs'
import { inline } from './trusted.mjs'

// 用户敲了就让这个会话成为项目经理会话的命令（裸名，不带插件前缀）。
export const MARK_COMMANDS = ['at', 'at-tweak', 'at-resume', 'at-init', 'at-skills']

// 非项目经理的会话里一律拒的工具：能绕开门禁认身份的几样。
export const BLOCKED_TOOLS = ['Skill', 'SendMessage', 'ListAgents', 'EnterWorktree', 'Workflow']

export const NOT_PM_HEAD = 'poundlock：这个会话不是项目经理会话'
export const OUTSIDE_HEAD = 'poundlock：这次调用来自团队之外'
export const IDENTITY_TAG = '【身份】'

const SLASH = String.fromCharCode(92)
const fold = (p) => String(p).split(SLASH).join('/')
const has = (obj, key) => Object.hasOwn(obj, key)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmptyString = (v) => typeof v === 'string' && v !== ''

/**
 * 读记号文件的字节：不在（null、undefined）是一个项目经理会话都没有；合法是 { sessions: { <id>: {...} } }；
 * 别的（空、读不懂、形状不对）是读不出来，调用方按「判不出来」处理。
 */
export function readMarks(bytes) {
  if (bytes === null || bytes === undefined) return { ok: true, sessions: {} }
  let parsed
  try {
    parsed = JSON.parse(normalizeText(bytes))
  } catch {
    return { ok: false }
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.sessions)) return { ok: false }
  return { ok: true, sessions: parsed.sessions }
}

/** 记一个会话：已经记过的回 null（不重复记、不改原来那条），否则回新的 marks。 */
export function withMark(marks, sessionId, { at, command }) {
  if (has(marks.sessions, sessionId)) return null
  return { ok: true, sessions: { ...marks.sessions, [sessionId]: { at, command } } }
}

/** 记号文件的落盘文本：两格缩进的 JSON，结尾一个换行。 */
export function marksText(marks) {
  return `${JSON.stringify({ sessions: marks.sessions }, null, 2)}\n`
}

/** 这次用户提交是不是敲了团队命令：是则回会话 id 与命令名（裸名），否则 null。带身份的调用（子代理、被换掉的主会话）不记。 */
export function markOf(input) {
  if (input?.expansion_type !== 'slash_command') return null
  const name = input.command_name
  if (typeof name !== 'string' || !name.startsWith(PLUGIN_PREFIX)) return null
  const command = name.slice(PLUGIN_PREFIX.length)
  if (!MARK_COMMANDS.includes(command)) return null
  if (!nonEmptyString(input.session_id)) return null
  if (input.agent_type !== undefined && input.agent_type !== null) return null
  return { sessionId: input.session_id, command }
}

const standing = (outsider, pm, kind = null, unjudged = null) => ({ outsider, pm, kind, unjudged })

/**
 * 这次调用的发起者在团队里是什么位置。
 *   outsider：团队之外的人（kind：unmarked 没记过号的主线程、replaced 被换掉身份的主会话、subagent 花名册外的子代理）；
 *   pm：项目经理；
 *   unjudged：判不出来时说明为什么（没有会话 id 时按项目经理，记号文件读不出来时谁都不靠记号当项目经理）。
 * 认不出的调用者与花名册里的团队角色两样都不归这里管，回两个假。
 */
export function standingOf({ input, roster, marks }) {
  if (malformedCaller(input) || !isValidRoster(roster)) return standing(false, false)
  const raw = input?.agent_type
  const hasAgentId = nonEmptyString(input?.agent_id)
  if (raw === undefined || raw === null) {
    if (hasAgentId) return standing(false, false)
    if (!nonEmptyString(input?.session_id)) return standing(false, true, null, 'no-session-id')
    if (!marks?.ok) return standing(true, false, 'unmarked', 'marks-unreadable')
    if (has(marks.sessions, input.session_id)) return standing(false, true)
    return standing(true, false, 'unmarked')
  }
  const bare = stripPluginPrefix(raw)
  if (bare === PM_ROLE) return standing(false, !hasAgentId)
  if (has(roster, bare)) return standing(false, false)
  return standing(true, false, hasAgentId ? 'subagent' : 'replaced')
}

// 一段路径规范化之后的名字：截掉第一个冒号及之后（流后缀，如 ::$INDEX_ALLOCATION、:s），去掉结尾的点与空格，转小写——Windows 上这些写法
// 指向同一个目录。各平台都这样比：POSIX 上多拒一个字面叫「.poundlock.」的目录无妨。盘符那一段（C:）截完是 c，不影响。
const segName = (seg) => seg.split(':')[0].replace(/[. ]+$/, '').toLowerCase()

function endsUnder(parts) {
  return parts.some((seg) => segName(seg) === '.poundlock')
}

/** 这条路径在不在某个 .poundlock 目录之下（含它自己）：字面路径与物理路径任一命中就算，每一段规范化之后再比（不分大小写、流后缀与结尾的点、空格不算），穿越折掉之后再看。 */
export function inPoundlock(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false
  return endsUnder(resolve(filePath).split(sep)) || endsUnder(norm(filePath).split('/'))
}

const ASK_USER =
  '这一步模型自己做不了：请用户在这个会话里自己敲 `/poundlock:at <需求>`（也可以是 `/poundlock:at-tweak`、`/poundlock:at-resume`、' +
  '`/poundlock:at-init`、`/poundlock:at-skills`），敲过之后这个会话才是项目经理会话。' +
  '用户说已经敲过、你还是看到这一句，可能是 Claude Code 版本太旧或记号文件被删了，请用户再敲一次。'

const ACTION_TEXT = {
  dispatch: (target) => `派发 ${inline(target)}`,
  write: (target) => (target === undefined ? '写这个文件' : `写 ${inline(target)}`),
}

/** 团队之外的人被拒时的理由。action：dispatch（派发）、write（写文件）、self-check（门禁自检）。 */
export function outsiderReason({ kind, action, target }) {
  const unmarked = kind === 'unmarked'
  const head = unmarked ? NOT_PM_HEAD : OUTSIDE_HEAD
  const what =
    action === 'self-check'
      ? '门禁在跑，但只对项目经理会话回答在线，所以这一次不给自检的结果。'
      : `${(typeof action === 'string' && has(ACTION_TEXT, action) ? ACTION_TEXT[action] : ACTION_TEXT.write)(target)}被拒绝：团队的派发与对 .poundlock 的写入只属于项目经理会话。`
  let tail
  if (unmarked) tail = ASK_USER
  else if (kind === 'subagent') tail = '你不是团队的角色：停下，把要做的事回报给派你的人，由它决定。'
  else tail = '这个会话的身份被换成了团队之外的 agent：团队的事请用户换回项目经理会话来做。'
  return `${head}。${what}${tail}`
}

// 门禁里按身份分流的检查项（设计 §5.4）：团队之外的人在这几项上不走原来的代码。stop-gate、handback、handback-sent、记录器那几项不分流。
export const OUTSIDER_CHECKS = ['delegation', 'readiness', 'writepath', 'contract', 'rework', 'ledger', 'deliverable', 'approval-ask', 'approval-prompt', 'completion']

/**
 * 团队之外的人在一个检查项上怎么判（设计 §5.4），不看运行上下文：
 *   delegation：目标剥掉前缀是花名册里的名字 → 拒（派发），别的目标、没写目标 → 放行；
 *   writepath：路径在某个 .poundlock 之下 → 拒（写入），否则放行（门禁自检与门禁专属文件由调用方在这之前判）；
 *   别的检查项：放行，不出声、不记。
 * 不是团队之外的人回 null（走原来的代码）。拒回 { deny: 理由, action: 拼身份那一句用的动作 }，放行回 { allow: true }。
 */
export function outsiderVerdict({ check, standing, roster, target, filePath }) {
  if (!standing?.outsider) return null
  const kind = standing.kind
  if (check === 'delegation') {
    const bare = stripPluginPrefix(target)
    if (nonEmptyString(bare) && isPlainObject(roster) && has(roster, bare)) {
      return { deny: outsiderReason({ kind, action: 'dispatch', target: bare }), action: '派发' }
    }
    return { allow: true }
  }
  if (check === 'writepath' && inPoundlock(filePath)) return { deny: outsiderReason({ kind, action: 'write' }), action: '写入' }
  return { allow: true }
}

const NOTICE = {
  'no-session-id': '门禁这一次没有拿到会话 id，判不出这个会话是不是项目经理会话，按项目经理会话判。',
  'marks-unreadable': '门禁读不出记录项目经理会话的文件（.poundlock/pm-sessions.json），所以现在没有会话靠记号当项目经理。请用户重新敲一次团队命令（比如 `/poundlock:at <需求>`），那份文件会被重建。',
}

/** 判不出来时说的一句；判得出来（null）是空串。 */
export function unjudgedNote(unjudged) {
  if (typeof unjudged !== 'string' || !has(NOTICE, unjudged)) return ''
  return NOTICE[unjudged]
}

const BLOCKED_EXIT = {
  Skill: '要用某个 skill 时，请用户自己敲 `/poundlock:at-skills` 把它登记进项目，登记后的 skill 当文件读。',
  SendMessage: '团队角色之间不互发消息：派发与回报都走 Agent 工具的派发与交回。',
  ListAgents: '团队的角色清单以 roster.json 为准，不用列平台上的 agent。',
  EnterWorktree: '团队在项目目录里干活，不切换工作树。',
  Workflow: '团队的流程由项目经理沿阶段链派发，不跑别的工作流。',
}

/** 项目经理会话与团队角色里被拒的工具。 */
export function blockedToolReason(toolName) {
  const exit = typeof toolName === 'string' && has(BLOCKED_EXIT, toolName) ? BLOCKED_EXIT[toolName] : '这个工具不在团队的工具面里，换团队开放的工具做。'
  return `poundlock：团队的会话里不开放 ${inline(toolName)} 工具。${exit}`
}

function roleFilePath(pluginRoot) {
  return `${fold(pluginRoot)}/agents/at-pm.md`
}

function placeholderLine(pluginRoot) {
  return `角色正文里的占位符 ${'$' + '{CLAUDE_PLUGIN_ROOT}'} 指的就是 ${inline(fold(pluginRoot))}。`
}

/** 角色正文不在眼前时（比如上下文被压缩之后）的补读提示。 */
export function roleFileNote({ pluginRoot }) {
  return (
    `项目经理的角色正文在 ${inline(roleFilePath(pluginRoot))}，眼前没有它的全文就先读它，再接着做。` +
    placeholderLine(pluginRoot)
  )
}

/** 记号一记下就给这个会话的身份通知：以 IDENTITY_TAG 打头；first 为真是这个会话第一次成为项目经理会话。 */
export function identityNotice({ pluginRoot, first }) {
  const lines = [
    `${IDENTITY_TAG}这个会话现在是 poundlock 的项目经理会话，按项目经理的角色正文做事。`,
    `角色正文的绝对路径是 ${inline(roleFilePath(pluginRoot))}；眼前没有它的全文就先读它。`,
    placeholderLine(pluginRoot),
  ]
  if (first) lines.push('对用户说一句：这个会话从现在起是项目经理会话，到会话结束或 `/clear` 为止。')
  return lines.join('\n')
}
