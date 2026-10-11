# pet-quota

Claude Code 插件（目录名 `claude-pet-quota`，插件名 `pet-quota`：校验器把 `claude-` 开头的插件名留给官方插件），把当前账号的套餐用量窗口（5 小时 / 本周，含重置时间）写到本机一个固定的 JSON 文件里，供 Claude Intro 3D 的桌面宠物读取，点她时显示在气泡里。

什么时候更新：

- **每轮对话结束**（`session.measure`）：用这一轮 API 响应带回的读数覆盖写入一次；会话刚开始（`session.start`）有读数时也写一次。
- **点宠物打开额度气泡时**：宠物先显示已有读数；如果它已超过 1 分钟，就写一个 `refresh-request.json`。每个开着的 Claude Code 会话里的插件每 2 秒看一次这个文件，由其中一个会话（经 `refresh-claim.json` 认领，避免多个会话重复）发一个 1 token 的 Haiku 请求（每个 API 响应都带着账号当前的额度），再写回最新读数，气泡随即刷新。1 分钟内已经更新过，不管点多少次都不再查询。
- 不在订阅额度下（API key、网关，例如终端里配了第三方 `ANTHROPIC_BASE_URL`）读数为空，插件什么也不写、也不发请求。

写入位置：

```
~/Library/Application Support/Claude Intro 3D/usage.json
```

文件内容形如：

```json
{
  "version": 1,
  "updatedAt": "2026-10-11T08:50:00.462Z",
  "source": "claude-code-session",
  "windows": [
    { "kind": "five_hour", "percentUsed": 34, "resetsAt": "2026-10-11T08:50:00.462Z" },
    { "kind": "seven_day", "percentUsed": 8 }
  ]
}
```

宠物应用读不到这个文件时会退回读取 Claude 自己的 `~/Library/Application Support/Claude/plan-usage-history.json`，但那个文件没有重置时间，所以装上这个插件能让气泡显示更准确的重置时间。

## 安装（在终端里，不是桌面应用的 Code 标签页）

```bash
claude plugin marketplace add <本仓库clone路径>/mod
claude plugin install pet-quota@claude-intro-3d
```

安装时选用户范围（默认），完成后终端会提示「Installed pet-quota. Plugin is now active.」。桌面应用的 Code 标签页本身不能执行 `/plugin install`，但只要在终端装过一次（用户范围），桌面 Code 标签页的本地会话会自动读取到，不需要重复安装；已经开着的会话要重开（或重启 Claude）后才会加载它。插件代码更新后，运行 `claude plugin marketplace update claude-intro-3d` 和 `claude plugin update pet-quota@claude-intro-3d`。

## 卸载

```bash
claude plugin uninstall pet-quota
claude plugin marketplace remove claude-intro-3d
```
