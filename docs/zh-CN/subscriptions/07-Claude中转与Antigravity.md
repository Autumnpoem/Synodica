# Claude 兼容中转与 Antigravity

星议可以单独添加使用 Anthropic Messages 协议的 Claude Code 网关。不会改动原有 Claude 官方服务商、全局 Claude 配置或登录文件。

1. 准备你已有网关的根地址、该网关专用的密钥以及准确的模型标识。
2. 打开“设置 → 服务商 → 添加服务商”，选择“Claude 中转／Antigravity 代理”。
3. 填写地址，不带 `/v1/messages`；按网关文档选择“接口密钥（x-api-key）”或“网关令牌（Bearer）”。
4. 填写模型标识，保存，再在角色资料中选择这个新服务商。官方角色不会自动切换。

Antigravity 有多个第三方代理实现；本功能连接其兼容接口，不捆绑或自动安装代理，不读取 Antigravity 的 Google 登录文件。代理自身的登录在它提供的界面完成。无鉴权的本地代理也应填写其文档允许的占位凭据，星议不会把官方订阅凭据当作中转凭据使用。更换地址的来源域名时，必须重新输入新网关的密钥，旧密钥不会自动带过去。

第三方代理不是 Google 或 Anthropic 官方的订阅接入。所用项目明确报告了账号受限风险；具体使用权限和模型可用性由该服务决定。星议不把中转的用量当作 Claude 官方订阅额度显示，也不会为了查询余额向未知网关发送官方密钥。

参考：[Claude 网关配置](https://code.claude.com/docs/en/llm-gateway)、[Antigravity Claude Proxy 项目说明](https://github.com/badrisnarayanan/antigravity-claude-proxy)。
