# ChatGPT／Codex 订阅接入

## 已安装并登录 Codex Desktop

macOS 版星议会优先使用系统 PATH 中的 `codex`；如果未安装，会识别 `/Applications` 或用户应用目录中 ChatGPT／Codex Desktop 自带的 Codex 引擎。已有的 Codex 登录可用时，无需重复安装 CLI，也不用导出或粘贴令牌。

星议调用的是引擎，不会操作 Codex Desktop 的窗口，也不会自动接管你在 Desktop 中的聊天。现有模型、配置文件和凭据存储保持不变。此功能在本机通过引擎版本与登录状态只读检查；其他系统仍需要安装可调用的 Codex 引擎。

打开“设置 → 服务商”，检查 Codex 状态；角色选择 Codex 服务商即可。`default` 使用你已有的 Codex 模型配置。

## 没有可用引擎或尚未登录

安装官方 Codex CLI 后运行 `codex login`，在浏览器完成官方登录。无浏览器回调环境可按官方说明使用 `codex login --device-auth`。登录发生在运行星议后台的同一台电脑、同一系统用户下。

## API 密钥是另一条计费路径

填写 OpenAI API 密钥会使用对应 API 账号，不会变成 ChatGPT Pro 订阅额度。星议不会从浏览器 Cookie 导入账号。

官方资料：[Codex 身份验证](https://learn.chatgpt.com/docs/auth)、[Codex 作为应用运行引擎](https://developers.openai.com/blog/codex-as-a-platform)。
