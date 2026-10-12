# dsh-plugin-cohere

原生 DSH (DeepSeek Harness) 模型 Provider，直连 Cohere v2 Chat API，无中间代理。

- 路由名：`cohere`（插件入口：`llm-cohere`）
- 模型格式：`cohere/<model-id>`（例如 `cohere/command-a-plus-05-2026`）
- 端点：`POST https://api.cohere.com/v2/chat`
- 认证：`Authorization: Bearer <key>`

## 特性

- **对话与流式**：原生支持流式输出与完整 `StreamChunk` 生命周期，精确还原 token 消耗与缓存统计。
- **函数调用 (Tool Calling)**：支持工具调用及参数组装；按每路由的线上能力（`tools` / `strict_tools` 特性）与 Schema 结构自适应发送——不支持工具的路由自动降级为纯文本调用，provider 点名拒绝某字段时只丢该字段重试一次并按路由记住。
- **思考推理 (Reasoning)**：支持 `thinking` 模式（含 `off`、`low`、`high`），根据模型输出上限动态钳制 token 预算。
- **多模态视觉**：内置纯几何长宽比重采样算法，按像素及大小预算处理图片输入，支持自动触发图像卸载（`IMAGE_OFFLOAD_REQUIRED`）。
- **结构化输出与引用**：支持 JSON Mode（`response_format: { type: 'json_object' }`）及 Citations 尾部脚注块生成；均按路由能力开关发送，不支持的模型不会因此 400。
- **Web 端独立卡片**：集成于 DSH 设置页，直接提供 API Key 存取、API 节点配置、模型在线发现与逐行编辑。
- **模型支持**：内置预置 Command A、Command R 以及 Aya 等系列常用模型，同时支持跟随配置节点动态发现端点可用模型。

## 安装到 DSH

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，所以下面两种写法等价（以 `~/.dsh/profiles/<name>` 为例）：

```bash
dsh plugin --profile <name> add dsh-plugin-cohere    # 推荐
```

```bash
cd ~/.dsh/profiles/<name>
pnpm add dsh-plugin-cohere
```

也可以直接在 Web 侧边栏的**插件**页安装。注意 `desktop` profile 由 Electron 持有，npm CLI 会拒绝针对它的插件请求，请在 Desktop 的插件页或内置命令里操作。

包本身已带编译产物（`lib/`），安装即完成，**无需任何构建脚本批准**。

安装后还要做两件事：

1. 在 profile 的 `package.json` 中，向 `dsh.profile.bundles` 数组**追加** `"dsh-plugin-cohere"`（Web 插件页安装会自动选入组合包，命令行安装需手动补）。
2. 重启 DSH，在 **Models** 设置页 Cohere 行的卡片中**填入 API Key**（存入凭据服务，不落盘明文），点击 **从端点刷新模型** 即可使用。

### 其他安装方式

| 方式 | spec | 说明 |
| :--- | :--- | :--- |
| npm 注册表 | `dsh-plugin-cohere` | 推荐；`prepack` 已把 `lib/` 打进 tarball |
| tarball | `pnpm add /abs/path/dsh-plugin-cohere-<ver>.tgz` | 离线分发；同样自带 `lib/` |
| 本地目录 | `pnpm add /abs/path/to/dsh-plugin-cohere` | 直接指向 clone 的仓库，开发用；请**先用绝对路径**，相对路径会被拒绝 |
| git | `pnpm add github:cn47mp/dsh-plugin-cohere` | **需先自行构建**：pnpm 11 默认拦下依赖的构建脚本（`allowBuilds` 未列出的包按未审查处理，`strictDepBuilds` 默认 `true`），而 `prepare` 在全新 clone 中依赖尚未安装、`tsc` 不存在。保持 `lib/` 不入库时，这条路必须先手动 `npm install && npm run build` |

## 开发

```bash
git clone https://github.com/cn47mp/dsh-plugin-cohere.git
cd dsh-plugin-cohere
npm install       # 安装依赖并构建（prepare 钩子会跑 build）
npm run build     # 编译 TypeScript 到 lib/，并把 Web 端客户端代码复制为 lib/client.js
npm run typecheck # 仅执行 TypeScript 类型检查
npm test          # node --test
```

> `test/`、`CHANGELOG.md`、`DESIGN.md`、`WORKLOG.md` 在 `.gitignore` 中，公开仓库不含它们，所以 CI 里的 `npm test` 是没有用例的空跑——测试只在本机有意义。

## 发布

发布走 [`Release`](.github/workflows/release.yml) 工作流，推 `v*` 标签即触发（也可手动 dispatch）。工作流会先跑 typecheck 与测试，再校验标签版本与 `package.json` 的 `version` 一致，并确认 `lib/index.js`、`lib/client.js`、`cordis.patch.yml` 都在包内，才允许发布：

```bash
# 改 package.json 的 version（或 npm version patch --no-git-tag-version）
git commit -am "chore: release v0.1.11"
git tag v0.1.11
git push origin v0.1.11
```

发布凭据用 npm 的 **trusted publishing（OIDC）**：工作流持有 `id-token: write`，npm 用它换取一个短期发布 token，**不需要任何 npm 密钥**，provenance 也会自动签名并写入 sigstore 透明日志。仓库里无需配置 `NPM_TOKEN`；而且**不要**设置 `NODE_AUTH_TOKEN`——环境里的 token 会盖过 OIDC 交换。

**前置条件（npm 侧，一次性）**：在 npmjs.com 该包的 **Settings → Trusted publishing** 添加 GitHub Actions 发布者，字段必须精确匹配 Organization/user = `Cn47mP`、Repository = `dsh-plugin-cohere`、Workflow filename = `release.yml`（Environment 留空）。

没配好时症状很容易误判：`id-token` 仍然拿得到，provenance 照样签名成功并写入 sigstore 日志，前面 8 步全绿，**只有最后那次 registry PUT 回 404**：

```
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-plugin-cohere
```

npm 用 404 而不是 403 来避免泄露包是否存在，所以这个 404 基本等同于"可信发布没配好"，而不是"包不存在"或"版本冲突"。配好后重跑即可：`gh run rerun <run-id> --failed`。

两条实测踩过的坑：

- **npm 必须 ≥ 11.5.1**。Node 22 随附的仍是 npm 10.x，在 npm 10 上 registry 会回 404 而不是签发 token，所以工作流里显式升级 npm 并做版本断言。
- **本机用 token 发布会被 2FA 拦下**：`403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`（0.1.10 那次 tag 发布就是这样失败的，尽管 provenance 已经签好）。要走本机兜底，得用带 2FA bypass 的 granular token，并且必须显式指定官方源（镜像只读）：

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/
```

> `0.1.10` 是唯一的例外：可信发布只能配置在**已存在**的包上，所以首发由本机手动完成，也因此**没有 provenance**。从下一个版本起，CI 发布的每个版本都会自带 provenance。

## 协议车道（v0.2.0）

插件同时接入 Cohere 的两个协议边界，并按请求自动选路：

| 车道 | 端点 | 作用 |
| :--- | :--- | :--- |
| **compat**（默认） | `https://api.cohere.ai/compatibility/v1/chat/completions` | Cohere 维护的 OpenAI 兼容契约；文本、流式、工具调用、`reasoning_effort`、JSON 模式、精确 usage |
| **native** | `https://api.cohere.com/v2/chat` | Cohere 原生 v2；承载兼容层**做不到**的能力 |

选路规则（`wire: 'auto'`）：

- 普通对话、工具调用、`off`/`high` 推理档 → **compat**；
- `includeCitations`、`low` 推理档、请求带图片 → **native**（兼容层对 `citation_options` 直接 422，
  对 `reasoning_effort: 'low'` 直接 422，对 `documents` 会静默丢弃）。

之所以不是"全部走兼容层"，是因为实测发现兼容层对 Cohere 专有字段的处理是**静默丢弃**而非报错：
开了引用却拿不到引用，且没有任何错误可循。这比直接失败更难排查，所以依赖这些能力的请求一律改走原生车道。

`wire` 可设为 `compat` 或 `native` 强制固定车道。若你把 `baseURL` 指向了自己的网关却**没有**
指定 `compatBaseURL`，`auto` 会留在原车道上，不会把请求发往 `api.cohere.ai`；要启用兼容车道，
显式填写 `compatBaseURL` 即可。

## 配置项

| 字段 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `wire` | `auto` | 协议车道：`auto`（按请求自动）/ `compat` / `native` |
| `baseURL` | `https://api.cohere.com/v2` | 原生车道节点（自定义网关 / 私有部署端点） |
| `compatBaseURL` | `https://api.cohere.ai/compatibility/v1` | OpenAI 兼容车道节点；**清空即关闭该车道** |
| `apiKeyEnv` | `COHERE_API_KEY` | 凭据引用名（通过 credentials 服务读取） |
| `providerName` | `Cohere` | 显示名称 |
| `models` | 内置目录 | 覆盖或增补模型配置；缺失时自动补充默认模型。每行可声明 `tools` / `citations` / `strictTools`（默认 `true`），对应 Cohere 该路由的线上 `features` |
| `jsonMode` | `false` | 启用结构化输出（`response_format: { type: 'json_object' }`） |
| `includeCitations` | `false` | 请求引用并在输出末尾生成「引用来源：」脚注块（仅对支持 `citations` 的路由生效；会自动改走原生车道） |
| `strictTools` | `true` | 对支持该特性的路由且符合规范的工具发送 `strict_tools`（兼容车道为工具级 `strict: true`） |
| `requestTimeoutMs` | `120000` | 初始响应头超时（毫秒） |
| `streamIdleTimeoutMs` | `300000` | 流式数据空闲心跳超时（毫秒） |
| `maxRequestImageBytes` | `20971520` (20MB) | 请求包含图片的总 Base64 大小上限 |
| `requestImagePixelBudget`| `4194304` (2048²) | 单图像素缩放预算 |
| `requestImageMaxBytes` | `1048576` (1MB) | 单图编码字节上限 |

## 许可

[MIT](./LICENSE)