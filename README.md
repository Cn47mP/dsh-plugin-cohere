# dsh-plugin-cohere

原生 DSH (DeepSeek Harness) 模型 Provider，直连 Cohere v2 Chat API，无中间代理。

- 路由名：`cohere`（插件入口：`llm-cohere`）
- 模型格式：`cohere/<model-id>`（例如 `cohere/command-a-plus-05-2026`）
- 端点：`POST https://api.cohere.com/v2/chat`
- 认证：`Authorization: Bearer <key>`

## 特性

- **对话与流式**：原生支持流式输出与完整 `StreamChunk` 生命周期，精确还原 token 消耗与缓存统计。
- **函数调用 (Tool Calling)**：支持工具调用及参数组装，按模型与 Schema 结构自适应发送 `strict_tools`。
- **思考推理 (Reasoning)**：支持 `thinking` 模式（含 `off`、`low`、`high`），根据模型输出上限动态钳制 token 预算。
- **多模态视觉**：内置纯几何长宽比重采样算法，按像素及大小预算处理图片输入，支持自动触发图像卸载（`IMAGE_OFFLOAD_REQUIRED`）。
- **结构化输出与引用**：支持 JSON Mode（`response_format: { type: 'json_object' }`）及 Citations 尾部脚注块生成。
- **Web 端独立卡片**：集成于 DSH 设置页，直接提供 API Key 存取、API 节点配置、模型在线发现与逐行编辑。
- **模型支持**：内置预置 Command A、Command R 以及 Aya 等系列常用模型，同时支持跟随配置节点动态发现端点可用模型。

## 安装到 DSH

1. 在目标 profile 目录中安装依赖（以 `~/.dsh/profiles/desktop` 为例）：

   ```bash
   cd ~/.dsh/profiles/desktop
   # 通过 GitHub 安装
   pnpm add github:cn47mp/dsh-plugin-cohere
   # 或通过本地克隆路径安装
   pnpm add <path-to-dsh-plugin-cohere>
   ```

2. 在 profile 的 `package.json` 中，向 `dsh.profile.bundles` 数组**追加** `"dsh-plugin-cohere"`。

3. 重启 DSH，在 **Models** 设置页 Cohere 行的卡片中**填入 API Key**（存入凭据服务，不落盘明文），点击 **从端点刷新模型** 即可使用。

## 配置项

| 字段 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `baseURL` | `https://api.cohere.com/v2` | 自定义网关 / 私有部署端点 |
| `apiKeyEnv` | `COHERE_API_KEY` | 凭据引用名（通过 credentials 服务读取） |
| `providerName` | `Cohere` | 显示名称 |
| `models` | 内置目录 | 覆盖或增补模型配置；缺失时自动补充默认模型 |
| `jsonMode` | `false` | 启用结构化输出（`response_format: { type: 'json_object' }`） |
| `includeCitations` | `false` | 请求引用并在输出末尾生成「引用来源：」脚注块 |
| `strictTools` | `true` | 对支持的路由且符合规范的工具发送 `strict_tools` |
| `requestTimeoutMs` | `120000` | 初始响应头超时（毫秒） |
| `streamIdleTimeoutMs` | `300000` | 流式数据空闲心跳超时（毫秒） |
| `maxRequestImageBytes` | `20971520` (20MB) | 请求包含图片的总 Base64 大小上限 |
| `requestImagePixelBudget`| `4194304` (2048²) | 单图像素缩放预算 |
| `requestImageMaxBytes` | `1048576` (1MB) | 单图编码字节上限 |

## 开发构建

```bash
pnpm install
npm run build     # 编译 TypeScript 并复制 Web 客户端代码到 lib/
npm run typecheck # 仅执行 TypeScript 类型检查
```