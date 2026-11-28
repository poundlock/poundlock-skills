// 子进程判据用：给夹具项目记项目经理会话的号，格式与记录器（gate.mjs 的 pm-session 一支）写的同一份——都经 hooks/lib/pm-session.mjs 的
// withMark 与 marksText 生成，不手拼 JSON。门禁按这份记号认谁是项目经理：不带 agent_type、带 session_id 的主线程要当项目经理时，夹具先记它的号。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PM_SESSIONS_FILE } from '../../hooks/lib/control-files.mjs'
import { marksText, readMarks, withMark } from '../../hooks/lib/pm-session.mjs'

const AT = '2026-11-28T10:00:00.000Z'

/** 往 <projectDir>/.poundlock/pm-sessions.json 记号（目录不在就建），回文件路径。已有的记号保留；文件读不出来时抛（夹具不替坏文件兜底）。 */
export function markPm(projectDir, ...sessionIds) {
  const dir = join(projectDir, '.poundlock')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, PM_SESSIONS_FILE)
  let bytes = null
  try {
    bytes = readFileSync(file)
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e
  }
  let marks = readMarks(bytes)
  if (!marks.ok) throw new Error(`markPm：${file} 读不出来，不记号`)
  for (const id of sessionIds) marks = withMark(marks, id, { at: AT, command: 'at' }) ?? marks
  writeFileSync(file, marksText(marks))
  return file
}
