# agent-intro-3d

Codex / Claude 桌面端的机械师 3D 入场动画与侧栏宠物。原 `claude-intro-3d` 仓库延续到这里，保留 Git 历史；两个版本独立安装、独立设置，可以同时使用。

## 预览与示例图

| Codex 版入场 | Claude 版入场 |
| --- | --- |
| ![Codex 入场预览](editions/codex/docs/preview.webp) | ![Claude 入场预览](editions/claude/docs/preview.webp) |

动图经过降帧、缩小和压缩，实际播放按窗口原尺寸渲染。下面保留原 Claude 版的演出截图与宠物示例；两个版本各自的介绍见 [Codex 版](editions/codex/README.md) 和 [Claude 版](editions/claude/README.md)。

| 举起扳手 | 竖拇指 | 待机 |
| --- | --- | --- |
| ![原版举起扳手](editions/claude/docs/screenshots/screenshot-1.jpg) | ![原版竖拇指](editions/claude/docs/screenshots/screenshot-2.jpg) | ![原版待机](editions/claude/docs/screenshots/screenshot-3.jpg) |

| 宠物待机 | 盘腿坐 | 看鞋 |
| --- | --- | --- |
| ![原版宠物待机](editions/claude/docs/pet/pet-idle.jpg) | ![原版盘腿坐](editions/claude/docs/pet/pet-sit.jpg) | ![原版看鞋](editions/claude/docs/pet/pet-feet.jpg) |
| 打响指 | 点击回应 | 额度气泡（示例数据） |
| ![原版打响指](editions/claude/docs/pet/pet-snap.jpg) | ![原版点击回应](editions/claude/docs/pet/pet-click.jpg) | ![Claude 额度示例](editions/claude/docs/pet/pet-quota.png) |

## 选择下载与安装

macOS 14+，需要 Xcode Command Line Tools（`xcode-select --install`）。

先下载入口脚本，再从命令行选择 Codex、Claude 或全部：

```bash
git clone --filter=blob:none --sparse --single-branch https://github.com/YorenZZZ/agent-intro-3d.git
cd agent-intro-3d
./pull.sh --install
```

```text
选择 Agent Intro 3D 版本：
  1) Codex
  2) Claude
  3) 全部
```

也可以直接指定：

```bash
./pull.sh codex --install    # 下载、编译并安装 Codex 版
./pull.sh claude --install   # 下载、编译并安装 Claude 版
./pull.sh all --install      # 两个都安装
```

`./pull.sh` 会先设定所选版本的下载范围，再更新仓库并取出对应源码和视频素材。上面的部分克隆方式按需下载；只选 Codex 时，Claude 的素材不会下载，反之亦然，更新和切换版本时也保持这一规则。菜单记住上次选择，回车沿用。后续更新与切换版本继续使用 `./pull.sh`。

只下载：`./pull.sh codex`；下载并构建：`./pull.sh all --build`。已有当前版本、只想重新选择下载范围时用 `--no-update`。普通完整克隆也能使用这些命令，已经下载到 Git 对象库的内容会留在本机。

切换只改变本地源码下载范围；已安装的 App 保持安装状态。需要卸载时先下载对应版本，再运行卸载命令。工作区有未提交改动时会停止更新，请先提交或 stash。

## 两个版本

| | Codex | Claude |
| --- | --- | --- |
| 应用 | `Codex Intro 3D.app` | `Claude Intro 3D.app` |
| 跟随客户端 | Codex（含现行 `ChatGPT.app`） | Claude 桌面端 |
| 额度 | 现有 Codex 登录的订阅剩余百分比、重置时间 | Claude 5 小时 / 本周额度 |
| 更新方式 | 本机 Codex 对话结束、点击、定时查询 | Claude Code `pet-quota` 插件 |
| 详细说明 | [Codex 版](editions/codex/README.md) | [Claude 版](editions/claude/README.md) |

两个版本都有启动入场、落地到侧栏、待机与随机动作、轮廓点击、拖动位置记忆、窗口移动与遮挡避让、主题适配和登录自启动。Esc 跳过入场。Codex 版保留最新定制角色素材；Claude 版保留原仓库的素材和额度插件。

Codex 版只显示自己的订阅额度，按实际套餐窗口显示。只返回周额度的账号只显示“本周”。查询使用桌面端自带 CLI 的官方账号接口，不调用模型；对话结束监听读取本机增量事件。侧栏收起检测需要给伴侣 App 授予辅助功能权限，未授权时支持手动侧栏开关，见版本说明。

## 构建、设置与卸载

已下载所需版本后，在根目录运行：

```bash
./build.sh codex --install
./build.sh claude --install
./build.sh all              # 两个版本都构建，不安装

./pet.sh codex status
./pet.sh claude hide
./pet.sh all show
./pet.sh codex quota off

./build.sh codex --uninstall
./build.sh claude --uninstall
./build.sh all --uninstall
```

卸载会撤销登录项、停止对应伴侣，并将 App 移到废纸篓。Claude 额度插件可另外用 `claude plugin uninstall pet-quota` 移除。两个伴侣都安装在 `/Applications`，日志在 `~/Library/Logs/<App 名>/app.log`。

## 开发

```text
agent-common.sh         菜单与版本选择
pull.sh                 更新、按需下载、可选构建/安装
build.sh / pet.sh       所选版本的构建与设置入口
editions/codex/         Codex 源码、角色素材、测试与制作工具
editions/claude/        Claude 原版源码、素材、额度插件与测试
tests/                  菜单、按需下载、版本切换与入口测试
```

下载全部版本后，补充检出根目录测试（按需下载默认只检出所选版本）：

```bash
git sparse-checkout add tests
node --test tests/*.test.cjs
node --test editions/codex/tests/*.test.cjs
node --test editions/claude/tests/*.test.cjs
./editions/codex/tests/native.sh
./build.sh all
```

视频仍按约 700KB 分片存放并附 SHA-256，构建时自动重组。制作工具、快照模式和额度插件说明在各版本目录中。独立的 Bundle ID 保持兼容已安装版本及其用户设置。

原创 AI 角色、非官方外部伴侣。与 OpenAI、Anthropic 或游戏厂商没有官方关联。[MIT License](LICENSE)。
