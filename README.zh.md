# dsh-teambition

DeepSeek Harness Web GUI 的 Teambition 面板插件。它在侧边栏加入「Teambition」
入口，并在中栏打开整页面板，不用离开 GUI 就能浏览和操作项目与卡片：切换项目、
按看板列查看卡片、新建卡片、把卡片移到其它工作流状态或看板列，以及把某张卡片
放到指定的 DSH 工作区里执行。

面板通过用户自己已登录的浏览器 Cookie 访问 Teambition，Cookie 只存在 Host
侧，不写入浏览器存储，也不会进入模型可见的输出。

## 功能

- 侧边栏入口（`sidebar.panellist`）+ 中栏页面（`main`），走官方 slot 契约挂载，
  不改 DSH 源码 checkout。
- 项目切换器、按列分组的卡片、工作流状态标签、为当前项目新建卡片。
- 卡片操作：在 DSH 中执行、改状态 / 换列、在 Teambition 中打开。
- 工作区绑定：单卡覆盖、项目默认、面板默认，解析顺序为卡片 > 项目 > 默认。
- 面板内的设置视图：Cookie（保存 / 清除）、operator id、端点基址（`api`/`web`）、
  诊断探测、默认工作区、按项目的工作区表。
- 一个模型可见工具 `teambition`：列项目、读项目、建卡、移动卡片、记录工作区绑定。

## 本地构建安装

`@yeezone/dsh-client-ui-teambition` 是双半区 cordis 插件包：node 半区
（`exports "."`）跑在宿主进程里，提供 `POST /teambition/*`；浏览器半区
（`exports "./client"`）由 GUI 以 `/plugins/@yeezone/dsh-client-ui-teambition/client.js`
加载。

```sh
pnpm install
pnpm run build
```

然后把它加进 profile 并重启应用：

```sh
dsh plugin --profile desktop add link:<本仓库路径>
```

bundle patch（`cordis.patch.yml`）会插入 `ui-teambition` 行，profile 启动时两个
半区一起挂载。必须重启桌面应用：只有组合里出现新行，浏览器半区才会加载。

## 数据与隐私

- Host 状态：`$DSH_HOME/teambition/config.json`（`0600`），保存 Cookie、operator
  id、端点基址、工作区绑定、最近一次诊断与最近项目列表；写入是原子的。
- 浏览器半区只拿到 `configured` 和四位 `cookieTail`，Cookie 本身不跨越边界。
- 远端读取走内部 v3 端点 + 候选路径 + `diagnose` 探测，而不是硬编码假设；响应
  预览先脱敏再进设置视图。
- 执行卡片会在绑定的工作区里创建 DSH 会话并提交一条排队 prompt；除了你主动点
  状态 / 换列 / 新建，面板不会写回 Teambition。

## 目录

- `src/core/` - 共享词汇、wire 契约（`protocol.ts`）、Teambition 类型 / 端点 /
  映射 / 脱敏。
- `src/host/` - 配置存储、Teambition REST 服务、HTTP 路由、agent 工具。
- `src/client/` - 中英文词典、API 客户端、面板、侧边栏注册。
- `tests/` - 覆盖两个半区的 vitest 套件。

## 测试

```sh
pnpm test
pnpm run typecheck
```

仓库对本包的规则见 `AGENTS.md`（构建纯度、文案中英对照、双半区清单纪律）。
