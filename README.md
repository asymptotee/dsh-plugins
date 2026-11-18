# dsh-plugins

DeepSeek Harness 插件工程：一组独立、可组合的 dsh 插件，装进任意 profile，
与 `dsh-terminal` 这类前端平行共存、互不 import。

## 结构

```
src/
  index.ts             包入口：re-export 全部公开面
  shared/              共享层：结构化 face 类型、effort 词汇与降级策略
  picker/              共享 picker 契约：waterfall 请求/应答 + askPicker
  command-effort/      `/effort` 命令 + 选档弹窗（kind: scale）
  command-model/       `/model` 命令 + 路由弹窗（kind: list）
  command-context/     `/context` 命令：会话 token 报告
  command-rename/      `/rename` 命令：会话标题（显式或重新生成）
tests/
  effort.spec.ts       fake context 验证注册形状、handler、waterfall 往返
  ...
cordis.patch.yml       组合层：每个插件一行 loader row
```

**单包多子路径**：一个 npm 包（`dsh-plugins`），各插件经子路径导出
（`dsh-plugins/effort`、`dsh-plugins/shared`）。加新插件 = 加一个 `src/<name>/` 目录
+ `package.json` 的 exports 一行 + `cordis.patch.yml` 一行 row；profile 的 bundle
列表永远只有 `dsh-plugins` 一项。

## 构建与装机

```sh
pnpm install
pnpm run verify                                   # typecheck + 全部测试
pnpm run build                                    # tsc → lib/
pnpm pack                                         # dsh-plugins-0.1.0.tgz

dsh plugin --profile <profile> remove dsh-plugins
dsh plugin --profile <profile> add /path/to/dsh-plugins-0.1.0.tgz
```

## 插件契约

插件与前端之间只通过 **Context 服务 + waterfall 事件** 交互，互不 import：

- `/effort <level>` 直设走 `agent.model.select()`（追加持久 `model/selection` 事件，恢复后仍在）
- `/effort off` 清除选择，回到模型默认
- 裸 `/effort` 派发 `effort-picker/request` waterfall：有前端应答则弹选择器，
  无应答者自动降级为纯文本报告（headless/web 场景直接可用）
- 请求里携带的档位已做描述回填（适配器披露的优先，常见 id 用内置文案）
- 不可用的档位回退到**最近的更低档**（`max`→`high`），绝不向上推

前端侧按 payload shape 应答，不依赖本工程任何类型——`dsh-terminal` 的
`effort-picker/request` 监听器就是例子。

## 边界纪律

- `@deepseek-ai/*` 由 profile 提供，只声明 `peerDependencies`，绝不内联进产物
- 上游服务以结构化 face 读取（`shared/` 里定义），不绑死上游类型身份
- 状态写入一律走上游服务 API（`agent.model.select`），不直接 `session.append` 事件

## 测试

`pnpm test` 跑 vitest；用 fake context 验证注册形状、handler 行为与 waterfall 契约。