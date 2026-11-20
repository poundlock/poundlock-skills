// wellyard-managed: check-commit v3 sha256:bc792276ad78cd06386125f83758488ee68a4bfaca95f2ab9ea27b10a9dcf7cf
// Commit check for the main repo and component repos: no single file over 20MB, and gitleaks scans the staged changes for secrets; the main repo also only takes docs and the manifest.
// /wellyard:init writes it into each repo's .githooks/, and the pre-commit next to it calls it: node check-commit.mjs <main|component> <repo root>.
// Standalone script: only Node built-in modules, no file of the plugin is referenced (it does not run from the plugin directory).
// Importing it does nothing: the check only runs when it is run as a script (see the entry check at the end of the file) with main or component as the first argument.
// This check guards against slips, it is not a security boundary: git commit --no-verify skips it.
// Text marked binary or -diff (in the repo's .gitattributes, .git/info/attributes or the user's global core.attributesFile): git diff does not show its content,
// so gitleaks git --staged cannot scan it and exits 0, and the secrets in it could be committed as usual (measured with 8.30.1). A second scan covers it (scanMarkedText):
// ask git check-attr which staged regular files have the diff attribute unset (binary unsets it too), read the staged content, write the ones without NUL into a temporary directory and scan it with gitleaks dir;
// the ones with NUL are real binaries (images, archives and so on) and are not scanned. The findings of both scans go into one list.
// The second scan uses .gitleaks.toml in the repo root (passed with --config when there is one, so the user's own rules apply to these files too), and the
// entries "file:rule:line" of .gitleaksignore are filtered by the repo path (see ignoredEntries). The second scan reads whole files, not only the lines that changed.
// A gap the second scan still has: the files it scans are under blobs/tree/ in the temporary directory, so the paths gitleaks sees carry that prefix, and a config that anchors paths with ^ does not match:
// a path that does not match in an allowlist means extra findings; a path that does not match in a rule means the rule does not apply to the second scan's files, which means missed findings.
//
// Structured like check-encrypted.mjs of the secrets vault: when git and gitleaks are started, the working directory of the child process is always a temporary directory made by this script,
// never the repo; git is pointed at the repo with -C. On Windows, starting a program by name looks in the child's working directory first, so a file named git.exe in the workspace root would stand in for the real git;
// NoDefaultCurrentDirectoryInExePath is also set before a child process starts, as one more layer. The hook of these two kinds of repo lives in the repo itself, so this guards against accidents, not against people in the repo.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  basename, dirname, isAbsolute, join, posix, relative, resolve, win32,
} from 'node:path';

// The language of this script's messages. The script is standalone and cannot import the plugin, so it carries its own small resolver:
// the same order as machineLanguage in the plugin's lib/language.mjs, except that it skips Claude Code settings (step 6 of the order).
// WELLYARD_LANG, config.json language (<WELLYARD_CONFIG_DIR or ~/.config/wellyard>/config.json), a config that exists without a valid language (zh-CN),
// LC_ALL / LC_MESSAGES / LANG, the system locale, then en.
function languageFromLocale(locale) {
  if (typeof locale !== 'string') return null;
  const text = locale.trim().toLowerCase();
  if (text === '' || text === 'c' || text === 'posix' || text.startsWith('c.') || text.startsWith('posix.')) return null;
  return text.startsWith('zh') ? 'zh-CN' : 'en';
}

function defaultSystemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return '';
  }
}

// The machine config: { exists, language } where language is null unless it is a valid code.
function configLanguage(env) {
  const set = (name) => (typeof env[name] === 'string' && env[name] !== '' ? env[name] : null);
  const home = set(process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? homedir();
  const file = join(set('WELLYARD_CONFIG_DIR') ?? join(home, '.config', 'wellyard'), 'config.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { exists: error.code !== 'ENOENT', language: null };
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return { exists: true, language: value !== null && typeof value === 'object' ? value.language : null };
  } catch {
    return { exists: true, language: null };
  }
}

// hookLanguage(env, systemLocale) -> 'zh-CN' | 'en'
export function hookLanguage(env, systemLocale = defaultSystemLocale()) {
  const valid = (value) => (value === 'zh-CN' || value === 'en' ? value : null);
  const fromEnv = valid(env.WELLYARD_LANG);
  if (fromEnv !== null) return fromEnv;
  const config = configLanguage(env);
  if (config.exists) return valid(config.language) ?? 'zh-CN';
  const posixLocale = ['LC_ALL', 'LC_MESSAGES', 'LANG'].map((key) => env[key]).find((value) => typeof value === 'string' && value !== '');
  return languageFromLocale(posixLocale) ?? languageFromLocale(systemLocale) ?? 'en';
}

// The messages, one table per language. Entries are strings, or functions of the values to fill in.
const TEXT = {
  // cjk-allowed-start: the zh-CN message table; the hook speaks the machine language, and zh-CN is what an unconfigured computer speaks
  'zh-CN': {
    unreadableDiff: '读不懂 git diff --cached 的输出，没法检查',
    unreadableSizes: '读不懂 git cat-file 的输出，没法知道暂存的文件有多大',
    unreadableAttrs: '读不懂 git check-attr 的输出，没法知道哪些文件被标成了二进制',
    unreadableBlobs: '读不懂 git cat-file --batch 的输出，没法读出暂存的内容',
    outsideHint: (allowed) => `主仓库只收 ${allowed.join('、')}：代码要放进组件，用 /wellyard:add 登记成组件`,
    tooBigHint: '大文件不进 git：改放 GitHub Release，仓库里只写下载地址',
    leaksFound: 'gitleaks 在暂存的改动里发现了疑似密钥，提交被拒（只列出位置，不显示内容）：',
    leaksHint: (example) => '把密钥移出代码：值放进密钥仓，代码里从环境变量读；'
      + `确认不是密钥的，在仓库根目录的 .gitleaksignore 里加一行「文件:规则:行号」，比如 ${example}`,
    noRoot: '没有收到仓库的根目录，没法检查',
    noDrive: (root) => `收到的仓库根目录 ${root} 没有盘符，没法检查`,
    notDirectory: (value, root, same) => `收到的仓库根目录 ${same ? `${value} ` : `${value}（Windows 上按 ${root} 找）`}不是一个存在的目录（得是绝对路径），没法检查`,
    noWorkDir: (dir, reason) => `没能在 ${dir} 里建临时目录（${reason}），没法检查`,
    leftoverDir: (dir) => `临时目录 ${dir} 没删掉，可以手动删`,
    signal: (name) => `被信号 ${name} 终止`,
    exitCode: (code) => `退出码 ${code}`,
    withFirst: (failure, first) => `${failure}：${first}`,
    diffFailed: (failure) => `git diff --cached 没有成功（${failure}），没法知道暂存了哪些改动`,
    sizesFailed: (failure) => `git cat-file 没有成功（${failure}），没法知道暂存的文件有多大`,
    attrFailed: (failure) => `git check-attr 没有成功（${failure}），没法知道哪些文件被标成了二进制`,
    blobsFailed: (failure) => `git cat-file --batch 没有成功（${failure}），没法读出暂存的内容`,
    pathOutside: (path) => `暂存的路径 ${path} 不在仓库里，没法检查`,
    blobWriteFailed: (path, reason) => `没能把暂存的 ${path} 写进临时目录（${reason}），没法检查`,
    cannotRead: (file, reason) => `读不了 ${file}（${reason}），没法检查`,
    reasonOutside: '主仓库只收文档和清单',
    reasonTooBig: (mb, limit) => `${mb} MB，超过 ${limit} MB 的上限`,
    problemsHeader: '下面这些文件提交不进去：',
    problemLine: (path, reasons) => `  ${path}：${reasons.join('；')}`,
    scanFailed: (reason) => `gitleaks 没能完成扫描（${reason}），提交被拒：`,
    gitleaksMissing: (hint) => `没装 gitleaks，没法扫描暂存的改动里有没有密钥，提交被拒：先装上（${hint}）`,
    genericInstall: '用系统的包管理器安装 gitleaks',
    logErrorExit0: '退出码 0，日志里有错误',
    logErrorLeaks: (code) => `退出码 ${code}，日志里有错误，发现的可能不全`,
    reportUnreadable: (code) => `退出码 ${code}，报告读不懂`,
    reportEmpty: (code) => `退出码 ${code}，报告里却没有发现`,
    unknownKind: (kind) => `不认识的检查种类 ${kind}，只有 main 和 component`,
    withLeftover: (message, leftover) => `${message}；${leftover}`,
    checkFailed: (message) => `提交检查出错，提交被拒：${message}`,
  },
  // cjk-allowed-end
  en: {
    unreadableDiff: 'cannot parse the output of git diff --cached, so the check cannot run',
    unreadableSizes: 'cannot parse the output of git cat-file, so the size of the staged files is unknown',
    unreadableAttrs: 'cannot parse the output of git check-attr, so it is unknown which files are marked binary',
    unreadableBlobs: 'cannot parse the output of git cat-file --batch, so the staged content cannot be read',
    outsideHint: (allowed) => `the main repo only takes ${allowed.join(', ')}: put code in a component and register it with /wellyard:add`,
    tooBigHint: 'large files do not go into git: put them in a GitHub Release and only write the download address in the repo',
    leaksFound: 'gitleaks found suspected secrets in the staged changes, so the commit is rejected (only locations are listed, never contents):',
    leaksHint: (example) => 'move the secrets out of the code: put the values in the secrets vault and read them from environment variables in the code; '
      + `for anything confirmed not to be a secret, add a line "file:rule:line" to .gitleaksignore in the repo root, for example ${example}`,
    noRoot: 'the repo root was not received, so the check cannot run',
    noDrive: (root) => `the repo root received (${root}) has no drive letter, so the check cannot run`,
    notDirectory: (value, root, same) => `the repo root received (${same ? value : `${value}, looked up as ${root} on Windows`}) is not an existing directory (it must be an absolute path), so the check cannot run`,
    noWorkDir: (dir, reason) => `could not create a temporary directory in ${dir} (${reason}), so the check cannot run`,
    leftoverDir: (dir) => `the temporary directory ${dir} was not deleted, you can delete it by hand`,
    signal: (name) => `terminated by signal ${name}`,
    exitCode: (code) => `exit code ${code}`,
    withFirst: (failure, first) => `${failure}: ${first}`,
    diffFailed: (failure) => `git diff --cached did not succeed (${failure}), so it is unknown which changes are staged`,
    sizesFailed: (failure) => `git cat-file did not succeed (${failure}), so the size of the staged files is unknown`,
    attrFailed: (failure) => `git check-attr did not succeed (${failure}), so it is unknown which files are marked binary`,
    blobsFailed: (failure) => `git cat-file --batch did not succeed (${failure}), so the staged content cannot be read`,
    pathOutside: (path) => `the staged path ${path} is not inside the repo, so the check cannot run`,
    blobWriteFailed: (path, reason) => `could not write the staged ${path} into the temporary directory (${reason}), so the check cannot run`,
    cannotRead: (file, reason) => `cannot read ${file} (${reason}), so the check cannot run`,
    reasonOutside: 'the main repo only takes docs and the manifest',
    reasonTooBig: (mb, limit) => `${mb} MB, over the limit of ${limit} MB`,
    problemsHeader: 'these files cannot be committed:',
    problemLine: (path, reasons) => `  ${path}: ${reasons.join('; ')}`,
    scanFailed: (reason) => `gitleaks could not finish the scan (${reason}), so the commit is rejected:`,
    gitleaksMissing: (hint) => `gitleaks is not installed, so the staged changes cannot be scanned for secrets and the commit is rejected: install it first (${hint})`,
    genericInstall: "install gitleaks with the system's package manager",
    logErrorExit0: 'exit code 0, errors in the log',
    logErrorLeaks: (code) => `exit code ${code}, errors in the log, the findings may be incomplete`,
    reportUnreadable: (code) => `exit code ${code}, the report cannot be parsed`,
    reportEmpty: (code) => `exit code ${code}, but the report has no findings`,
    unknownKind: (kind) => `unknown check kind ${kind}, only main and component exist`,
    withLeftover: (message, leftover) => `${message}; ${leftover}`,
    checkFailed: (message) => `the commit check failed, so the commit is rejected: ${message}`,
  },
};

// The messages in the language of this process's environment, looked up when a message is made.
const say = () => TEXT[hookLanguage(process.env)];

// The main repo only takes these: these files in the root, and everything under these directories. Paths use /, relative to the repo root.
// .gitleaksignore is taken too: when a suspected secret is found, the how-to line tells the user to record the confirmed non-secrets in it
export const MAIN_ALLOWED_FILES = ['README.md', 'CLAUDE.md', 'workspace.json', '.gitignore', '.gitattributes', '.gitleaksignore'];
export const MAIN_ALLOWED_DIRS = ['.githooks/', '.claude/', 'docs/', 'design/'];
// The limit for a single file, by the byte count of the staged content
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// The commands that install gitleaks, the same as INSTALL_HINTS in the plugin's lib/preflight.mjs (a test checks); systems not in the table get a generic wording
export const GITLEAKS_HINTS = { darwin: 'brew install gitleaks', win32: 'winget install --id Gitleaks.Gitleaks -e' };

const MIB = 1024 * 1024;
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
// spawnSync only takes 1 MiB of output by default and kills the child when it is over; with many staged files the output of git diff, and with many findings the output of gitleaks, can be bigger
const MAX_BUFFER = 64 * MIB;
// The staged entries whose size is checked: regular files, executables, symlinks. Submodules (160000) record a commit of another repo and are not checked
const BLOB_MODES = new Set(['100644', '100755', '120000']);
// When scanning text marked as binary, only regular files and executables count: a symlink records its target path, a submodule is a commit of another repo
const FILE_MODES = new Set(['100644', '100755']);
// The second scan reads at most this many bytes per git cat-file --batch (one file is never split, and the biggest single file is MAX_FILE_BYTES): the output has to fit in MAX_BUFFER
const BATCH_BYTES = 32 * MIB;
// In the second scan the staged content is written under blobs/tree/ in the temporary directory, and gitleaks dir scans blobs. The extra tree/ level is needed: gitleaks dir reads <scanned directory>/.gitleaksignore and
// <scanned directory>/.gitleaks.toml as config, so if the root .gitleaksignore or .gitleaks.toml is staged and marked binary and its copy landed in the root of the scanned directory,
// it could release or allowlist the secrets in other files (measured with 8.30.1). Now the root of the scanned directory holds no staged file.
// Paths in the report all carry the prefix blobs/tree/, which is removed when turning them back into repo paths
const BLOBS_DIR = 'blobs';
const TREE_DIR = 'tree';
const TREE_PREFIX = `${BLOBS_DIR}/${TREE_DIR}/`;
// git decides whether a file is binary only by whether the first this many bytes have a NUL (xdiff's buffer_is_binary; same as FIRST_FEW_BYTES in lib/leakscan.mjs).
// The second scan decides the same way: a file with no NUL at the start is text to git anyway, it was only marked binary that kept it from being scanned
const FIRST_FEW_BYTES = 8000;
// The first field of each git diff --raw entry: ":old mode new mode old blob new blob status". With --no-renames the status is a single letter followed by one path
const RAW_HEADER = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]$/;
// Terminal color control sequences (ESC [ parameters, then a final letter). With --no-color given, errors gitleaks prints before it reads its config (for example a broken .gitleaks.toml) still carry color
const COLOR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}[[][0-?]*[ -/]*[@-~]`, 'g');
// Each line of gitleaks' log is "time level text", and the lines whose second field is ERR
const ERROR_LINE = /^\S+[ \t]+ERR[ \t]/m;
// The exit code gitleaks uses when it finds suspected secrets, given with --exit-code. Not its default 1: gitleaks exits with 1 when it fails itself
// (a broken .gitleaks.toml, a wrong path and so on), so a finding could not be told from a failed scan; 2 is the exit code of a crashed Go program. 0 and every code other than this one do not count as findings
const LEAKS_EXIT_CODE = 3;
// The config for the git diff that gitleaks runs, appended at the end of its GIT_CONFIG_PARAMETERS: git's later config overrides the earlier, so it overrides
// the user's global and repo config and what git -c brings in. A user's config can make this diff show no content, so gitleaks scans 0 bytes and exits with 0
// and the commit passes (measured with 8.30.1). Each item guards against one case:
//   color.ui and color.diff set to never: when set to always the diff carries color and gitleaks cannot read the changes;
//   core.bigFileThreshold set back to git's default 512m: a smaller value makes git diff treat bigger files as binary and show no content.
//   No larger value here: the hook already rejects files over 20MB, so everything that gets in is smaller than 512m
const GITLEAKS_GIT_CONFIG = "'color.ui=never' 'color.diff=never' 'core.bigFileThreshold=512m'";

// run(argv, { cwd, input, env, binary }) -> { status, signal, stdout, stderr, error }: argv[0] is the program name, output is a string (stderr is always a string),
// input goes to the child's stdin; when binary is true stdout is a Buffer (used to read staged file content, since decoding it as UTF-8 would change invalid bytes).
// When the child is killed by a signal, status is null and signal is the signal name.
// When env is not given the child inherits this process's environment (only given for gitleaks, see gitleaksEnv). What git sets for a hook (GIT_INDEX_FILE and so on) has to reach git and gitleaks
// (which calls git itself; a relative path is still resolved against the repo after -C), so that what is checked is what this commit staged
function defaultRun(argv, { cwd, input, env, binary = false } = {}) {
  // When Windows looks for a program given only by name it looks in the child's working directory first, then in PATH, unless the process's own environment has this variable (putting it in the env option does nothing)
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
  // Without an encoding the output of spawnSync is a Buffer
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, input, env, ...(binary ? {} : { encoding: 'utf8' }), maxBuffer: MAX_BUFFER, windowsHide: true,
  });
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr, error: result.error };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// How the repo root is written, the same as the copy in the secrets vault hook (a test checks). pre-commit tries pwd -W first, which gives C:/... in the sh of Git for Windows;
// when it fails it falls back to $PWD, which in the MSYS2 sh on Windows is /c/Users/..., and with MSYS path conversion off (MSYS_NO_PATHCONV=1 and so on) that is what node receives.
// So on Windows a /x/... or /x that starts with a single drive letter becomes X:/... or X:/; any other form, and any other system, is left as it is (one without a drive letter is rejected by checkCommit)
export function normalizeRepoRoot(value, platform = process.platform) {
  if (platform !== 'win32' || typeof value !== 'string') return value;
  const letter = value[1];
  if (value[0] === '/' && letter !== undefined && /[A-Za-z]/.test(letter) && (value.length === 2 || value[2] === '/')) {
    return `${letter.toUpperCase()}:/${value.slice(3)}`;
  }
  return value;
}

// The repo root used for the check: value is what the command line received, passed through normalizeRepoRoot first. When the check cannot run it throws, with the received value in the error:
// not received; on Windows no drive letter (a mount point such as /tmp/... is looked up at the root of the current drive and finds another directory, and the bare slash can even be found, so this comes before the existence check);
// not an existing absolute directory
function repoRoot(value, platform) {
  if (typeof value !== 'string' || value === '') throw new Error(say().noRoot);
  const root = normalizeRepoRoot(value, platform);
  if (platform === 'win32' && ['/', BACKSLASH].includes(win32.parse(root).root)) {
    throw new Error(say().noDrive(printable(root)));
  }
  if (!isAbsolute(root) || !isDirectory(root)) {
    throw new Error(say().notDirectory(printable(value), printable(root), root === value));
  }
  return root;
}

// The working directory of the child processes: an empty temporary directory this script made. Without one the check cannot run
function makeWorkDir() {
  try {
    return mkdtempSync(join(tmpdir(), 'wellyard-hook-'));
  } catch (error) {
    throw new Error(say().noWorkDir(printable(tmpdir()), error.code ?? error.message));
  }
}

// Deletes the temporary directory: returns null when it is deleted; when it cannot be deleted (held by antivirus software and so on) returns the line to tell the user, never swallowed
function removeWorkDir(work) {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    return null;
  } catch {
    return say().leftoverDir(printable(work));
  }
}

// How a child process failed: the error code when it could not start (ENOENT and so on), the signal name when it was killed by a signal, otherwise the exit code
function failureOf(result) {
  if (result.error) return String(result.error.code ?? result.error.message);
  if (result.status === null && result.signal) return say().signal(result.signal);
  return say().exitCode(result.status);
}

// How git failed: failureOf, followed by the first line of git's error (when there is one)
function gitFailure(result) {
  const first = String(result.stderr ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '');
  return first === undefined ? failureOf(result) : say().withFirst(failureOf(result), first);
}

// The staged changes: [{ mode, blob, path }], mode and blob are of the new side, in git's order (sorted by path).
// Deleted ones are not in it (--diff-filter=d), so a deletion always passes. Under -z each entry is two fields, the RAW_HEADER one and the path (as is, unquoted), each ending in NUL
function stagedChanges(run, root, work) {
  const listed = run(['git', '-C', root, 'diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--diff-filter=d'], { cwd: work });
  if (listed.error || listed.status !== 0) throw new Error(say().diffFailed(gitFailure(listed)));
  const fields = String(listed.stdout).split(NUL);
  // The output ends with NUL, so after splitting the last field is an empty string
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error(say().unreadableDiff);
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const header = RAW_HEADER.exec(fields[i]);
    if (header === null) throw new Error(say().unreadableDiff);
    changes.push({ mode: header[1], blob: header[2], path: fields[i + 1] });
  }
  return changes;
}

// The byte count of the staged content, in the order of blobs. One git cat-file --batch-check: stdin has one blob per line, the output has "<blob> blob <bytes>" per line, in the same order as the input
function blobSizes(run, root, work, blobs) {
  if (blobs.length === 0) return [];
  const result = run(['git', '-C', root, 'cat-file', '--batch-check'], { cwd: work, input: blobs.map((blob) => `${blob}\n`).join('') });
  if (result.error || result.status !== 0) throw new Error(say().sizesFailed(gitFailure(result)));
  const lines = String(result.stdout).split('\n');
  return blobs.map((blob, i) => {
    const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec((lines[i] ?? '').trimEnd());
    if (match === null || match[1] !== blob) throw new Error(say().unreadableSizes);
    return Number(match[2]);
  });
}

// Which staged regular files are marked binary or -diff (git check-attr says the diff attribute is unset, and binary unsets it too): returns them, in the order of candidates.
// The index view and the working tree view are each asked once, and a mark in either counts: git diff looks at the working tree's .gitattributes (the index's only when the working tree has none), and what gitleaks cannot scan is exactly what it sees as binary;
// the index view is the attributes this commit really takes along (git commit -a and the like use a temporary index, and GIT_INDEX_FILE goes to git with the environment).
// The paths go to git through stdin (-z, each ending in NUL): with many staged files the command line cannot hold them
function markedFiles(run, root, work, candidates) {
  if (candidates.length === 0) return [];
  const asked = new Set(candidates.map((change) => change.path));
  const input = candidates.map((change) => `${change.path}${NUL}`).join('');
  const unset = new Set();
  for (const view of [['--cached'], []]) {
    const result = run(['git', '-C', root, 'check-attr', ...view, '-z', '--stdin', 'diff'], { cwd: work, input });
    if (result.error || result.status !== 0) throw new Error(say().attrFailed(gitFailure(result)));
    // The output ends with NUL, and each path is a group of three fields: path, attribute name, value
    const fields = String(result.stdout).split(NUL);
    if (fields.pop() !== '' || fields.length !== candidates.length * 3) throw new Error(say().unreadableAttrs);
    for (let i = 0; i < fields.length; i += 3) {
      if (!asked.has(fields[i]) || fields[i + 1] !== 'diff') throw new Error(say().unreadableAttrs);
      if (fields[i + 2] === 'unset') unset.add(fields[i]);
    }
  }
  return candidates.filter((change) => unset.has(change.path));
}

// Reads the staged content and hands each one to visit(item, content), in the order of items: items is [{ blob, bytes }]. One git cat-file --batch with one blob per line on stdin,
// and the output has "<blob> blob <bytes>\n<content>\n" for each; it goes in batches of BATCH_BYTES so that the output does not go over MAX_BUFFER and the content of all files is not in memory at once
function forEachBlob(run, root, work, items, visit) {
  for (let start = 0; start < items.length;) {
    let end = start + 1;
    let total = items[start].bytes;
    while (end < items.length && total + items[end].bytes <= BATCH_BYTES) {
      total += items[end].bytes;
      end += 1;
    }
    const batch = items.slice(start, end);
    const result = run(['git', '-C', root, 'cat-file', '--batch'], { cwd: work, input: batch.map((item) => `${item.blob}\n`).join(''), binary: true });
    if (result.error || result.status !== 0) throw new Error(say().blobsFailed(gitFailure(result)));
    const out = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''));
    let at = 0;
    for (const item of batch) {
      const lineEnd = out.indexOf(10, at);
      const header = lineEnd < 0 ? null : /^([0-9a-f]+) blob ([0-9]+)$/.exec(out.toString('latin1', at, lineEnd));
      if (header === null || header[1] !== item.blob) throw new Error(say().unreadableBlobs);
      const bodyEnd = lineEnd + 1 + Number(header[2]);
      // A newline follows the content
      if (out.length <= bodyEnd || out[bodyEnd] !== 10) throw new Error(say().unreadableBlobs);
      visit(item, out.subarray(lineEnd + 1, bodyEnd));
      at = bodyEnd + 1;
    }
    if (at !== out.length) throw new Error(say().unreadableBlobs);
    start = end;
  }
}

// Writes the staged content to its repo path under treeDir. The path comes from the index and git does not take one with .. or an absolute path, but it is checked again here: one that would land outside treeDir is not written.
// Written with wx: a second write to the same path (which is what A.cfg and a.cfg are on a case-insensitive file system) fails, so a later write never overwrites an earlier one, or the earlier one would not be scanned. When it cannot be written the check cannot run
function writeBlob(treeDir, path, content) {
  const inside = relative(treeDir, resolve(treeDir, path));
  if (inside === '' || inside.split(/[\\/]/)[0] === '..' || isAbsolute(inside)) throw new Error(say().pathOutside(printable(path)));
  try {
    mkdirSync(dirname(join(treeDir, path)), { recursive: true });
    writeFileSync(join(treeDir, path), content, { flag: 'wx' });
  } catch (error) {
    throw new Error(say().blobWriteFailed(printable(path), error.code ?? error.message));
  }
}

// The entries "file:rule:line" of .gitleaksignore in the repo root, each put into a set as `file:rule:line`, with the file tidied the way gitleaks does it (backslashes become /, then normalize).
// The second scan is gitleaks dir on copies in the temporary directory, whose fingerprints carry the blobs/ prefix, so the relative paths written in the repo do not match (measured with 8.30.1); so it is not left to gitleaks, and this list is filtered here.
// The same as gitleaks: leading and trailing whitespace is dropped, empty lines and lines starting with # are skipped, and only exactly three fields count (the four-field ones with a commit are for history scans and are of no use here).
// When there is no such file (ENOENT) there are no entries; for any other reason it cannot be read (a directory, no permission and so on) it throws, and the commit is rejected because the check cannot run:
// an unreadable list must not be taken for an empty one, or the exemptions the user wrote would be blocked again for no visible reason
function ignoredEntries(root) {
  const file = join(root, '.gitleaksignore');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new Error(say().cannotRead(printable(file), error.code ?? error.message));
  }
  const entries = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length === 3) entries.add(`${posix.normalize(parts[0].replaceAll(BACKSLASH, '/'))}:${parts[1]}:${parts[2]}`);
  }
  return entries;
}

// Whether the main repo takes this path
const mainAllows = (path) => MAIN_ALLOWED_FILES.includes(path) || MAIN_ALLOWED_DIRS.some((dir) => path.startsWith(dir));

// Why a staged file cannot be committed: { path, reasons, outside, tooBig } | null. Several reasons go on the same line, and a file only ever takes one line
function problemOf(mode, path, bytes) {
  const outside = mode === 'main' && !mainAllows(path);
  const tooBig = bytes > MAX_FILE_BYTES;
  if (!outside && !tooBig) return null;
  const reasons = [];
  if (outside) reasons.push(say().reasonOutside);
  if (tooBig) reasons.push(say().reasonTooBig((bytes / MIB).toFixed(1), MAX_FILE_BYTES / MIB));
  return { path, reasons, outside, tooBig };
}

// The lines for files that cannot be committed: one line of explanation, one line per file, then a how-to depending on the case
function problemLines(problems) {
  if (problems.length === 0) return [];
  const lines = [say().problemsHeader, ...problems.map(({ path, reasons }) => say().problemLine(printable(path), reasons))];
  if (problems.some((problem) => problem.outside)) lines.push(say().outsideHint([...MAIN_ALLOWED_FILES, ...MAIN_ALLOWED_DIRS]));
  if (problems.some((problem) => problem.tooBig)) lines.push(say().tooBigHint);
  return lines;
}

// The environment of the gitleaks child: this process's environment, with GITLEAKS_GIT_CONFIG appended to the end of GIT_CONFIG_PARAMETERS (when there was no such variable it is just these items),
// everything else inherited as it is
function gitleaksEnv() {
  const before = process.env.GIT_CONFIG_PARAMETERS;
  return { ...process.env, GIT_CONFIG_PARAMETERS: before ? `${before} ${GITLEAKS_GIT_CONFIG}` : GITLEAKS_GIT_CONFIG };
}

// String comparison for sorting: compares the strings directly and ignores the system's language settings, so the same report sorts the same on every computer
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The order of findings: file, line, rule
const byPlace = (a, b) => byText(a.file, b.file) || a.line - b.line || byText(a.rule, b.rule);

// The findings in gitleaks' JSON report: [{ file, line, rule }], sorted by file, line, rule; null when it cannot be parsed (not JSON, not an array, or an entry lacks these three).
// Only these three are taken: fields such as Match, Secret and Line can hold the matched original text
function findingsOf(report) {
  let parsed;
  try {
    parsed = JSON.parse(String(report ?? ''));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const findings = [];
  for (const item of parsed) {
    if (typeof item?.File !== 'string' || !Number.isInteger(item.StartLine) || typeof item.RuleID !== 'string') return null;
    findings.push({ file: item.File, line: item.StartLine, rule: item.RuleID });
  }
  return findings.sort(byPlace);
}

// The log gitleaks writes to stderr: color control sequences and empty lines removed, each line indented by two spaces. The errors hold file names from the repo, so each line goes through printable
function logLines(stderr) {
  return String(stderr ?? '')
    .replace(COLOR_SEQUENCE, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => `  ${printable(line)}`);
}

// What is said when the scan could not finish, followed only by gitleaks' log. stdout is not attached: it is the report, which can hold the matched original text
function scanFailed(reason, { stderr }) {
  return [say().scanFailed(reason), ...logLines(stderr)];
}

// The result of one gitleaks scan: { findings: [{ file, line, rule }], log } (an empty array when there are no findings, and log is its log), or { failed: what to tell the user } when the scan could not finish.
// Exit code 0 means no findings. LEAKS_EXIT_CODE means suspected secrets were found: read the JSON report it wrote to stdout; a report that cannot be parsed, or has no finding at all, is said to be a scan that could not finish.
// Not installed has a sentence of its own; any other start failure, being killed by a signal, or any other exit code (including the 1 when gitleaks fails itself) is said to be a scan that could not finish. Everything except no findings is rejected.
// An ERR-level line in the log (stderr) is also said to be a scan that could not finish, whether the exit code is 0 or secrets were found: some gitleaks failures (git log or git diff failing, files that cannot be read and so on)
// only log one ERR line and still exit with 0 saying "no leaks found" (measured with 8.30.1); an ERR together with found secrets means this scan was not complete and the findings listed may not be all.
// Both scans (scanStaged and scanMarkedText) come through here, and this rule exists only here
function outcomeOf(result, platform) {
  if (result.error?.code === 'ENOENT') {
    return { failed: [say().gitleaksMissing(GITLEAKS_HINTS[platform] ?? say().genericInstall)] };
  }
  if (result.error || (result.status !== 0 && result.status !== LEAKS_EXIT_CODE)) return { failed: scanFailed(failureOf(result), result) };
  if (ERROR_LINE.test(String(result.stderr ?? '').replace(COLOR_SEQUENCE, ''))) {
    return { failed: scanFailed(result.status === 0 ? say().logErrorExit0 : say().logErrorLeaks(LEAKS_EXIT_CODE), result) };
  }
  if (result.status === 0) return { findings: [], log: result.stderr };
  const findings = findingsOf(result.stdout);
  if (findings === null) return { failed: scanFailed(say().reportUnreadable(LEAKS_EXIT_CODE), result) };
  if (findings.length === 0) return { failed: scanFailed(say().reportEmpty(LEAKS_EXIT_CODE), result) };
  return { findings, log: result.stderr };
}

// gitleaks scans the staged changes (the ones git diff can show the content of).
// For the child's environment see gitleaksEnv: GITLEAKS_GIT_CONFIG is appended to the end of GIT_CONFIG_PARAMETERS, so it still scans when the user's git config makes the diff show no content.
// Without --verbose (measured with 8.30.1): the Finding it prints is the whole regex match, and --redact only masks the Secret of that finding itself. The multi-line curl rule
// (curl-auth-user) brought out the value of the X-API-Key on the next line as it was, and the generic-api-key rule can also bring out a complete GitHub token on the same line.
// --redact is still given, as one more layer. --no-color: the log has no color (when --verbose was given, it also kept the Finding line free of the 20 characters of original text before and after)
function scanStaged(run, root, work, platform) {
  const argv = [
    'gitleaks', 'git', '--pre-commit', '--redact', '--staged', '--no-banner', '--no-color',
    '--exit-code', String(LEAKS_EXIT_CODE), '--report-format', 'json', '--report-path', '-', root,
  ];
  return outcomeOf(run(argv, { cwd: work, env: gitleaksEnv() }), platform);
}

// .gitleaks.toml in the repo root: its path when there is one, null when there is not. The first scan has gitleaks find it in the repo root itself, and the second scan's scanned directory is the temporary directory, so --config has to point to it.
// A failure to read that is not ENOENT (no permission and so on) throws: it must not be quietly left out, or the rules the repo wrote itself would not take effect
function repoConfig(root) {
  const file = join(root, '.gitleaks.toml');
  try {
    return statSync(file).isFile() ? file : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(say().cannotRead(printable(file), error.code ?? error.message));
  }
}

// The second scan, of text marked binary or -diff (see the start of the file), with the same return value as scanStaged. changes is the staged changes and sizes is their byte counts (change -> bytes).
// The staged content of the marked ones is read: those over MAX_FILE_BYTES are not read (they cannot be committed anyway), those with a NUL in the first FIRST_FEW_BYTES bytes are real binaries and are not scanned,
// the rest are written to <work>/blobs/tree/<path>, gitleaks dir scans the relative path blobs in work, and the paths in the report are blobs/tree/<path>, which with the prefix removed is the form in the repo
// (see TREE_DIR for why there is an extra tree/ level).
// When the repo root has a .gitleaks.toml, --config points to it so that the rules the user wrote apply to these files too; when there is none it is not passed, so no staged copy in the scanned directory is read as config.
// Without --gitleaks-ignore-path (measured with 8.30.1): in dir mode the ignore list is matched against blobs/tree/<path>, so <path>:rule:line as written in the repo does not match,
// and it would take entries starting with blobs/ to be those of these copies (when the repo happens to have files under blobs/, the entries for those files would release other files), so the list is filtered by the repo path here (ignoredEntries).
// An ERR-level line in the log is said to be a scan that could not finish, see outcomeOf
function scanMarkedText(run, root, work, platform, changes, sizes) {
  const candidates = changes.filter((change) => FILE_MODES.has(change.mode));
  const marked = markedFiles(run, root, work, candidates).filter((change) => sizes.get(change) <= MAX_FILE_BYTES);
  const treeDir = join(work, BLOBS_DIR, TREE_DIR);
  let written = 0;
  forEachBlob(run, root, work, marked.map((change) => ({ blob: change.blob, bytes: sizes.get(change), path: change.path })), (item, content) => {
    if (content.subarray(0, FIRST_FEW_BYTES).includes(0)) return;
    writeBlob(treeDir, item.path, content);
    written += 1;
  });
  if (written === 0) return { findings: [] };
  const config = repoConfig(root);
  const argv = [
    'gitleaks', 'dir', '--redact', '--no-banner', '--no-color',
    '--exit-code', String(LEAKS_EXIT_CODE), '--report-format', 'json', '--report-path', '-',
    ...(config === null ? [] : ['--config', config]), BLOBS_DIR,
  ];
  const outcome = outcomeOf(run(argv, { cwd: work, env: gitleaksEnv() }), platform);
  if (outcome.failed || outcome.findings.length === 0) return outcome;
  const ignored = ignoredEntries(root);
  const found = [];
  for (const item of outcome.findings) {
    // The paths in the report should all be under blobs/tree/; if one is not, this report cannot be trusted
    if (!item.file.startsWith(TREE_PREFIX)) return { failed: scanFailed(say().reportUnreadable(LEAKS_EXIT_CODE), { stderr: outcome.log }) };
    const file = item.file.slice(TREE_PREFIX.length);
    if (!ignored.has(`${file}:${item.rule}:${item.line}`)) found.push({ ...item, file });
  }
  return { findings: found };
}

// The findings of the two scans merged into one list: one entry for the same place (file, line, rule), sorted by file, line, rule.
// The same file is sometimes found by both scans: git diff looks at the .gitattributes in the working tree, and the second scan also looks at the one in the index
function mergeFindings(...lists) {
  const byPlaceKey = new Map();
  for (const item of lists.flat()) byPlaceKey.set(`${item.file}${NUL}${item.line}${NUL}${item.rule}`, item);
  return [...byPlaceKey.values()].sort(byPlace);
}

// The lines for suspected secrets: one line of explanation, each finding listed only as "file:line  rule" with no content, then the how-to line, which takes the first finding and shows how it would be written in .gitleaksignore as an example
function leakLines(findings) {
  if (findings.length === 0) return [];
  const [first] = findings;
  return [
    say().leaksFound,
    ...findings.map(({ file, line, rule }) => `  ${printable(file)}:${line}  ${printable(rule)}`),
    say().leaksHint(`${printable(first.file)}:${printable(first.rule)}:${first.line}`),
  ];
}

// Scans the staged changes for secrets and returns what to tell the user (empty when it passes): scanStaged first, then the second scan of text marked binary (scanMarkedText),
// and what both found goes into one list. When the first scan could not finish (gitleaks not installed, gitleaks failing) there is no second scan and only its message is given;
// when the first scan found something and the second could not finish, what was found is listed first, then the second scan's failure. Everything except no findings is rejected
function scanSecrets(run, root, work, platform, changes, sizes) {
  const staged = scanStaged(run, root, work, platform);
  if (staged.failed) return staged.failed;
  const marked = scanMarkedText(run, root, work, platform, changes, sizes);
  return [...leakLines(mergeFindings(staged.findings, marked.findings ?? [])), ...(marked.failed ?? [])];
}

// Finishes the check in the temporary directory work: first the staged files (does the main repo take them, how big are they), then the gitleaks scan
function inspect({ mode, root, work, run, platform }) {
  const changes = stagedChanges(run, root, work);
  const sized = changes.filter((change) => BLOB_MODES.has(change.mode));
  const sizes = new Map(blobSizes(run, root, work, sized.map((change) => change.blob)).map((bytes, i) => [sized[i], bytes]));
  const problems = changes.map((change) => problemOf(mode, change.path, sizes.get(change) ?? 0)).filter((problem) => problem !== null);
  const lines = [...problemLines(problems), ...scanSecrets(run, root, work, platform, changes, sizes)];
  return { ok: lines.length === 0, lines };
}

// checkCommit({ mode, cwd, run, platform }) -> { ok, lines }. mode is 'main' or 'component';
// cwd is the repo root (taken by pre-commit and passed in as a command-line argument), only used to point git -C and gitleaks at the repo; the child processes' own working directory is the temporary directory.
// lines is what to tell the user, in order: the files that cannot be committed and what to do, the gitleaks result, the line about a temporary directory that was not deleted. When ok is true only the last line can be there.
// When the check cannot run (wrong kind, wrong root, no temporary directory, git failing or output that cannot be parsed) it throws: that must not be taken as no problem and let through
export function checkCommit({ mode, cwd, run = defaultRun, platform = process.platform }) {
  if (mode !== 'main' && mode !== 'component') throw new Error(say().unknownKind(printable(String(mode))));
  const root = repoRoot(cwd, platform);
  const work = makeWorkDir();
  let outcome;
  try {
    outcome = inspect({ mode, root, work, run, platform });
  } catch (error) {
    // The temporary directory is deleted all the same; the line for one that cannot be deleted is appended after the error
    const leftover = removeWorkDir(work);
    if (leftover !== null && error instanceof Error) error.message = say().withLeftover(error.message, leftover);
    throw error;
  }
  const leftover = removeWorkDir(work);
  if (leftover !== null) outcome.lines.push(leftover);
  return outcome;
}

// Paths and gitleaks output are written by people in the repo, show up in the output and get into Claude's context: control characters such as newlines are shown as ?, so a file only ever takes one line;
// bidirectional text control characters (U+202A-U+202E, U+2066-U+2069) are also shown as ?, so that text cannot be displayed reversed to look like something else.
// The range: C0, DEL, C1, the line and paragraph separators that YAML also treats as newlines, plus the bidirectional text control characters (the same as the copy in the secrets vault hook)
function printable(text) {
  let shown = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    shown += control || bidi ? '?' : ch;
  }
  return shown;
}

// Exit code: 0 lets the commit through, 1 rejects it. An error in the check itself (no repo root, git failing and so on) also rejects it and never lets it through.
// Everything to say is written to stderr, which git shows as it is to the person committing; there can also be a line when the commit passes (a temporary directory that was not deleted)
function main() {
  try {
    const { ok, lines } = checkCommit({ mode: process.argv[2], cwd: process.argv[3] });
    if (lines.length > 0) process.stderr.write(`${lines.join('\n')}\n`);
    return ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${say().checkFailed(printable(error instanceof Error ? error.message : String(error)))}\n`);
    return 1;
  }
}

// Entry check: only checks when run as a script. pre-commit calls it with node ./check-commit.mjs <main|component> <repo root>, and process.argv[1] is this file.
// When another program imports it nothing happens, even if that process's first argument happens to be main or component: Wellyard's command-line entry imports it
// (init reads which files the main repo takes when it makes its plan), and wellyard main must not run a commit check.
// Only the file name is compared, not the full path against import.meta.url: on Windows 8.3 short names, directory junctions and case would make the paths not match, and then the hook would check nothing.
// basename of node:path accepts both slashes on Windows
const runAsScript = basename(process.argv[1] ?? '') === 'check-commit.mjs';
if (runAsScript && (process.argv[2] === 'main' || process.argv[2] === 'component')) process.exitCode = main();
