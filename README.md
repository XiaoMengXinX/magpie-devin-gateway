# magpie-devin-gateway

把一个Devin账号暴露成OpenAI和Anthropic兼容的HTTP API，供Codex、Claude Code、各类SDK或Floway这样的网关调用。

Devin协议的全部实现来自[magpie-community/plugins](https://github.com/magpie-community/plugins)的`packages/devin`插件。本项目以git submodule原样引用该插件，只在外面加一层HTTP服务和Responses API翻译，因此可以随时拉取插件的上游更新。

本项目是社区作品，与magpie、Cognition（Devin）、Windsurf均无隶属关系。它使用订阅账号的session token调用Devin后端，请自行确认这种用法是否符合Devin的服务条款。

## API

| 接口 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions，支持流式和非流式 |
| `POST /v1/messages` | Anthropic Messages，支持流式和非流式 |
| `POST /v1/responses` | OpenAI Responses，支持流式和非流式 |
| `GET /v1/models` | 账号可用的模型列表 |
| `GET /health` | 健康检查，无需鉴权 |

除`/health`外，请求需携带`Authorization: Bearer <GATEWAY_API_KEY>`或`x-api-key: <GATEWAY_API_KEY>`。

三个对话接口都支持工具调用和reasoning/thinking，行为如下：

- system prompt放在第一条user消息开头，工具描述放在`<tool_descriptions>`文本块中。Devin对system字段的内容策略更严格，插件按Devin CLI的方式这样发送。
- Messages的每个content block单独作为一条prompt发送，带`cache_control`的block对应Devin的`prompt_cache_options{EPHEMERAL}`。
- Claude的thinking签名只按Devin返回的原样回放，网关不生成也不修改签名。Messages直接使用thinking block的`signature`；Responses把签名和thinking原文一起封装在reasoning item的`encrypted_content`中，客户端只回传这个字段也能还原。
- Responses没有`cache_control`字段，网关自动为instructions和最新一条输入打缓存标记。
- 超过8 KiB的请求体以gzip发给Devin；网关收到超过10 MiB的请求体时返回413。
- 对话必须以user消息或tool result结尾，以assistant结尾的prefill请求返回400。
- Devin的内容策略错误原样以400返回，网关不做关键词过滤或任何绕过。

Chat Completions协议没有可以携带签名的字段，Claude的thinking在这条路径上不回放，`cache_control`也不生效；需要这两项时使用Messages或Responses。Responses只翻译`type: "function"`的工具。

模型按族列出，例如`claude-opus-5-5`、`swe-2`。档位由请求参数选择：Chat Completions用`reasoning_effort`，Messages用`thinking`或`output_config.effort`，Responses用`reasoning.effort`。不指定时使用该模型族的默认档位。

## 快速开始

需要Docker Compose 2.30或更新版本，登录时需要Node.js 22或更新版本。

```bash
git clone --recursive https://github.com/XiaoMengXinX/magpie-devin-gateway.git
cd magpie-devin-gateway
cp .env.example .env
```

在`.env`中把`GATEWAY_API_KEY`设为一个随机值，例如`openssl rand -hex 24`的输出。客户端用这个值访问网关。

登录Devin，把token写进`.env`：

```bash
node sign-in.mjs
```

脚本调用插件自带的浏览器登录（经`app.devin.ai`的PKCE流程，回调地址在本机`127.0.0.1`），成功后把session token写入`.env`的`DEVIN_API_KEY`，不在终端输出token。已有token时也可以直接填入`.env`。

启动：

```bash
docker compose up -d --wait
curl http://127.0.0.1:8790/health
```

`devinKey`为`true`表示token已配置。

### 部署在远程服务器

浏览器登录的回调地址在运行脚本的机器上，因此无头服务器需要在本地登录，再把token写到服务器：

```bash
node sign-in.mjs user@server /path/to/magpie-devin-gateway
```

脚本通过ssh的stdin把token写入服务器上的`.env`，然后在该目录执行`docker compose up -d --wait`。token不会出现在命令行参数中。

`compose.yaml`只把端口绑定到`127.0.0.1:8790`。需要让其他容器访问时，在`compose.override.yaml`中增加绑定，该文件已被`.gitignore`忽略。例如让另一个Compose网络的容器通过网桥网关访问：

```yaml
services:
  gateway:
    ports:
      - "172.19.0.1:8790:8790"
```

### 配置项

| 变量 | 说明 |
| --- | --- |
| `GATEWAY_API_KEY` | 必填，客户端访问网关使用的key |
| `DEVIN_API_KEY` | Devin session token（`devin-session-token$…`）或在Devin设置中创建的`cog_…` key；未设置时对话接口返回401 |
| `PORT` | 监听端口，默认8790 |
| `WINDSURF_API_SERVER_URL` | 可选，改变Devin API服务器地址，与Devin CLI的同名变量含义相同 |

`compose.yaml`以`format: raw`读取`.env`：session token包含`$`，Compose默认的变量插值会把token截断。

## 更新插件

```bash
git submodule update --remote upstream
docker compose up -d --build --wait
```

镜像构建的第一阶段运行插件自带的测试和本项目的测试，任一失败时构建中止，正在运行的容器保持不变。可以把这两条命令放进定时任务，持续跟进上游。

## 实现

```
src/
  main.mjs        读取环境变量并启动服务
  server.mjs      HTTP服务：鉴权、请求体大小限制、prefill检查、错误格式、流式转发
  devin.mjs       以单账号加载插件，提供chat、messages和models
  responses.mjs   Responses与Messages之间的请求和事件流翻译
test/
  gateway.test.mjs
upstream/         magpie-community/plugins（git submodule）
sign-in.mjs       浏览器登录并写入token
```

网关只使用插件的三个公开接口：导出的`DevinAuthPlugin`、`auth.loader`返回的`fetch`（处理Chat Completions和Messages），以及`provider.models` hook。只要这三个接口不变，插件内部的改动不影响网关。

Responses请求的所有模型都翻译成Messages交给插件：Messages路径保留每个block的边界，回放Claude带签名的thinking，并把其他模型的thinking以纯文本发回。

客户端断开连接时，网关会取消发往Devin的请求。

## 测试

测试使用Bun运行，与插件保持一致。插件的部分测试会读取HOME下的Devin CLI数据，用临时HOME运行以免受本机登录状态影响：

```bash
HOME=$(mktemp -d) bun test ./upstream/packages/devin ./test
```

`test/gateway.test.mjs`用一个模拟的Devin服务替换`fetch`，解码网关实际发出的GetChatMessage protobuf，检查每种API的请求在线上的形态和返回给客户端的结果。覆盖的内容包括cache标记、system与工具描述的位置、签名回放、gzip、prefill、413和内容策略错误。模型列表使用插件自带的`testdata/model-configs.bin`。

## 许可证

MIT。`upstream/`中的插件遵循其自身的许可证。
