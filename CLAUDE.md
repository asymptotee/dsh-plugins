# dsh-plugins 工作流约定

## 工程定位

独立于 `dsh-terminal` 的插件工程。前端（dsh-terminal）与本工程之间只靠 **Context 服务与
waterfall 事件**耦合，**互不 import**，各自独立演进。

## 加一个新插件

1. `src/<name>/index.ts`（`apply`）+ `src/<name>/types.ts`（对外契约）
2. `package.json` 的 `exports` 加子路径 `./<name>`
3. `src/index.ts` 补 re-export
4. `cordis.patch.yml` 的 `insert` 加一行 `name: 'dsh-plugins/<name>'`
5. `tests/<name>.spec.ts`
6. `pnpm run verify && pnpm run build`

## 构建产物与装机（用户要求由 Claude 执行）

```sh
pnpm -C ~/claude_workspace/dsh-plugins run verify
pnpm -C ~/claude_workspace/dsh-plugins run build
pnpm -C ~/claude_workspace/dsh-plugins pack
dsh plugin --profile dsh-terminal remove dsh-plugins
dsh plugin --profile dsh-terminal add ~/claude_workspace/dsh-plugins/dsh-plugins-0.1.0.tgz
```

安装后确认 profile 的 bundles：
`node -p "JSON.stringify(require('/home/zhangxu/.dsh/profiles/dsh-terminal/package.json').dsh.profile.bundles)"`
—— 应只有 `["@deepseek-ai/dsh-base","dsh-terminal","dsh-plugins"]` 三项。

## 版本约定

- 跟随上游 `0.2.2-rc.x` 线；上游破坏性变更时先改 `peerDependencies` 与 `shared/` 的结构化
  face，再跑 `pnpm run verify`
- `@deepseek-ai/*` 由 profile 提供，必须单实例，绝不内联进产物

## 验证命令

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run
pnpm run verify      # 两者聚合
```

## 禁止事项

- 不在插件里 `import` `dsh-terminal`（前端是可选消费者，不是依赖）
- 不把 `@deepseek-ai/*` 打进包产物（只声明 peer）
- 不在 handler 里直接 `session.append` 上游事件：走服务 API，事件格式是上游内部契约