# 微信BOT Lite · dsh-plugin-weixin-lite

用微信远程操作电脑上的 DeepSeek Harness：把一个微信会话**绑定**到工作区里的一条 DSH 会话，之后在微信里发的文字/图片就是那条会话的输入，那条会话的回复会回到微信。

这是从 [`dsh-plugin-weixin-bind`](FORK.md) 精简出来的独立包，只保留「手机远程用 DSH」需要的能力：

- 绑定：`/bind` → 选序号 → 一个微信会话固定驱动一条工作区会话（`/unbind` 解除）
- 文字与图片：文字直接进会话；图片作为 image 块交给 Agent（可关）
- 计划模式：`/plan` 明确进入（`/plan off` 退出，`/plan status` 查看）；Agent 调用 `exit_plan_mode` 时，计划 Markdown 发到微信，回 `1` 批准 / `2` 打回（可带意见）
- 危险操作审批：会话请求审批时，微信回 `1` 允许一次 / `2` 拒绝 / `3` 取消
- 文件：`/files` 看这条会话提交过的计划 Markdown；`/files docx` 看工作区里的其他类型；`/file <序号>` 取回最近一次列表里的文件
- 保活：长轮询断线自动重连；发送失败进 outbox 重试；未绑定时只回绑定指引

## 安装

需要 Node.js ≥ 22.13，DSH 桌面版已登录过微信账号（`~/.dsh/weixin`）。

```powershell
# 0) 取源码
git clone https://github.com/cynicKss/weixin-dsh-lite.git
cd dsh-plugin-weixin-lite

# 1) 打包
pnpm pack --pack-destination dist

# 2) 装进 profile（默认 ~/.dsh/profiles/desktop）
node bin/install.mjs --tgz dist/dsh-plugin-weixin-lite-0.1.5.tgz
```

安装器会把包复制到 `<profile>/node_modules/dsh-plugin-weixin-lite`、把包名加入 `dsh.profile.bundles`，并把依赖写成 `file:<tgz>` 的绝对路径。**装完必须完全退出并重启 DSH**（插件模块在进程启动时加载）。

> 同一个微信账号只能有一个长轮询。安装本包前，请先从 profile 的 `dsh.profile.bundles` 里移除旧的 `dsh-plugin-weixin` / `dsh-plugin-weixin-bind`，否则会双开抢消息。

卸载：

```powershell
node weixin-lite/bin/install.mjs --uninstall
```

## 绑定与使用

1. 在桌面端工作区里开一条会话（或复用已有会话），记下它的标题。
2. 微信里发 `/bind`，机器人列出工作区最近 12 条会话；回 `/bind 3` 绑定第 3 条（也可 `/bind <session-id 前缀>`）。
3. 之后直接发文字/图片即可；`/status` 看绑定与连接状态。
4. `/unbind` 解除绑定，工作区那条会话不受影响。

绑定后：

- 微信消息会作为那条会话的用户输入；若那条会话正在跑（例如桌面端正在执行），会等它空闲（最多 `bindIdleWaitMs`，默认 10 分钟）再投递，不会打断桌面端。
- 计划评审默认**微信独占**：计划发到微信后，桌面端不会弹评审卡片；`planReviewGuiHandoffMs > 0` 时，等待该毫秒数后交给桌面端，微信只收提示。
- 危险操作审批同理（`approvalGuiHandoffMs`）。

## 配置

配置文件：`~/.dsh/weixin/config.json`（也可由宿主设置读取）。常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `accountId` | `""` | 只服务指定账号；空 = 全部已登录账号 |
| `cwd` | `""` | Agent 工作目录；空 = `~/.dsh/weixin/sessions` |
| `allowedSenders` | `[]` | 允许的微信发送者；空 = 拒绝所有人（首个联系人会自动入账号级白名单） |
| `bindEnabled` | `true` | 是否允许 `/bind` |
| `bindIdleWaitMs` | `600000` | 目标会话忙时最多等多久 |
| `planReviewInWechat` | `true` | 计划评审走微信 |
| `planReviewWaitMs` | `0` | 微信等待批准超时（0 = 不超时） |
| `planReviewGuiHandoffMs` | `0` | >0 时多少毫秒后交桌面端 |
| `approvalInWechat` | `true` | 危险操作审批走微信 |
| `approvalGuiHandoffMs` | `0` | >0 时多少毫秒后交桌面端 |
| `nativeImageInput` | `true` | 图片作为 image 块交给模型（关闭则只给本地路径） |
| `maxMessageLength` | `1500` | 单条回复分片长度 |
| `autoSendFiles` | `false` | 回复后自动扫描并发送新文件 |

## 安全

- 白名单为空时拒绝所有人；入站消息在下载媒体之前就做白名单判断。
- 只有绑定人（发起 `/bind` 的发送者）能批准计划与危险操作。
- 危险操作审批 fail-closed：宿主没有应答者时按不可用处理；微信发送失败会交回桌面端。
- 状态目录 `~/.dsh/weixin` 存微信凭据、绑定、文件索引；不要提交到版本库。

## 已知限制

- 只处理绑定会话；未绑定时不会创建新会话（这是与上游最大的行为差异）。
- 一个工作区会话只能被一个微信会话绑定。
- 图片以外的附件（文件、语音）目前不做正文抽取；语音转文字未包含。
- 没有 GUI 卡片/设置面板：配置改 `config.json`，登录用 `bin/login.js`。
- 出站文件只在 `config.cwd`（或绑定会话的 cwd）下扫描两层目录。

## 开发

```powershell
node --check src/index.js
node test/bindings.test.mjs   # 逐个跑；Windows 沙箱下 node --test 可能 EPERM
```

测试覆盖：绑定/解绑、绑定未命中会话自动解绑、计划评审微信独占与交接、审批微信独占与交接、文本归因、图片块、文件扫描与列表记忆。

## License

MIT。传输层与 vendor 来自 [`@tencent-weixin/openclaw-weixin`](THIRD-PARTY-NOTICES.md)（MIT），上游插件为 [`dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin)（MIT）。
