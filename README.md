# Codex Context

适用于 Windows 上 Codex Desktop 的原生 WPF 状态栏。默认锁定在主显示器顶部居中，切换应用时继续显示。拖动左侧「Codex Context」可解锁并移动，点击「锁定」回到顶部。点击「隐藏」会暂停刷新，从 Codex Context 入口再次打开即可恢复。点击「展开」可查看会话、回复、分支、上下文和工具详情。窗口较窄时指标自动换行，Windows 任务栏隐藏独立按钮。交互参考 [agy-context](https://github.com/SaigyoujiYusora/agy-context) 与 [dsh-context](https://github.com/bowenliang123/dsh-context)。

配色跟随 Codex 的浅色、深色或系统外观，并读取当前模式的自定义底色、文字色和强调色。调整 Codex 设置后，状态栏和检查面板会自动更新。

「跟随聊天」会将 Codex 标题栏与本地会话列表精确匹配。标题重名或暂时无法识别时保留当前统计。手动选择会话或创建分支后会固定所选会话，可重新勾选「跟随聊天」恢复同步。

## 启动

需要 Node.js 22+、PowerShell 7 和支持 `thread/fork.lastTurnId` 的 Codex CLI。在 GitHub Releases 下载所需版本的 Windows ZIP，解压后在顶层目录运行以下命令。

```powershell
& .\plugin\open.ps1
```

- `-ThreadId $env:CODEX_THREAD_ID` 打开当前 Codex 会话。已有悬浮窗时复用原窗口，并在隐藏后恢复显示。单实例按当前 Windows 登录会话和服务端口区分。
- `-Detached` 以自由定位的工具窗启动。
- `-Browser` 启动可选的完整浏览器布局。服务默认地址为 [http://127.0.0.1:47371](http://127.0.0.1:47371/)。
- `-NoBrowser` 仅启动本地服务并返回地址。用 `-Port 47372` 可以更换端口。

关闭小窗后服务仍可供下次打开。运行以下命令停止服务。

```powershell
& .\plugin\open.ps1 -Stop
```

### 注册为 Codex 本地插件

在当前目录运行以下两条命令，然后在新聊天里调用 `$codex-context:context-panel` 或说「打开 Codex Context」。如果桌面端缓存了插件列表，重启应用后再试。

```powershell
codex plugin marketplace add .
codex plugin add codex-context@context-lab
```

从 Codex 移除入口时运行 `codex plugin remove codex-context@context-lab`。详见 [OpenAI Docs 的本地插件说明](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)。

## 指标

| 项目 | 口径 |
| --- | --- |
| 轮和请求步 | 轮以 Codex 的 turn ID 为单位。请求步优先使用按响应 ID 记录的用量条目，旧会话使用发生变化的用量快照。 |
| TTFT 和有效 TPS | 生成中根据日志里的首段文本时间显示带 `≈` 的 TTFT，并以截至最近一次已记账请求的用量估算有效 TPS。完成后优先采用 Codex 记录的 TTFT 与整轮耗时。有效 TPS 包含工具等待。 |
| Token 和缓存命中 | 累计值来自日志，单轮优先使用 Codex 的轮内累计值，旧日志从上轮累计值计算差值。命中率为缓存读取 Token 除以输入 Token。 |
| API 费用估算 | 按请求步分别计算未缓存输入、缓存读取、缓存写入和输出。GPT‑6.2 Sol 和 Astra 内置 API Standard 费率，超过 272K 输入自动按长上下文计价，缓存写入按 30 分钟档估算。缺少费率或用量时，标签显示「部分」，悬停可看覆盖范围。自管网关可在可选浏览器布局填写费率。订阅和实际账单以服务商为准。 |
| 上下文占用 | 同时显示百分比和已用 Token，例如 `26.9% · 128K`，悬停可查看精确用量和窗口上限。压缩后等待下一条用量记录。 |

费用参考 [GPT-6.2 Sol 费率](https://developers.openai.com/api/docs/models/gpt-6.2-sol) 与 [GPT-6.2 Astra 费率](https://developers.openai.com/api/docs/models/gpt-6.2-astra)。

## 数据与分支

- 收起时只读取指标摘要，生成时约每秒刷新，空闲时约每三秒刷新。隐藏时暂停刷新。标题查询只在 Codex 主窗口位于前台时运行。服务只监听本机回环地址。
- 展开后按需创建检查面板和载入详情，收起时释放面板和详情。后端的单会话详情缓存约 20 秒后过期。
- 「回复与分支」在每条回复记录旁显示单轮用量和分支按钮。点击已完成轮次的「分支」后，App Server 创建包含该轮及之前历史的新会话。点击「切到会话」可跳转到 Codex。归档会话仅供查看。
- 配置模型、请求模型、响应模型和改派分别显示。请求或响应模型只有在本地记录提供相应字段时才有值。
- 指令面板支持日志里留存的 `AGENTS.md` 快照。完整服务端系统提示词没有公开接口。Schema 与调用详情取自本地会话已有的工具记录，覆盖范围依 Codex 版本与会话而异。
- 「配置的指令文件」通过 Codex 的有效配置读取用户或工作区指定的 `model_instructions_file`，显示当前磁盘上的完整文件（上限 2 MiB）。此处是配置文件原文，旧会话的文件版本可能不同。[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- 在「Schema」点击「查询已配置 MCP 的 Schema」后，插件通过 App Server 查询当前本地配置中的 MCP 工具目录，显示服务商提供的输入和可选输出 Schema。已配置目录与会话日志留存的 Schema 分别标注。[Codex App Server](https://learn.chatgpt.com/docs/app-server)
- 官方插件接口提供启动入口。PowerShell 7.6 使用随插件提供的编译版 WPF 窗口辅助模块，可用 `./build-native-helper.ps1` 重新生成。

[Codex App Server 分支接口](https://learn.chatgpt.com/docs/app-server) · [Codex 桌面跳转链接](https://learn.chatgpt.com/docs/reference/commands#deep-links)

## 自管上游的响应模型

展开悬浮窗并打开「请求步」，可逐步查看响应 ID、请求模型、响应模型、来源和 Token 分项。如果自管网关保留了 Responses API 的 `response.completed` 事件，可把每个事件的模型字段写入本地 `~/.codex/context-traces/<会话 UUID>.jsonl`。使用自定义 Codex 数据目录时，把 `context-traces` 放在该目录下。每行可包含以下字段。

```json
{"type":"response.completed","request":{"model":"model-alias"},"response":{"id":"resp_example","model":"actual-model-version"}}
```

面板通过响应 ID 与会话日志对应。`request.model` 可省略。提供方须返回实际模型标识，面板按原值显示。发生冲突时会标记，且保留 Codex 日志已有的值。记录可在面板运行时更新，文件上限为 4 MiB。只需模型与响应 ID，无需保存认证头、聊天正文或提示词。[Responses 流式事件文档](https://developers.openai.com/api/reference/resources/responses/streaming-events)

### 查看自管请求的指令与工具定义

如果要检查你自己应用发给上游的内容，可在同一行加入 `"capture":"user-owned-request"`。在 `request` 内只保留需要查看的 `instructions`、`input` 中的 `system` / `developer` 文本和 `tools` 中的函数或自定义工具定义。展开悬浮窗，选择已匹配的请求步，点击「请求指令与 Schema」。

```json
{"type":"response.completed","capture":"user-owned-request","request":{"model":"model-alias","instructions":"自有应用的完整指令","tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{}}}]},"response":{"id":"resp_example","model":"actual-model-version"}}
```

该面板读取你写入的请求快照。服务端附加的系统指令仍取决于上游是否公开。重复记录若给同一响应提供了不同快照，面板提示冲突并保留可确认的模型信息。[Responses 请求字段](https://developers.openai.com/api/reference/resources/responses/methods/create)

### 自动记录自管网关的模型和流式计时

对支持 Responses SSE 的自管网关，可以运行本地转发器。把示例上游地址换成现有网关的 base URL。

```powershell
node .\plugin\trace-relay.mjs --upstream https://gateway.example/v1 --port 47372
```

将自定义供应商配置的 `base_url` 指向 `http://127.0.0.1:47372/v1`，保留原来的认证配置，使用 `wire_api = "responses"` 和 `supports_websockets = false`。转发器接受 `POST /v1/responses` 并逐块转发。它把匹配到的请求模型、响应模型、首段可见文本延迟和首末文本间隔写入 `context-traces`。认证、请求正文和提示词不写入记录。按 Ctrl+C 停止转发器。[Codex 网关兼容要求](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)

在「请求步」可查看网关计时。对于纯文本响应，如果上游明确报告推理 Token 为零，且首末文本之间有可测间隔，面板额外显示按上游输出 Token 数估算的可见文本 TPS。网络缓冲会影响此读数。

在生成途中，悬浮窗可提前显示当前请求的「网关首文本」时间。若上游每个可见文本增量都含 Token 明细，悬浮窗还会显示「网关文本 TPS」。实时记录只匹配正在执行的同一轮，流结束后自动消失。转发器不会更改请求以获取 Token 明细。
