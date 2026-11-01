# Google AI Pro 接入

你购买 Google AI Pro 后，当前项目通过 Gemini CLI 的 Google 登录使用对应账号。这里接入的是 Gemini CLI 可用权益；不是把 Gemini 网页中的所有功能搬进项目。

## 先准备

在实际执行任务的机器上安装官方 Gemini CLI。已有安装可先运行：

```sh
gemini --version
```

找不到命令时，按 [Gemini CLI 官方安装说明](https://geminicli.com/docs/get-started/installation/)安装。本文不替你更改现有安装或登录。

## 登录

1. 在运行 Synodica 的同一个系统用户下打开终端。
2. 输入 `gemini`，选择 **Sign in with Google**。
3. 在浏览器中登录购买 Google AI Pro 的那个 Google 账号，并完成官方授权。
4. 返回终端确认已进入 Gemini CLI，再正常退出。

官方说明要求 Pro 或 Ultra 用户使用订阅所属账号；已有缓存登录可供后续非交互调用使用。[Google 官方登录说明](https://geminicli.com/docs/get-started/authentication/)

## 项目中怎么选

打开“设置 → 服务商”，找到 Gemini Google 登录，将 API Key 留空。再到成员资料中把服务商选为 Gemini，选择账号实际可用的模型。

若配置了 Google AI Studio API Key，该配置走的是 API 身份，不能据此判定它正在使用 Google AI Pro 订阅。已有服务器环境变量也可能影响官方工具选择身份，遇到来源不符时先检查启动配置，不要批量清空其他应用的环境变量。

## 怎么确认

先检查服务商状态。需要验证模型回答时，再手动发一句简短消息，这会使用实际额度。若出现权限或模型错误，确认登录账号和所选模型，再看官方工具给出的错误。

当前“用量与额度”中的 Google 卡片会显示“无用量来源”：验收版尚未集成该登录方式的实时额度接口。这不是“没有登录”，也不是余额为零。

## Ubuntu 上怎么处理

登录必须属于运行后端的用户，而不是只在你自己的 Mac 浏览器里登录。远程机器首次授权需要遵循官方工具当时显示的流程；已缓存的登录可用于无界面调用。公司、学校或 Workspace 账号可能还需配置 Google Cloud 项目，按官方登录文档操作。

常见问题：本地可用而服务器不可用，先核对后端用户、HOME、命令是否在服务进程的 PATH 中，以及登录是否属于同一个 Google 账号。


## 不使用命令行的接口接入

“设置 → 服务商 → 添加服务商”中选择“Google AI Studio 接口（单独计费）”，填写 AI Studio 密钥和该账号可用的模型标识。这使用 Google 官方 OpenAI 兼容接口；不通过 Gemini CLI。接口计费与 Google AI Pro 订阅分别计算。

使用 Google 账号订阅时，目前仍由 Gemini CLI 完成登录：运行 `gemini`，选择“使用 Google 登录”，在浏览器完成授权。无需手动导出令牌；Antigravity 登录不会被自动导入。

官方资料：[Gemini CLI 登录](https://geminicli.com/docs/get-started/authentication/)、[Google OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)。
