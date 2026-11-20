# plugin

<!-- wellyard:component v1 sha256:e40d7fd4a5485c43acb8feb3c94dad835ad25ee550b04618b40bf647e544cd1f -->
这个仓库是产品 poundlock 的组件 plugin（类型 plugin），由 Wellyard 管理。产品层面的事（组件表、环境、决定）写在主仓库 poundlock 的 CLAUDE.md；IP、端口、登录用户名这类敏感的环境信息只写在那里，不写进这个仓库：它以后可能开源。
<!-- /wellyard:component -->

agent-team：一个 Claude Code 插件，十角色的软件开发 agent team。项目经理（`at-pm`）就是主会话，沿阶段链 `S1`→`S8` 分层派发，执行顺序由 hook 门禁强制，业务验收独立成线。默认分支 `main`。

这份文件只记读代码和 git 历史推不出来的事。拿它当线索；与实时的 Git、测试或文件状态冲突时，以实时证据为准。

## 环境要求

- 零 npm 依赖，不建 `package.json`。运行时的前提只有 PATH 上的 Node，下限是 `hooks/boot.mjs` 的 `MIN_NODE`；门禁用的是 Claude Code 启动时 PATH 上的那个 Node。
- 推送 GitHub 要本机 `gh` 已登录；凭据在系统 keyring 里，不进仓库。仓库地址、安装命令里的地址、只在某台电脑上成立的事，都记在主仓库 `CLAUDE.md` 的「环境」一节。
- `AGENT_TEAM_GATE_TRACE`（可选）：等于 `1` 时每道门禁每次 `exit 0` 往 stderr 留一行痕，默认关。`--bg` 会话必须经 `--settings` 的 `env` 传入，在 shell 里 export 传不到 hook（实测）。判读见 `docs/00-现行参考.md` §1，来历在 `docs/21`。
- `CLAUDE_PLUGIN_ROOT` 由 CLI 注入，插件内部路径都从它解析，不用手动设。

## 构建

没有构建步骤。开发期加载不用装：`claude --plugin-dir <本仓库路径>`。

## 测试

- 在仓库根裸跑 `node --test`，不带路径参数；带路径参数会报出一个假的 `pass 0 / fail 1`。
- 判据总数以 `node --test` 的实时输出为准，不往文档里抄数字，写下来的数字会漂。
- `.github/workflows/ci.yml` 在三个系统上跑全部判据；`.github/workflows/min-node.yml` 把门禁子进程换到 `MIN_NODE` 上跑全部判据，Linux 上再用真的 Node 12.17 / 12.22 确认 `boot.mjs` 大声拒绝。
- 仓库里不要建 `scratchpad/`：它进了 `.gitignore`，但 `node --test` 照样递归收它下面的 `*.test.mjs`。

## 部署

这一节自包含：发布这个插件只要照这里做。

- 形态是 Claude Code 插件，不部署任何服务、不监听任何端口。**推 `main` 就是发布**：用户在自己的项目目录下经 `claude plugin marketplace add <仓库> --scope local` 与 `claude plugin install agent-team@agent-team-marketplace --scope local` 安装，`<仓库>` 的写法在 README 的「安装」里，也记在主仓库 `CLAUDE.md` 的「环境」一节。
- 当前版本以 `.claude-plugin/plugin.json` 的 `version` 为准。
- **每次推 `main` 都挪 `version`**：只碰散文 / `docs/` / `tests/` 挪最后一位，碰插件会加载的东西挪中间一位，任何一位不长到 `10`。理由：`claude plugin update` 比的是 `version` 字符串，不是 commit。「插件会加载的」清单的单一真源是 `scripts/lib/version-bump.mjs` 的 `PLUGIN_LOADED`。
- 每挪一次，在 `CHANGELOG.md` 最上面加一行「- x.y.z：这一版改了什么」，版本检查核它。
- CI 在推 main / 向 main 提 PR 时跑 `scripts/check-version-bump.mjs`。main 没开分支保护，所以那是**事后**告警：先推功能分支、等 CI 全绿，再合进 main 推送。推之前本地自查：`node scripts/check-version-bump.mjs origin/main HEAD`。
- 推 main、判据与版本检查都过了之后，`ci.yml` 的 `tag` 作业跑 `scripts/tag-release.mjs`：每一版的 tag（`v` 加版本号）打在 main 的 first-parent 历史上 `plugin.json` 第一次是它的那个提交，缺的都补上，已有的不挪。同一个作业接着跑 `scripts/github-release.mjs`，给 3.3.1 起缺 GitHub Release 的各版建一条，正文是 `CHANGELOG.md` 那一行；tag 不在远端或指向别处的不建，已有的不动，打 tag 那一步红了也跑；3.3.1 之前的各版不补（`docs/52`）。
- 作业补不上的 tag：指向的提交带着与 `main` 现在不同的工作流文件时，Actions 自带的凭据推不了它，作业会红。要有 `workflow` 权限的人在本地跑 `node scripts/tag-release.mjs --push`（不带 `--push` 只列不打）。
- M4l 起工作流的 push 只认分支，推 tag 不触发 CI；M4l 之前的提交里的工作流不认这一条，一次推三个以内的 tag 会起 CI。理由在 `docs/47` 与它的订正。
- 回滚没有单独的动作：`claude plugin update` 比的是 `version` 字符串，所以退回旧内容也要照纪律挪一版新的 `version` 再推。

## 常用命令

```sh
node --test
```

- 开发期加载：`claude --plugin-dir .`
- 打开门禁留痕：`claude --settings '{"env":{"AGENT_TEAM_GATE_TRACE":"1"}}'`
- 推 main 之前自查版本号：`node scripts/check-version-bump.mjs origin/main HEAD`
- 看 CI：`gh run list --branch <分支>`、`gh run view <id> --log-failed`

## 文档怎么找

- 活文档只有两份，直接改：`docs/00-开放边界.md` 是还开着什么的索引，每条指向记它的那一节，关上一条就从这里删掉、收口写在原话底下；`docs/00-现行参考.md` 记会变的现行事实（门禁留痕的判读表、Claude Code 的下限），判据对着代码与 README 核。
- 遗留项不再从索引逐条挑：照 `docs/91` 的处置裁定与实测清单做，跑完实测再修补回归。维护者能跑的那几场结果在 `docs/92`，交给用户的两场与两场拒绝路实测在 `docs/93`、`docs/94`。
- `docs/11-M1b-遗留与已知边界.md` 是已知边界登记簿；`docs/16-M2b-裁定记录.md` 是裁定记录，它的 §3 是方法论语料。
- `docs/13` 往后是带日期的实测记录。`docs/24` §5 是 2026-09-28 那次全量审查的冻结表，之后的现状写在它前面那串「更新」里；`docs/39` 是 2026-10-05 对照 v2.2.0 的逐条核验与排序，它排的六轮到 `docs/48` 做完。
- `stages.produces.md` 是 at-resume 与 at-status 运行时让模型读的；`stages.README.md` 只给维护者（理由、消费方表、开发史）。
- 带日期的记录里出现的提交号、老仓库地址和安装命令说的是迁移之前的事，原样保留、不改。

## 决定

每条是结论，理由与口径细节在所指的 `docs/` 与代码注释里。

### 工程纪律

- **零 npm 依赖，不建 `package.json`。**
- **`hooks/` 下的代码不用晚于 `MIN_NODE` 的内建；`boot.mjs` 还要能在 Node 12.17 上解析**（不用顶层 await、`?.`、`??`、`Object.hasOwn`，内建模块写 `'fs'` 不写 `'node:fs'`）：好在旧 Node 上大声拒绝，而不是静默放行。门禁子进程一律经 `tests/helpers/gate-runner.mjs` 起（`tests/gate-runner.test.mjs` 钉着），最低版本作业才换得动它们。`docs/28`。
- **门禁专属文件的算法或格式变了，不许让同一份磁盘状态被改判**：进行中的 run 升级之后照旧能接着跑，新记的带版本标记、旧的照旧口径算（例子在 `docs/90`），配一条「上一版状态的夹具」判据。收紧门禁本身（新判据拦下以前放过的写法）不在此列。`docs/91` §1。
- **`docs/11` §1–§4 原文一字不改，只追加 §5.x；带日期的实测记录正文不改**，订正与收口写在旁边，而且写在原话的标题底下——只在新一节里指称它的收口，扫标题的人读不到。
- **活的事实不写进带日期的记录**：要对着代码核的说明与数写在 `docs/00-现行参考.md`，还开着什么写在 `docs/00-开放边界.md`（`docs/15` 起每一份记录的「仍然开着的边界」「没量到的」这类小节都要在那里有一行，`tests/open-index.test.mjs` 钉着）。判据逼着改一份带日期的记录，就是那件事该挪出来了。`docs/48`。
- **一条注释不是一条判据。** 要防的事配判据；写不出来就照 `docs/16` §3 开头那条付三样：拒绝的判据长什么样、它打不红的那一刀、什么会让答案改变。
- **`docs/` 之外不写裁定编号**，写裁定的名字（注释与判据里撞过号）；`tests/hygiene.test.mjs` 钉着。`docs/` 下带日期的记录原样引用编号，判据不扫。
- **列举，不报总数**（`docs/16` §3.1）。失效条件写成可观测状态或归属规则，不写成要人去数的阈值。
- **找缺陷靠变异验证，不靠读代码**（`docs/16` §3）。
- **运行时正文只写现行规则。** 模型在运行时读得到的文字——角色正文、命令、skill、模板、`stages.produces.md`、插件的几份配置，以及门禁回传与拒绝理由的字符串——不写开发史（docs 编号、里程碑编号、规格章节号、审查条目号、「上一版写的是」），也不指向 `stages.README.md`。正文指给模型读的插件文件都算插件会加载的。判据是 `tests/runtime-prose.test.mjs` 与 `tests/version-bump.test.mjs`。`docs/48`。
- **README 对外只写结论，不写过程。** 不写「某版本上实测」这类叙述、CLI 版本号和 `docs/` 编号引用；用法、风险与运行前提（Node 与 Claude Code 的最低版本）照写。`tests/readme-sync.test.mjs` 钉着的那几条事实换成不带过程的说法保留。

### 角色与工具面

- **任何角色都不授予 `Skill` / `SendMessage` / `ListAgents`。** frontmatter 的 `skills:` 键是另一回事，允许，一律写全名 `agent-team:at-*`（裸名会被用户或项目层的同名 skill 抢先，实测在 `docs/97` §3）。插件自带的 skill 不得声明 `context: fork`。外部的设计方法只改写进自己的 skill（`at-ui-craft`，声明在 `THIRD_PARTY_NOTICES.md`），不跨插件引用（`docs/97` §1）。
- **`at-outsider` 永远不进任何角色的 `Agent(...)` 宇宙，也不进任何 `can_delegate_to`。**
- **主线程的 `tools:` 只封顶派发宇宙与主会话自己的工具面，不封顶子代理的工具**：每个角色拿自己 `tools:` 里的工具（实测），禁授的三样靠每一份自己的 `tools:` 行（`tests/tool-surface.test.mjs`）。`at-pm` 拿不到用户的 MCP 与网页工具，README 两半写着。验证段的产者（主会话除外）不持 `Edit`——摩擦，不是屏障。插件 `settings.json` 的 `agent` 写全名 `agent-team:at-pm`（裸名会被项目或用户层同名的 `at-pm.md` 抢先当上主会话，`tests/plugin-name-sync.test.mjs`）。门禁按剥前缀的名字认 PM，不收紧。`docs/36`。
- **MCP 只给叶子角色 `at-ui`，而且只到官方插件市场 Playwright 插件的具体工具**：只列看页面要的那几个（打开、改尺寸、模拟媒体特性、截图、快照、关浏览器），不授整台服务器，执行脚本、上传文件、拖放、对话框不给，持 `Agent` 的角色不给；`WebSearch`、`WebFetch` 谁都不给。用户没装那个插件时名字静默不在、角色照常起（实测）。截图与快照落在项目根的 `.playwright-mcp/`，写路径隔离与账本看不见：只开本机起的页面、不带 `filename`、在记录里列出、用完关浏览器都靠正文，门禁不核（付了三样）；`at-qa` 审改动时跳过那个目录。`docs/98`。
- **用户的 skill 只经登记、复制进项目、当文件读**：`/agent-team:at-skills` 经 `hooks/skills-cli.mjs`（项目经理用 `Bash` 调，不是门禁）把本机的 skill 整份复制进 `.agent-team/skills/`、记进 `.agent-team/skills.json`；角色照正文「登记给你的 skill」一节读来用，仍然不授 `Skill`。登记的 skill 在做法上盖得过插件自带的，管不了做什么，盖不过门禁与红线、要交哪几份、下游要读的项、读文件与截图的开销规矩；点名只认契约里用户的话。新版只在起新一趟、建 run 之前比对，变了问用户、`sync --update` 才换，一趟进行中与续跑都不换。副本目录一律由名字推出、不信清单里的 `dir`；skill 里的软链接与会被自动加载的位置不复制。角色正文不写 `${CLAUDE_PLUGIN_ROOT}` 以外的占位符字面，也不拿它当「skill 里的那个占位符」说——平台会把正文里的它换成本插件的目录。`docs/102`。
- **项目经理只能是主会话，调用者认不出就拒**：`agent_type` 在却不是非空字符串的拒；任何调用者派 `at-pm` 一律拒；受管辖的派发带非空 `name`（agent teams 的 teammate）拒，与 `isolation` 同形。主会话被设置里别的 agent 或启动时的 `--agent` 换掉时，自检与几道门禁的拒绝理由末尾都说清身份与出路。还没有 run 时 H3 对谁都放行，那是 at-init 自举的既有设计。`state.json` 里的角色名写裸名。`docs/44`。
- **插件自带的 frontmatter 只用受限写法**：每个非空行恰好一行 `key: 值`，键不重复，值不以 YAML 指示符开头、不含「: 」与「 #」、不以「:」结尾、首尾没有空白、不是会被读成 null / 布尔 / 数字的那几种，行里没有制表符与 `---`。挡的是会让平台的 YAML 解析器与按行读的判据读出不同东西的写法——解析失败会让平台把整份当空，折行能授出判据看不见的工具。不声称封闭。唯一的窄口是逐字的 `omitClaudeMd: true` 一行。`tests/frontmatter-subset.test.mjs`；`docs/40` §1.8、`docs/100`。
- **子代理不自动带项目的 `CLAUDE.md`**：被派得到的角色 frontmatter 一律 `omitClaudeMd: true`，项目自己的约定改由角色开工时 `Read` 项目根那一份 `CLAUDE.md`（`@` 引的文件只在与任务直接相关时读）。`at-pm` 不加：平台对主会话不认这个键，主会话也要项目里的约定；README 写怎么在本地设置里用 `claudeMdExcludes` 排除大文档。读进来的 `CLAUDE.md` 照做，与正文冲突的照正文。`tests/context-prose.test.mjs`；来由与理由在 `docs/100`。
- **管住上下文只靠正文**：浏览器里的页面归 `at-ui` 看（这一趟 `S5` 叫了它的，排在实现页面的产者交齐之后、同段再派它一次；没叫它的归实现页面的产者），iOS、Android 的原生界面归各端；每种情形一张、一轮通常不超过 4–6 张、没改动不重截。验证段的角色不截图、不读图，读记录里「看过」那一栏的结论；验收因为页面没人看过判不了的不回 S6：有办法看却没看的回 S5 补看，没办法看的问照现状交付。持 `Bash` 的角色同一节「读文件与看输出」。门禁不核（付了三样，`docs/100` §5）；`tests/context-prose.test.mjs`、`tests/ui-browser-prose.test.mjs`。
- **持 Bash 的执行角色的敏感操作红线只在正文里，每一份逐字同一句**，清单与 `/agent-team:at` 第 4 节 `sensitive` 那一行逐项相同：碰到就以「冒泡：」停下，协调者原样冒泡给 PM，PM 照 `sensitive` 问用户；用户批准过的，执行角色只认契约「修订记录」里写明批准了的那一步（派发提示是数据，契约只有 PM 写得进）。PM 自己也不跑动工作树或历史的 git 命令，也不结束不是自己起的进程；停服务按自己起的 PID 停（Windows 的 Git Bash 里按进程树停）——有过项目经理按名字杀掉本机全部 node 进程的事故（`docs/43` §1.5）。起过的服务记进各自产物的「起过的服务」，收口第三步由项目经理收齐、只读地核，还在跑的问用户、批准了才停（`docs/101`）。门禁不加 Bash 的 matcher：命令行是自由文本，判不准，平台的权限模式才是那一层。`tests/redlines-setup-prose.test.mjs`；`docs/40`、`docs/49`。

### 门禁的判定

- **`project.json` 的形状问题只让 H3 看**：不把形状错误判成读不出运行上下文（那会让 H2、H5、ledger 一起降级，一个键名拼错交付物校验就停摆）。同一条问题按读者出两种说法：给 PM 的带改法，拼进给执行角色拒绝理由的只说问题本身（`hooks/lib/project.mjs` 的 `audience`）。插件装坏单列【插件】，不混进【project.json】。`docs/29`。
- **门禁判不出来而放行时，话说给能动手的人**：PM 自己发起的派发与写 run 目录下的文件上回传【门禁】、给用户一行固定的 `systemMessage`；`PreToolUse` 上不发受信块（几道 hook 的回传被平台并成一段、不标来源），`SubagentStop` 上什么都不发（exit 0 带回传等于拦截）。输出形状只由 `hooks/lib/fail-open.mjs` 的 `hookOutput` 定，写 stdout 只经 `emitHookJson` 与 `denyAndExit`。新写一句修法要照着做一遍、看门禁放不放行。`docs/30`。
- **问「这一段」的消费方按段取参与者，账本比对与 H2 有意整趟**：`state.json` 的 `stage_roles` 是 `roster` 按段拆开，PM 在推进出那一段的同一次 Write 里记；按段的消费方经 `hooks/lib/stages.mjs` 的 `participantsOf` 取。`compareArtifacts` 与 `decideReadiness` 仍传整趟 `roster`：当前段记账之前按段取是空集，前者漏报漂移、后者提前放行。新的一趟漏写 `stage_roles` 会被当成旧 run，所以 H6 在建 run 那一次拒。`state.json` 里认不出的键由 `validateState` 报，只报不拦；已知键的单一真源是 `hooks/lib/state.mjs` 的 `STATE_KEYS`。`docs/32`、`docs/78`、`docs/55`。
- **返工轮靠回退那一刻的快照认上一轮的产物**：`state.json` 的 `rework_base`（产物名对 sha 或 `"accepted"`）由回退那一次写入照磁盘记；磁盘内容与它记的 sha 相同就是上一轮的。交没交、齐没齐的判据都经 `hooks/lib/freshness.mjs`（`tests/freshness-call-site.test.mjs` 钉着调用点）。接受原样要显式标 `"accepted"`，不许删条目；推进把关放在 H6，不靠事后回传。不用 mtime 与 `history.at`。`docs/33`。
- **返工到上限之后的批准由门禁记，不由 PM 写**：用户经规范标签「再返工一轮：回到 <段>」批准（`AskUserQuestion` 单选，或对话里单独发这一句），两个记录器只在那一刻真会越限时往 `runs/<id>/approvals.jsonl` 追加一行；上限 = 3 + 覆盖那一段的批准条数，`hooks/lib/budget.mjs` 是标签、上限与预判的单一真源。不记回退的重做按交付快照（`delivered.json`）判「交过」（`hooks/lib/redo.mjs`）。两份都是门禁专属文件，H3 对任何人的 Edit / Write 都拒。`docs/34`。
- **收口由门禁核、之后冻结；返工轮里验证段的产物一律重新出**：`state.json` 的 `closed_at` 是收口标记，「收没收口」只问 `hooks/lib/closing.mjs` 的 `closedAt`；`history` 的 at 与它照门禁给的时间写（`docs/93`）。收口那一次 H6 核最后一段的前置与产物；已收口之后 `closed_at`、`stage`、`history` 的条数不许再改，H2 拒派一切团队角色，交付之后的新改动另起一趟。收口时不拦「还有派发在跑」（中断的子代理永远没有停下行），收口之后写 `state.json` 时账本列出门禁没见停下的派发（`docs/56`）。`"verifies": true` 的段（S6、S7、S8）的产物不许在 `rework_base` 里标 `"accepted"`。只有空白的产物不算交了，各处共用 `text-norm.mjs` 的 `isBlankText`——只改一处，出路就互相打架。`docs/35`。
- **根级文件共列，不加 `shared` 键**：根级清单、构建配置、顶层测试目录列给每个会改它们的 S5 产者；S3 的「落盘清单」与 S4「照清单补 `paths`」是对齐的那一步。S5 被拒的在实现记录里留「被写路径隔离拒绝」一节、标「已解决」。规格段的产者被拒时按当前段给出路——写进这一段的产物、不补 `paths`（`docs/54`）。要改同一份文件的执行角色由架构师先后派，门禁不强制串行（「还在跑」只能按停下行认，中断的子代理会让门禁一直拒）。`docs/36`、`docs/51` §1.2。
- **冒泡的出口由门禁认，不改「交没交」**：H5b 在子代理已经被拦过一回、最后一条回复的第一行以「冒泡：」开头时放它停下（`hooks/lib/deliverable.mjs` 的 `isBubbleStop`，标记的单一真源是 `BUBBLE_MARK`）；这一段的产物照旧算没交。拒绝文案只许诺门禁认的出口——一句给出路的文案，要先问门禁认不认它。`at-qa` 的没开跑是冒泡，不写 `06-test.md`。auto 权限模式下子代理经 `SubagentHandback` 交回，H5b 那一道判定挪到交回之前，拒了交回就没发生。`docs/37`、`docs/38`、`docs/99`。
- **契约的账只认 `contract_sha`**：账本比对不看契约；派发返回与 PM 写 `state.json` 时拿 `contract_sha` 比磁盘，对不上出【契约】——不报磁盘上算出来的值、不说「改成与磁盘一致」（照着磁盘改账就把漂移洗成了合法），合法修订的新值只从写契约那一次的回传来。H2 派验证段的产者之前也比一遍，对不上就拒（读不出契约不拦、留痕，`docs/60`）；推进出第一段那一次 H6 要这次写入的 `contract_sha` 与磁盘上的契约对得上（`docs/63`）。`docs/37`。
- **推进由 H6 在推进那一次核：一次只推一段、离开的那一段要交齐**（`hooks/lib/advance.mjs`）：叫到的产者各自那几份、固定产物都在，空白算没交，`"accepted"` 算交了；「叫到」是写入前后的参与者并上门禁的派发记录，PM 少记一个人翻不成没叫过；`trimmed` 的豁免只限按叫到的人展开产物的段里、不被任何段当前置的那几份。不选只告警：告警到时已经推进了，也拦不住跳段。`docs/38`、`docs/76`、`docs/77`、`docs/89`。
- **交付物核验在子代理真正完成的那一刻做**：H5a 读 `tool_response.status`，后台启动那一刻不判产物；派发记录 `runs/<id>/dispatches.jsonl` 是门禁专属；完成通知到主会话时，UserPromptSubmit 上的 `completion` 按 `agent_id` 对回角色与段、核产物；同一个 `agent_id` 再来一条、结论没变时只说一句（`docs/82`）。UserPromptSubmit 上只有标了 `speaks` 的检查项说话，永不 exit 2。auto 模式下把交回消息当成一条完成通知核（`docs/99`）。`docs/38`。
- **按设计不认领路径的 `at-qa`、`at-acceptance` 只写 run 目录里自己那份产物**：没有 `paths` 键时写路径隔离在 run 目录之外拒；拒绝理由点名它自己那份产物、叫它照实写进那份结论、不用为这个冒泡。不受 `paths` 管的只剩项目经理与主线程（`hooks/lib/decide.mjs` 的 `exemptFromPaths`）。正文说拒，门禁就得真拒，判据同时核两边。`docs/41`。
- **认领一个目录不连带它下面会被自动加载或执行的位置**：认领的前缀之下新出现 `CLAUDE.md`、`CLAUDE.local.md`、`.claude`、`.git`、嵌套的 `.agent-team` 就拒（`hooks/lib/writepath.mjs` 的 `guardedBelow`）；前缀本身写明了的照放行；`.agent-team` 不划给任何角色，写明了也拒。拼出裸仓库布局那一路不按文件名拒，登在 `docs/53` §4。`docs/53`。
- **sha 一律用门禁给的值**：门禁的回传带它按磁盘算的值（先剥 BOM、折 CRLF），PM 照抄、不自己算、不照着磁盘改账。PM 写完 `reach.json`，门禁按当前 `project.json` 与花名册重算核对，每趟开头再核一次；核不了的时候也说一句「这一次没有核」。问用户之前先记一条 `answer` 为空串的 escalation，答复之后补上；用户主动改需求不记 escalation，修订块标「用户主动提出」。`docs/42`、`docs/79`、`docs/83`、`docs/87`、`docs/88`。
- **整段裁掉与切走指针**：缺的前置是整段裁掉的那一段的产物时，H2 说清是整段裁掉、给两条路（回退到那一段补回来，或把要它当前置的段也整段裁掉）；「整段裁掉」在 H2、推进、收口三处同一个口径（`advance.mjs` 的 `wholeStageTrimmed`）。PM 写 `current-run` 时门禁列出别的、没收口的 run 里没停下的派发。停下、完成、再往下派人时按 `agent_id` 认回派它的那一趟（`completion.mjs` 的 `elsewhereRunOf`）。项目经理把契约或阶段产物写进一趟不是 `current-run` 的 run 目录时，账本回传【指针】、按情形给出路。`docs/43`、`docs/49`、`docs/51`。
- **外部值进模型读得到的文字，按值从哪来决定怎么引**：磁盘上谁都写得进的一律 `quote`；调用方自己这次给的参数与由项目根拼出的路径用 `inline`；记录的 sha 用 `shaOrNote`；原样落盘的 JSON 用 `safeJson`。不按「值干不干净」判：一句祈使句不需要任何特殊字符。看不见的字写成码点。那张表在 `docs/27` §2.1，判据是 `tests/trusted-echo.test.mjs`——新拼一个外部值，它的入口清单跟着补。`docs/57`、`docs/59`。

### 契约、测试与收口

- **契约的账由门禁记**：推进出第一段之后门禁第一次见到 `state.json` 时，把契约第 1 节的原文、修订指纹与第 4 节修订块的标题记进门禁专属的 `contract-base.json`（契约自己的四个编号节按结构认，`docs/90`）。改不改需求按这次新加的修订块标题认：`kind:` 全是 `ADMIN_KINDS` 的不算，别的都算，门禁不读内容。第 1 节变了，或验证段的结论是对着上一版契约出的，写契约时【契约】当场说，H6 不放行推进与收口，H2 不把它们当交了的前置（`docs/61`）。改第 1 节不算修订；推进出第一段之前不核。`docs/45`。
- **契约第 1 节对着用户原话核**：`/agent-team:at` 带参数展开时记录器把原话、会话 id、那一刻已有的 run 记进项目一级的 `.agent-team/user-words.json`；只在这个会话用 Write 建出一趟新 run 的 `state.json` 的那一次绑进它的 run 目录，不晚绑（晚绑会跨会话绑错）。绑分两步：H6 只记 `binding`，同一次 Write 落盘之后账本才标 `bound`——H6 那一刻 run 目录还不在、这次写入还可能被用户拒掉，真实会话里这一格坏过（`docs/58`）。比之前折空白、去掉默认不可见的字（`docs/59`）。记录器不拦任何东西、stdout 不写。`docs/50`。
- **需求稿经用户批准才是原话，门禁记题面**：`/agent-team:at` 建 run 之前问清需求，用户在 `AskUserQuestion` 里选规范标签「照这份需求开始」，批准记录器把那道题的题面原样记成原话；那道题要单独问，题面里不许有界面上可能看不见的内容；对话里打字批准不认（门禁看不到批的是哪一份）；要不要测试、没过的测试算不算不主动问；不另加命令。`docs/95`。
- **新行为的自动化测试归 S5 的产者写**：照落盘清单定的位置写，实现记录带「测试」一节；`at-qa` 核缺测试、判「不通过：缺测试」、不写不冒泡；缺测试的回退回 S5。不写测试只认两种情形——这一次没有新行为，或契约第 1 节用户原话、第 4 节修订记录里用户说了不要；被验的一方不能单方面关掉它，所以契约第 3 节、架构方案、派发提示、产品定义都不算。「缺测试」只认两种：一条新行为没有测试、测试碰不到它；断言偏弱、变异没杀死的只进「审查」。变异测试只在契约里用户要了才做。这一趟之前就挂着的用例同一个口径。门禁不读内容。`docs/41`、`docs/67`、`docs/68`、`docs/70`、`docs/72`、`docs/85`、`docs/86`、`docs/100`。
- **收口读验收结论，照现状交付由门禁记**：`07-acceptance.md` 的第一个非空行固定写「结论：通过」「结论：不通过」「结论：判不了」之一（`hooks/lib/verdict.mjs`）；测试报告 `06-test.md` 同一个做法、窄一号，首行写「结论：通过」「结论：不通过」「结论：跑不起来」之一（`hooks/lib/test-verdict.mjs`，`docs/66`）。首行读不出时 H5b 拦产者（`docs/62`）。没过的只有用户经规范标签「照现状交付」批准过才放行，批准按 sha 绑在那一刻的结论上，一份只记一次；它之后的第一次改契约不算改需求——不靠修订块标题里的标记（漏写会绕圈、冒充只要一行字）。`docs/46`、`docs/71`。

### 会话、微调与并行

- **一趟只归一个会话，门禁按会话认**：建 run 的那一次由账本记下主人（`runs/<id>/owner.json`，门禁专属）。主线程对有主人、没收口、主人不是自己的一趟——写它的文件、另建一趟、把 `current-run` 从它切走——H3 拒，以它的名义派人 H2 拒；子代理照旧按派发记录认。`/clear` 会换会话 id（`--resume` 与压缩不换），同一个窗口清空之后要接手一次。接手只认 `AskUserQuestion` 里的规范标签，题面里要原样写着那一趟的 run id。没有 `owner.json` 的旧 run 一切照旧。单一真源是 `hooks/lib/owner.mjs`。`docs/103`；这是边看边改微调那份设计（`docs/superpowers/specs/2026-11-05-边看边改微调与会话归属-design.md`）的第一步。
- **微调是一趟 `mode` 为 `tweak` 的 run，门禁按短链判**（`/agent-team:at-tweak` 起）：`mode` 只认 `"tweak"`，建好之后不许改；写成 `"tweak"` 要有门禁记下的 `/agent-team:at-tweak` 原话记录——不然项目经理写一个 `mode` 就绕开了产品定义与架构。短链是 S1、S4、S5、S6、S8，段号与产物名沿用正常链，没有验收段，收口读测试报告。推出实现段要用户对现在这份契约说过「可以了，收尾」。微调不写 `current-run`。`hooks/lib/tweak.mjs`、`stages.tweak.json`；`docs/104`。
- **并行微调：门禁每一次先挑这一趟**（`hooks/lib/runpick.mjs`）：子代理按派发记录认回派它的那一趟微调，主线程认这个会话名下没收尾的那一趟，都不是照 `current-run`；`gate.mjs` 里读运行上下文只经 `runCtxFor`。互斥在 H6 建 run 那一次判：`current-run` 指着没收口的完整一趟时不能起微调，有没收尾的微调时不能起完整一趟，一个会话同一时刻只有一趟微调。认领（`claims.mjs`）：子代理第一次写一个项目文件，落盘之后记进这一趟的 `claims.jsonl`，别的没收尾的微调再写它 H3 拒；派发时预先认领不做。放弃收尾（`abandon.mjs`）：用户在 `AskUserQuestion` 里选「放弃这一趟」，之后一次写入记 `closed_at` 与 `abandoned: true`，H6 不核产物。前台派发的派发记录跑完才记（实测），所以认不出时按 hook 输入里的会话 id 认。`docs/105`、`docs/106`。

### 几个前提与取舍

- **H5b 修法的前提**：`stop-gate` 只挂在 `SubagentStop` 上、不挂 `Stop`，所以主线程停下从不经过 H5b；带 `at-pm` 身份的 `SubagentStop` 在支持路径上只可能是 CLI 内部分叉。前提的另一半（花名册里没人能派 `at-pm`）由 `tests/roster-closure.test.mjs` 钉着——那条判据变红的那天，就是这个前提失效的那天。
- **门禁留痕选 stderr、默认关**：现成通道（`--debug-file`、`--verbose`、OTel）都说不出是哪一道门禁；stdout 不能用，`PreToolUse` 的拒绝就是 stdout 上的 JSON，前面多一行字就会被当成纯文本。
- **`at-resume` 第 2 节把 `isStageDone` 对空集的答案写了出来，而不是只指回去**：只指不写，项目经理得去读 `hooks/lib/state.mjs` 才知道答案，而第 2 节正是它当场要判的地方。这是同一份知识的第二处，代价由 `tests/commands.test.mjs` 那条两半判据付——正文与 `isStageDone` 任一边单独改都红。
- **门禁的项目根从 cwd 往上找，在启动项目里不越界**：只认 cwd，主线程一 cd 就全开；只认 `CLAUDE_PROJECT_DIR`，用户一 /cd 就看丢别处的 run。两个信号都用。`docs/24` §2.1、§4.1。
- **插件装坏时本会话写不了文件——接受**：另一个方向是门禁整体静默消失；Agent 一侧早有 `roster.json` 读坏一律拒的先例。「什么会让答案改变」写在 `docs/24` §2.2。

## 坑

### 测试与夹具

- **门禁的项目根不是 cwd**：从 cwd 往上找最近的 `.agent-team`（位于某个 `.agent-team` 目录里的不算），cwd 在启动项目（`CLAUDE_PROJECT_DIR`）里时不越过它（`hooks/lib/runctx.mjs` 的 `projectRootFrom`）。子进程测试的环境由 `tests/helpers/gate-runner.mjs` 的 `hermeticEnv` 剥掉 `CLAUDE_PROJECT_DIR` 与留痕开关；要测「变量生效」的用例自己加回来。
- **只在一台机器上成立的假设，CI 一跑就露**：macOS 的 `tmpdir()` 在 `/var` 软链接下，子进程 `process.cwd()` 给的是解析后的路径；GitHub 的 Windows runner 签出在 D 盘；macOS 的 APFS 不收文件名里未分配的码点（`mkdir` 报 ENOENT，`docs/59` §8），载荷当文件名时先去掉它们。夹具一律发 realpath，不写死盘符。还开着的路径别名边角登在 `docs/25` §4。
- **夹具别比真实会话多做一步**：`docs/58` 那个 bug 就是因为子进程判据先建好了 run 目录，而真实会话里项目经理直接 Write `runs/<id>/state.json`。判一件「第一次」发生的事，夹具照真实顺序造。PreToolUse 放行也不等于落了盘（几道门禁并行、用户还能在权限确认里拒），要在落盘之后才成立的事放到同一次写入的 PostToolUse 上做。
- **`hooks/` 下的模块加载时不调会被注入异常的内建**（例如 `String.prototype.normalize`）：失败策略那几条判据往这些内建里注入异常来造「判定中途崩溃」，加载那一步就倒的话 `boot.mjs` 报「门禁代码加载失败」、PreToolUse 一律拒，判据红在别处（`docs/95` §3）。用到时再算。
- 带日期的记录编号到了三位数（`docs/100` 起）：认编号的正则要认两到三位数字，最新一份按数排（按字符串排 `100` 在 `15` 前面）。`tests/open-index.test.mjs` 原来只认两位，`docs/100` 整份被跳过也不红。
- 变异验证用 `cp` 备份与还原，不用 `git checkout` / `git restore`；备份放仓库外。

### 写文件与换行符

- 用脚本往文件里写带转义的文字（反斜杠加 0 这一类）时，落盘后照样扫控制字节——有过一个真的 NUL 字节混进注释。
- **写文件工具（Write / Edit）会把单反斜杠的 Unicode 转义（反斜杠 u 加四位十六进制，比如行分隔符 2028 那一个）换成真字符**：真字符进了正则字面量是语法错误，进了字符串就让判据测的是它自己。特殊字符一律用 `String.fromCharCode` 构造；写完扫一遍原始的行分隔符（`docs/27` §5）。
- **Bash 工具的 heredoc 会吃掉一半反斜杠**：带反斜杠的编辑脚本用写文件工具写，脚本里的反斜杠用 `String.fromCharCode(92)` 构造。`node -e "…"` 的双引号串同样会吃：要写进文件的换行转义会变成真换行（`docs/95` 那一轮在注释与模板串里各撞过一次），写完 `node --check` 一遍。
- **锚串替换不要用 `String.prototype.replace(a, b)`**：`b` 里的 `$'`、`$&` 会被展开成替换模式（`docs/26` §3 就这样把一段文档搅乱过）。用 `split(a).join(b)`，并断言命中次数，还要核对命中的是要的那一处——同一个实参有几处合法命中时，断言防不了砍错的那一刀。
- **换行符**（`docs/11` §5.28）：仓库有 `.gitattributes` 把文本钉成 LF，新克隆、新签出的副本是 LF；已有的工作树里，git 只在改写一个文件时按新规则写它，没碰过的仍可能是 CRLF，`pull`、`reset --hard` 不会把它们改过来。落盘后扫控制字节与行尾混用。扫行尾用 Node 或 `grep -U`：Git Bash 的 grep 不带 `-U` 看不见 CR，会报出假的「全是 LF」（`docs/39` §3）。
- Windows 上装下来的插件副本是 CRLF 时，平台对 frontmatter 的退路在那里不起作用；已装的副本在更新改到那份文件之前仍是 CRLF。

### git 与进程

- **后台 agent 与主会话共用工作树时**，别 `git add -A` / `checkout` / `reset`；要并行就用隔离 worktree。
- `git merge -F -` 不读 stdin（只有 `git commit -F -` 读）；合并说明先写进仓库外的临时文件，再 `-F <文件>`。
- Git Bash 里设了 `MSYS_NO_PATHCONV=1` 之后，传给 node 的 `/c/...` 路径不再被转换，要写成 `C:/...`。
- 子代理写不进 `.superpowers/`（harness 拒绝），它的报告正文要放进返回消息，由主会话落盘。

### Claude Code 平台

- **绝不 `claude plugin enable` / `disable`**：`enable` 接管正在跑的会话，`disable` 不把工具面还回来。插件命令一律写全名 `<插件>@<市场>`；开发机上可能有同名的本机插件，见主仓库 `CLAUDE.md` 的「环境」一节。
- `claude --resume` 不继承 `--plugin-dir`；local 安装下换了目录续会话，工具限制会整体掉光，而转录里看不出来。
- **`agents/at-pm.md` 的 `model:` 不是摆设**：命令行里不带 `--model` 时，项目经理就跑在这一行写的模型上，删掉它会无声地掉回用户的默认模型；桌面应用起会话时总带 `--model`，所以在桌面端看不出来。见 `docs/11` §5.36 的订正。
- **探针目录放在本工作树下时**，`--settings` 里加 `claudeMdExcludes` 排除本仓库与上一层（主仓库）的 `CLAUDE.md`，不然项目经理把它们整份读一遍（`docs/98` 那两场就是）。要看 hook 的原始输入，另挂一个只追加、不写 stdout、永远 exit 0 的记录钩子——门禁的留痕只有检查项名与退出码；做法在 `docs/99` §2.1。
- **后台探针用 `claude --bg`，不用 `-p`**：`-p` 下异步派发卡死过（CLI 2.1.276，`docs/13` §5.1），2.1.286 上一个 `-p` 会话跑完过 5 次异步派发（`docs/33` §3），要靠 `-p` 之前先在当前版本上核。SDK 宿主（`-p --input-format stream-json`）的驱动要等后台子代理跑完再关输入：第一次 result 就关，子代理的权限请求会报 `AbortError: Stream closed`，会话等满 600 秒（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`）后把它杀掉（`docs/35` §4）。
- **探针会话要收尾**：对每个会话先 `claude stop` 再 `claude rm`。没 stop 过的会话在 `~/.claude.json` 里留着 `lastGracefulShutdown: false`，会一直挂在桌面应用侧边栏的「Other」下；`claude rm` 只删 `~/.claude/jobs/<id>/`，转录不动。
- **SubagentStop**（CLI 2.1.286，`docs/37` §1.2）：`stop_hook_active` 被任何 SubagentStop hook 拦过一回之后，这次运行余下的每一回都为真，调工具也不清；续跑上限只数连续的拦截，两次停下之间调过工具就清零——交替调工具的子代理平台不封顶。SubagentStop 放行时递不出任何话给父级。探针插件没进仓库，平台升级后照 `docs/37` §1.2 的做法另搭一个重跑。
- **派发与完成通知**（CLI 2.1.286，`docs/38` §1.3）：交互模式（终端、`--bg`）下 Agent 工具没有 `run_in_background`，一律后台；只有 `-p`、SDK 宿主能前台派（`PostToolUse` 在子代理跑完之后才到，`status` 是 `completed`）。完成通知每一条在主会话触发一次 UserPromptSubmit，`prompt` 就是那段 `<task-notification>` XML，同一个 task-id 会通知不止一次。嵌套派发的通知按模式路由：交互模式下孙代理的通知回到停车的协调者，`-p` 下协调者还在跑时也送给它——这两种情形主会话都只收到协调者那一条。子代理回报里出现指令形状的字样时，CLI 在最前面插一段 `[harness: …]` 注记。
- **auto 权限模式下的交回**（CLI 2.1.301，`docs/99` §2）：子代理的系统提醒要它最后用 `SubagentHandback` 交回报告（manual 下没有这个工具），之后写的普通文字送不到上级；交回结束这一次运行。报告作为 `<agent-message from="<agent_id>">` 送到派它的人，框那一行顶格、报告每一行缩进两格；收件人是主会话时触发 UserPromptSubmit。交回结束的那一次完成通知只进转录，`<result>` 只说报告已经交回。没交回就以文字结束的，平台补一句催它交回、最多 3 次，始终不交回的上级只收到「没有交回报告」，文字不转。
- **UserPromptSubmit、UserPromptExpansion 上 hook 的输出进不进转录看 stdout**（CLI 2.1.286，`docs/50` §1.3）：stdout 为空的不留记录、stderr 跟着丢；带 additionalContext 的只记那段上下文；纯文本 stdout 才连 stderr 一起记。调试日志里都有。门禁在这两个事件上的留痕行只能在 `--debug-file` 里数。
- **AskUserQuestion**（CLI 2.1.286，`docs/95`）：`PostToolUse` 的 `tool_response` 只有 `questions`、`answers`；题面在 `tool_input`、`tool_response.questions` 与 `answers` 的键里逐字相同（多行、空行、表情、反引号原样，SDK 宿主上量的）。桌面端作答之后的卡片把题面的换行挤成一段——要用户逐行读的东西别只放在题面里。
- **拿内置浏览器验页面行为之前，先看面板显没显示**（`tabs_context` 会说）：面板隐藏时页面不渲染，`requestAnimationFrame` 不跑，连 `window.scrollTo` 都不生效——点锚点「不动」、动画「不播」都会是假阴性。要么让面板显示，要么用 Playwright 无头浏览器测（它打不开 `file://`，本地页面要起 `python -m http.server` 再看；快照与截图只能写进仓库下的 `.playwright-mcp/`，测完删掉）。2026-09-27 就因此把一个能用的锚点误判成不能跳，多发了一版。

### README

- `README.md` 一份文件里中文在前、英文在后，以 `<a id="english"></a>` 那一行分界。改它之前先读 `tests/readme-sync.test.mjs` 各节的标题：两半的小节标题（含 `###`）要在 `HEADING_PAIRS` 里成对同序，`claude …` 命令行要中英镜像，阶段编号只准在同一行写全两个端点，「使用」一节要列全 `commands/` 下的命令，流程图的箭头数要等于阶段数。
- 排版要按 GitHub 首页 README 栏的实际宽度看（1280 视口下 823px）：表格右列写太长，会把左列挤成好几行。本地预览可用 `gh api markdown -f mode=gfm -F text=@README.md`：警示块与 mermaid 都渲染得出，但它把段内换行当硬换行（README 页面不会），所以徽章要写在同一行。

## 遗留事项

- 下一步是等用户正常使用插件、带回真实会话的项目目录：读 `.agent-team/runs/` 与会话转录，照结果按原流程修补、回归。不再从开放边界索引逐条挑（`docs/91`）。
- 下一次真实会话要核的两件：
  - 走一遍「先把需求问清楚」——不带参数或话没说清、问清、批准、建 run、第 1 节照抄需求稿、推进出 S1；看长题面在界面上显示全不全（`docs/95` §5）。
  - 收口那一次还改不改已经写下的时间；派出去的角色的请求被拒之后会不会同样停下（`docs/94` §5）。
- 还开着的边界以 `docs/00-开放边界.md` 与 `docs/91` 的裁定为准。
- `.github/workflows/ci.yml` 与 `.github/workflows/min-node.yml` 的注释里还指着迁移之前的 `HANDOFF.md`（「运行现状」「常用命令」「注意事项」几节），那几节现在在这份文件里。迁移时没改：改了工作流文件，CI 就推不了任何旧版的 tag。下次本来要改工作流时顺手改掉。
