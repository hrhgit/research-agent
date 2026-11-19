# Research Agent

这是一个面向 DSH 的通用研究底座。它把长期研究方向、具体任务、实际运行、已确认记录和跨记录洞见分开保存，量子、GPU 算子、机器学习等方向共用同一套记录结构。

当前插件版本为 **0.2.0**，适配 **DSH 0.2.2-rc.3**，要求 **Node.js 24.9 或更新版本**。开发、测试和本项目的启动命令使用固定的已发布 DSH 版本。

## 当前包含

- `src/core/types.ts`：`Direction / Task / Run / Record / Insight` 数据结构。
- `src/store/sqlite.ts`：独立的 `research.sqlite` 存储，保存研究事实和主会话研究请求的持久调度状态；DSH 原生会话内容仍由 DSH 保存。
- `src/importer/experiment-log.ts`：导入已有 `experiments/<direction>/` Markdown，以及 `outputs/experiments/` 下的候选 JSON。
- `src/dsh/api.ts`：可以给 DSH 主 Session 或 Worker 使用的研究工具接口。
- `src/dsh/http.ts`：挂载到 DSH Web 面板的 `/research/api` 路由。
- `src/dsh/runtime.ts`：DSH bundle 的运行时工厂，统一创建 store、工具和 HTTP 挂载点。
- `src/dsh/client/ResearchPanel.tsx`：可挂到 DSH sidebar slot 的研究面板，显示主会话请求队列、方向、任务、运行、记录、洞见和召回结果。
- `src/dsh/board.ts`：研究状态看板的只读汇总（`GET /research/api/board`）：未结束的派工、孵化各轮的差距、每个方向下采纳和放弃的路线。`client/ResearchBoard.tsx` 负责绘制，`client/board-view.ts` 放不依赖界面的排版计算，`client/PixelOffice.tsx` 是智能体那一块顶部的像素小人办公室（素材来源和许可见 `THIRD_PARTY_NOTICES.md`）。
- `src/dsh/plugin.ts`：共享数据库和带认证的 HTTP 接口；`agent.ts` 在研究模式内注册研究调度、实验和审计工具与流程指引；`client/index.tsx` 注册左侧的研究面板和右侧栏的研究状态页。
- `src/dsh/backend.ts`：适配 DSH 的子会话查询与停止；只停止指定研究请求的子任务，不关闭同一主会话中其他请求的子任务。
- `src/adapters/quantum.ts`：量子方向适配器，只抽取资源和错误指标；通用记录仍然不绑定量子字段。
- `src/core/adaptive.ts`：根据效果保留率、累计成本、失败次数和单位成本收益推荐下一档实验规模。
- `src/core/incubation.ts`：按结构性候选与对照的差距是否持续缩小，决定继续孵化、毕业或停止。

`ResearchRecord` 是追加式事实记录。失败、资源门槛、无收益和不确定结果都会保留；更正用新记录的 `supersedes` 指向旧记录。导入器会保存原始数字、源文件路径和源文件哈希，不会把一次本地结果自动写成公榜结论。

规模优化由 `research_scale_recommend` 工具执行。AI 根据历史记录填写同口径的观察值和策略，工具据此建议扩大、重试或停止。当前工具提供决策建议，不是实验启动拦截器；模型仍需遵守效果下限、总成本上限和失败次数上限。每次运行还可以绑定 `scale_stage_id` 和 `tool_version_ids`，从而知道结果是在什么规模、什么工具版本上得到的。

结构性候选（换算法、换电路结构）的第一版通常落后于调优过的对照，单次小测会把它直接淘汰。这类候选用孵化流程多轮开发：

- 总控用 `research_incubation_open` 立项，写明结构、对照值及其证据，并一次定下指标、毕业线、轮数上限、累计成本上限、失败轮数上限和停滞规则；立项后限额不能修改。
- 每一轮仍是一个普通候选加一次已结束的运行，候选带 `incubation_id`。第一轮照常引用侦察来源；后续轮可以用 `based_on_run_id` 引用上一轮已登记的运行，不必重新联网。
- 运行结束、候选结案后，总控用 `research_incubation_round` 登记这一轮，写出当前最大的剩余开销和下一步结构改动。效果从运行的 `metrics[指标名]` 读取，成本从 `metrics.cost_units` 读取，不由模型另填。
- 存储层算出差距比（1 表示与对照持平）并直接执行决定：达到毕业线转为 `graduated`，之后走 `research_scale_recommend` 和完整验证；用完轮数或成本、失败轮数超限、或最近 `patience` 轮收窄的剩余差距不到 `min_gap_closure`，转为 `stopped`；其余情况继续。第一版落后于对照本身不构成停止理由。
- 上一轮没有结案并登记，不能开下一轮；每个方向最多同时孵化 2 个，要开新的需先暂停或停止一个（`research_incubation_update`）。
- 只有总控会话能立项、登记和暂停；子智能体用只读的 `research_incubations` 查看，执行员的派工说明里附带所属孵化的完整状态。`research_state` 会列出进行中的孵化，供下一次会话优先接着做。

工具自我优化保留为受控流程：先登记不可变的 `ResearchToolVersion`，再提交 `ResearchToolChangeProposal`；提案只能经过 `proposed → shadow → accepted` 等状态流转，运行中的实验不会更换工具版本。这样既能让 AI 优化实验工具，也不会让工具改动污染当前实验的对照和结论。

## 运行测试和导入当前项目

```bash
cd /Users/herh/MyFiles/Projects/research-agent
node --test test/**/*.test.ts
node --experimental-strip-types src/cli.ts import --root ../google
```

默认数据库是当前项目根目录下的 `research.sqlite`。它是研究事实库，可以与 DSH 的状态目录分开备份。重复导入是幂等的，已有记录不会覆盖。

## 在这台电脑上打开

双击 `start-research.command`，或运行：

```bash
cd /Users/herh/MyFiles/Projects/research-agent
pnpm start
```

DSH 在 `http://127.0.0.1:5417` 启动，并自动打开浏览器。左侧点 **研究** 查看方向、记录与证据；统计下方 **接入配置** 显示数据库、导入目录和工具列表。正常启动会自动完成本机浏览器连接授权；如果地址直接打开提示未授权，请用启动命令打开。

在 DSH 自己的设置中配置账号和模型，然后：

1. 新建会话，选择要做实验的项目工作区。
2. 点击输入框上方、工作区旁边的模式菜单（通常显示 **Standard mode / 标准模式**），选择 **研究模式**。
3. 确认模式标签显示“研究模式”，再提出研究目标。

没有具体问题、只想让研究接着跑时，可以用一键入口：左侧点 **研究**，再点右上角的 **启动研究**。它会在当前或最近使用的工作区里开一个研究模式的新会话，把预置提示词放进输入框（让总控先看 `research_state`，接着做未完成的孵化和请求，没有再选下一步）。按 Enter 发送，之后照常对话；发送前可以改写或补充。按钮本身不向模型发送消息，重复点击不会叠加提示词，但会替换该空白会话里未发送的文字。还没有任何工作区时 DSH 会提示先选工作区。提示词可以在 `dsh-research-agent` 配置里用 `startPrompt` 改写，当前生效的内容显示在面板的 **接入配置** 中。

菜单里还会显示五个带“研究”字样的角色模式。这些是给子智能体和人工排查用的专门组合；正常开始一项研究时只选“研究模式”，总控会自动为子任务选择合适角色。

DSH 在会话开始后固定模式；已有会话要改用研究模式，请新建会话。普通模式不加载本插件的研究工具和流程指引；左侧研究记录面板始终可用。模式选择确定加载哪些工具与指引，但不保证模型每次都正确遵循全部步骤，实际运行和证据仍需核查。

研究模式组合了运行命令、文件读写与搜索、后台任务、资料查询、技能、目标和上下文整理等 DSH 能力。研究调度和实验工具由该会话当前选定的模型调用。本项目不内置模型、不代填密钥，也不需要 Codex 作为运行入口。

研究模式采用了官方 Superagent 的调度思想，并使用 DSH 原生的 `subagent` 机制执行分工。主会话中的研究请求会先写入持久队列，再由总控判断、建立方向和任务、创建派工，并选择五类子智能体：研究侦察员回看历史并使用联网搜索和网页抓取查找外部证据；研究执行员按固定规模和工具版本运行实验；研究复核员独立检查运行和证据；研究汇总员整理记录和矛盾；研究工具工程师登记新版本并设计影子验证。子智能体使用同一个研究数据库，但各自只加载所需工具。总控先用 `research_assignment_create` 保存派工，再用 `research_assignment_dispatch` 启动真实的 DSH 子会话；这个调用会绑定角色、子会话编号和当前请求，子会话结束时由 DSH 自动把完成、失败或等待状态送回总控。执行员不能写正式结论，复核员不能修改事实，总控在核对证据后才写入 `research_record_add` 和 `research_insight_add`。

每条影响方案的联网来源都要先由对应派工绑定的 scout 通过 `research_source_capture` 入库；总控和其他角色看不到此工具，总控可用 `research_sources` 读取来源。登记时保存搜索词、网页地址、标题、来源类型、主张、适用范围、限制和系统记录的获取时间；来源条目还要写出对应机制、最小实验和通过/停止标准。侦察员报告中的假设必须与已保存来源的这些字段一致。总控只能把已完成侦察报告中的一条完整假设提升为候选，再新建 runner 派工、绑定候选并启动执行。runner 的每个运行都记录候选和 runner 派工编号；只有运行结束、候选给出有证据的结果、runner 报告列出全部运行后，请求才可完成。这样只读分析、网页摘要或未完成运行都不能单独关闭包含侦察结果的请求。

`research_assignment_create` 返回派工对象，其中的 `id` 就是正式 `assignment_id`，派发和恢复时都用它。上下文丢失时，用 `research_assignment_list` 按请求、角色、任务说明和子会话编号找回原派工。请求上的 `current_assignment_id` 会随其他派工创建或启动而变化，不能用来认定某个子任务的身份。scout 已搜索但未登记来源或交报告时，总控等待仍在运行的原 scout，或用 `research_assignment_resume` 让等待/失败的原 scout 沿用已有结果补齐登记和报告；仅为未解决的证据缺口补充搜索。

派工的开始、暂停和结束随 DSH 子会话一起更新，恢复后的报告归到新一轮派工。总控在派工开始前绑定方向和任务。子任务结束时，系统保留总控明确设定的等待或阻塞状态。否则按运行、等待、失败或停止的派工计算请求状态，全部处理后回到 `accepted`。满足证据检查后，可直接从 `accepted` 或 `waiting` 结案。撤回待验证候选会一并撤回其执行派工和依赖它的未启动派工，留存 `assignment-cancelled` 事件。运行中的执行派工先暂停，再撤回。

自动状态变化随状态一起写入 `research_dispatch_trace` 的 `request-updated` 事件，字段包含 `from`、`to`、`automatic: true`、`reason` 和适用的 `assignment_id`。有已完成侦察的请求仍须完成候选实测并由对应执行员提交报告。候选成功必须有成功运行和实际指标或产物，记录了失败原因的实测也可用于负结果。实验结束后结果固定，相同的重试会返回已有结果。有多次运行的任务只在所有运行结束后计算最终状态，有成功运行时为 `completed`，否则为 `blocked`。

研究数据与 DSH 会话分开保存。`research` 是独立的插件配置；DSH 自身的账号、工作区和会话仍按其全局存储规则共享，不是另一个账号环境。模型配置和已有账号均由用户管理。

在 DSH 左侧打开 **研究 → 子智能体模型**，可以为侦察、执行、复核、汇总和工具维护分别选择服务商、模型与思考强度，也可以选择“跟随主会话”。模型和强度选项来自当前 DSH 服务商；不支持调整强度的模型会显示说明。点击“保存设置”后，新派工立即使用新默认值，无需重启，已有派工继续使用自己保存的模型。“刷新选项”会重新读取配置和模型目录，同时保留尚未保存的修改；“撤销修改”恢复已保存的值。

设置通过 DSH 官方配置编辑服务保存到当前 profile，只修改变化的角色，并且不会重启研究插件或中断子任务。读取/保存失败会显示原因；无配置编辑服务的环境只能查看。`research_model_defaults` 不传参数用于查看，传 `changes` 可在主会话中保存同样的设置（角色值为 `null` 表示跟随主会话）；单次派工换模型仍使用 `research_assignment_resume`。首次安装这次更新需重新启动 DSH 加载新代码，之后在面板保存不需要重启。

当前机器配置位于 `~/.dsh/profiles/research/cordis.patch.yml`：

```yaml
- id: dsh-research-agent
  config:
    dbPath: /Users/herh/MyFiles/Projects/research-agent/research.sqlite
    projectRoot: /Users/herh/MyFiles/Projects/google
    importOnStart: true
    childModelDefaults:
      scout:
        provider: magpie-responses
        model: codex/gpt-6-luna
        reasoning_effort: low
      runner:
        provider: magpie-responses
        model: codex/gpt-6.1-sol
        reasoning_effort: medium
      auditor:
        provider: magpie-responses
        model: codex/gpt-6-astra
        reasoning_effort: high
      synthesizer:
        provider: magpie-responses
        model: codex/gpt-6.1-sol
        reasoning_effort: medium
      tool-engineer:
        provider: magpie-responses
        model: codex/gpt-6.1-terra
        reasoning_effort: high
- id: webserver
  config:
    host: 127.0.0.1
    port: 5417
```

这里的模型是当前 profile 的默认策略示例：侦察优先低成本，执行和汇总保持中等思考，复核和工具维护使用更强的独立模型。模型必须是该 profile 已配置的 ID；如果不设置某个角色，它会继承主会话模型。

`projectRoot` 只指定历史记录的导入来源，不把新研究限制在量子方向。实验实际操作的目录由 DSH 会话中的工作区决定。

### 研究状态看板

想在对话旁边看研究进展时，打开任一会话的右侧栏，在页面列表里选 **研究状态**；左侧 **研究** 面板里也有同名标签页，内容相同、版面更宽。看板每 5 秒刷新一次，只在可见时请求，只读，不写数据库。它分三块：

- **智能体**：顶部是一间像素小人办公室——总控站在白板前，每个未结束的派工一张桌子，每种角色一个固定形象。小人头上的气泡写它正在做的事（执行者是所跑候选的标题，其他角色是任务说明，最多三行），桌面上写这件事推进的研究方向（请求没有关联方向时写请求标题，最多两行）；写不下的会截断，鼠标停在桌子上能看到全文。在跑的坐着打字（侦察和复核是看材料）；等待继续和还没开始的坐着不动，气泡开头标出状态，还没开始的显示为灰色。最多画 12 张桌子。下面按研究请求分组，列出还没结束的派工——角色、状态、任务说明、已用时间，执行者还会显示所跑的候选、孵化轮次和最近一次运行，侦察者显示已登记的来源数。粒度是派工和运行，不是模型的每一步操作。
- **孵化**：每个孵化一张图，纵轴是与对照的差距倍数（对数刻度），横轴是轮次，标出毕业线、失败轮和还没用的轮次，下面是轮数和累计成本的用量，以及存储层给出的当前判定。
- **路线**：按方向列出每条路线的去向——进行中、已采纳、未定、待做、已放弃，可按去向筛选。属于某个孵化的各轮候选合并显示为该孵化一条。

路线旁的原因只取已经写下的内容，并注明出处：优先用总控写的正式记录（通过 run 关联，实验记录优先于复核记录），没有时用执行者报告里的结论，孵化用其停止原因或判定。三处都没有时显示“没有记录原因”，看板不会自己补写。

## 桌面端

本机 `/Applications/DeepSeek Harness.app` 当前为 `0.2.2-rc.3`。研究插件同时安装在 `desktop` 配置中；打开桌面应用，新建会话后在模式菜单选择 **研究模式**。更新本地插件后需要完全退出并重开 DSH，以加载新代码。

桌面端与上面的网页版使用同一文件 `/Users/herh/MyFiles/Projects/research-agent/research.sqlite`，研究记录无需同步或重新导入。桌面端使用自己的服务端口，不占用网页版的 `5417`。两边的插件启用配置分别维护。

维护桌面插件时，先完全退出桌面应用，再使用桌面应用自带的命令：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /Users/herh/MyFiles/Projects/research-agent
```

研究路径配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `dsh-research-agent` 条目中；不要把网页版的整份配置覆盖到这里。插件加载、模式入口与记录面板可以在不发送模型消息的情况下检查；这些检查不代表真实模型已完成研究实验。

## 安装、构建和验证

```bash
pnpm install --ignore-scripts
pnpm check
pnpm setup:dsh
pnpm start
```

开发依赖与本项目的 DSH 命令固定使用 npm 发布的 `0.2.2-rc.3`，不再依赖平级 `../deepseek-harness` 目录。`pnpm dsh --version` 可以确认本项目的启动版本；终端中直接运行 `dsh` 使用的是全局安装，版本可能不同。需要调试 DSH 源码时才设置 `RESEARCH_DSH_ROOT`，并自行确认源码与开发依赖的版本一致。

`--ignore-scripts` 跳过依赖安装脚本；本项目的构建和验证不需要运行它们。所用 DSH 发布包已包含本机运行所需的预编译文件。

`setup:dsh` 只在目标不存在时从随附 web 模板建立 `research`，安装本地 bundle，并为全新空配置写入研究路径和端口。再次执行保留已有用户设置，不重置模型配置。可通过 `pnpm dsh --profile research --dump-config` 检查生效配置（完整输出可能包含你之后填写的敏感设置，请勿公开）。

主研究模式提供 43 个研究工具，包括请求和派工管理、研究记录、回查和汇总、候选跟踪、候选孵化、规模建议及工具版本管理。总控用 `research_assignment_list` 查报告。提交报告、侦察登记来源和执行员记录候选实验的工具会在对应子会话的派工运行时提供，恢复后随原派工重新提供。总控能绑定或撤回候选，执行员负责记录已结束实验的候选结果。`research_run_start` 记录启动，实际命令由 DSH 的执行工具完成。研究 HTTP 接口沿用 DSH 的连接认证，并提供来源、候选和孵化的只读查询。

这里没有直接运行官方 Superagent 的 GitHub/飞书来源，也不另起一个外部 IM 服务；主会话对话就是研究入口。项目吸收了它的请求、派工、状态转移、事件追踪和重启恢复思路，DSH 的会话、子会话、暂停、恢复、重试和执行工具承接实际工作；本插件提供研究事实、角色边界和结果审计。子智能体完成后把带 task_id、run_ids、evidence 和工具版本的报告交回总控；存储层会检查报告归属和运行是否已结束，正式记录仍由总控确认。子智能体暂停、失败或达到 token 上限后，主会话可以直接用 `research_assignment_resume` 继续原子会话，不需要重启 DSH；恢复前会保留原有子会话和实验记录。模型按角色支持默认值：`dsh-research-agent` 的 `childModelDefaults` 可以分别设置 `scout`、`runner`、`auditor`、`synthesizer` 和 `tool-engineer`，首次派工会使用对应默认值；单次用 `research_assignment_resume` 传入 `provider`、`model`（可选 `reasoning_effort`）可以覆盖，选择会随派工保存。用 `research_model_defaults` 查看当前策略，用 `research_models` 查看可用模型。运行中的子智能体需先暂停；进程重启后仍然沿用已保存的模型。当前历史召回仍是文本匹配；独立子智能体运行在同一 DSH 进程内，不假设存在跨进程的 Worker 集群。工具变更要求先进入影子验证状态、登记验证证据，再接受提案；接受不会自动部署代码。

运行 `pnpm check` 完成类型检查、自动测试、构建和完整配置验证，覆盖 DSH 模式隔离、共享记录与卸载清理、工具参数校验/调用、记录闭环、取消写入、HTTP 认证、角色默认模型、换模型恢复、暂停时保留待处理消息，以及不同研究请求之间的停止隔离。恢复测试使用真实 DSH 会话与模拟模型服务，不调用真实模型。

`pnpm check:profile` 在临时 DSH 目录中，通过官方命令安装构建后的插件并启动完整 Web 配置，检查主研究模式、五个子角色和普通模式。它使用空数据库，结束后清理临时目录，不使用个人配置或写入正式研究记录。该检查能发现单项测试中没有加载的失效插件路径；此次升级移除了 DSH 已停止导出的 `dsh-tool-subagent-control/list-agents`，总控通过 `research_assignment_list` 查询派工、通过 `research_assignment_resume` 继续子任务。

模型配置好后的真实实验需要另行验证。

完整配置验证还会检查角色模型设置的 HTTP 保存和主会话工具保存、非法模型/思考强度拒绝、并发修改合并、插件不重启且已有派工不变，以及整个 profile 重启后的设置保留。`pnpm check:profile --ui` 可在上述检查后保留一个使用测试模型目录的临时 DSH 页面供界面验证；按 Enter 后清理临时配置。临时页面自带一个临时工作区，不需要另选文件夹；研究库是空的，想看看板画出来的样子，可以用 `RESEARCH_UI_BOARD=<看板 JSON 文件>` 指定一份示例数据，它只替换这个临时页面里的看板接口。它不会调用真实模型或修改个人 profile。
