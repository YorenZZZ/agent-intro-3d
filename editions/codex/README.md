# codex-intro-3d · Codex 桌面版 3D 入场动画与侧栏宠物

独立的 macOS 后台小程序：Codex 启动时播放「超频机核」入场动画，结束后机械师落到左侧栏。保留当前 MiMo 定制版的角色视频、动作衔接、300pt 人物上限、轮廓点击、拖动位置记忆、主题适配、窗口移动与遮挡避让，以及对话结束后自动显示额度。

本版位于 [YorenZZZ/agent-intro-3d](https://github.com/YorenZZZ/agent-intro-3d) 的 `editions/codex` 目录（仓库原名 claude-intro-3d），保留原 MiMo 定制版的角色与动画调整，迁移为 Codex 伴侣。小米账号、Token Plan、HolySheep 余额查询和原有引擎额度插件已经移除。

当前版本 **1.3.0（构建 6）**：新增 100 条随机闲聊，完善完整落地、首帧交接、随机动作去重与主界面就绪后 Esc 跳过。详见 [版本记录](CHANGELOG.md)。

![入场预览](docs/preview.webp)

## 安装与使用

需要 macOS 14+、Xcode Command Line Tools，以及已安装并使用 ChatGPT 账号登录的 Codex 桌面端。在仓库根目录选择并安装 Codex 版：

```bash
./pull.sh codex --install
```

生成通用二进制（Apple 芯片 / Intel），安装 `/Applications/Codex Intro 3D.app`，启动并登记登录项。后台程序监听 `com.openai.codex`；同时适配名为 `ChatGPT.app` 的现行客户端和独立 `Codex.app`。不改客户端包内文件。

已打开 Codex 时安装会直接显示宠物；以后重启 Codex 自动播放入场。确认本次 Codex 主界面加载完成后，右上角才显示 Esc 提示并允许跳过；加载期间按 Esc 不会关闭入场，其他按键或点击也不打断。

保留完整的下降、着地姿势和起身动作；站稳并交接到侧栏后，才开始 5 秒站立待机，再开放随机动作，并在站姿循环结束时自然衔接。入场期间提前缓冲待机视频，确认首帧实际显示后才撤掉落地画面；慢解码时以已绘制的站立图片兜底。点击回应不受这段等待限制。

随机动作排除上一次实际播放的动作，中间站立、点击回应或重新入场都不会清空这条记录。预加载和点击插队后仍会再次检查，已播放完的片段不会重新排队；显式指定的动作仍可重播。

立即预览：

```bash
open -n "/Applications/Codex Intro 3D.app" --args --play
```

点人物：回应动作并显示订阅额度；点击外面收起。拖动人物：在侧栏内换位置并保存。右键：暂时隐藏一小时、关闭宠物、查看额度、回到默认位置。

人物显示时，每隔随机 45–90 秒冒出一句机械师女孩的闲聊，停留 7 秒。100 条本地文案打乱轮流抽取，一轮说完前不重复；词库在 `Resources/web/pet/chatter-lines.js`。闲聊复用额度气泡的位置和黑橙科技面板主题，只显示对话内容并穿透鼠标。额度出现时立即替换闲聊，关闭后重新随机等待；人物隐藏或重新入场时取消闲聊，不补播积压的话。

```bash
./pet.sh codex show
./pet.sh codex hide
./pet.sh codex quota on
./pet.sh codex quota off
./pet.sh codex status
```

## Codex 订阅额度

使用 [官方 App Server 的 `account/rateLimits/read`](https://learn.chatgpt.com/docs/app-server) 接口，通过桌面端自带的 Codex CLI 和现有登录状态查询。只读取额度，不发起模型对话。按实际返回的窗口显示剩余百分比和重置时间；只有周额度的套餐只显示“本周”，多额度池分别显示。

启动时查询一次，后台每 10 分钟更新。点开气泡或本机顶层 Codex 对话结束时刷新，同一分钟内不重复请求；失败保留上次成功读数。气泡标明更新时间。未登录或 API Key 登录没有订阅数据时显示提示，不把未知值当成满额。

对话结束监听只读 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）的增量事件，忽略历史完成事件和子代理，不需要安装插件或改变 Codex 的全局配置。云端 / 其他设备的对话结束不会触发本机气泡，额度仍会在下一次查询时更新。

## 侧栏与窗口

启动窗口位置读取 `$CODEX_HOME/.codex-global-state.json` 的 `electron-main-window-bounds`，窗口出现后按实际坐标跟随。侧栏宽度读取 `electron-persisted-atom-state.sidebar-width`，默认 340pt、范围 240–520pt；窗口宽于 768pt 时显示。

现行 Codex 的侧栏收起状态不写入磁盘。给本应用授予 macOS 辅助功能权限后，会读取侧栏按钮的展开状态；应用不会主动弹权限请求。未授权时可以在收起 / 展开侧栏后执行：

```bash
./pet.sh codex sidebar hide
./pet.sh codex sidebar show
```

宽度调整、窗口移动缩放、最小化和被其他窗口遮挡时自动隐藏；人物轮廓以外区域穿透鼠标。原始 MiMo 的侧栏存储格式、62pt 图标栏与小米账户菜单坐标没有移植。

## 开发与验证

在 `editions/codex` 目录：

```bash
node --test tests/*.test.cjs
./tests/native.sh
./tests/native.sh --live  # 用当前登录实际查询一次订阅额度
./build.sh
```

- `Sources/main.swift`：进程监听、窗口定位、入场播放、登录项。
- `Sources/pet.swift`：几何、鼠标、拖动、菜单与气泡桥接。
- `Sources/codex.swift`：窗口配置、订阅 RPC、顶层对话结束监听。
- `Sources/sidebar.swift`：已授权时读取侧栏展开状态。
- `Resources/web/`：入场与宠物 WebKit 页面。
- `Resources/clip/`：视频分片与 SHA-256；构建时自动重组。
- `tools/`：视频制作、抠像与图标辅助工具。

录制：`--snapshot <目录> [间隔秒] --size 宽x高 --landing`；宠物：`--pet-snapshot <目录> [间隔秒] --script sit,feet,snap,click --quota sample`，加 `--chatter` 可预览闲聊及随后切换额度的效果，加 `--entrance` 验证隐藏预缓冲与首帧交接。快照离屏渲染，不抢焦点。记录在 `~/Library/Logs/Codex Intro 3D/app.log`。

素材制作流程保持上游工具链：`tools/build-clip.py` 制作入场，`tools/build-pet.sh` 制作动作，`tools/build-transition.sh` 制作起跳与落地。换素材后运行 `tools/clip-parts.sh split`，同步视频时间轴与 `clips.json`，再测试构建。

## 卸载

在仓库根目录：

```bash
./build.sh codex --uninstall
```

移除登录项、退出后台程序，将 App 移到废纸篓。

人物是原创 AI 角色，演出风格向横版动作网游觉醒技能演出致敬。与 OpenAI、Anthropic、小米或游戏厂商没有官方关联。[MIT License](LICENSE)。
