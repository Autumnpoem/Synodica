# DeepSeek 官方 API 接入

当前项目接入 DeepSeek 官方开放平台 API，使用该平台的 API Key 和余额。DeepSeek 网页或 App 的登录状态不会自动成为项目的 API 凭据。

## 获取 Key 并配置

在 [DeepSeek 官方开放平台](https://platform.deepseek.com/)登录自己的账号，创建 API Key。打开项目“设置 → 服务商”，选择 DeepSeek 官方 API；没有条目时添加 OpenAI 兼容 API：

| 字段 | 内容 |
|---|---|
| 服务商 ID | deepseek |
| 显示名称 | DeepSeek 官方 API |
| Base URL | https://api.deepseek.com |
| API Key | 官方平台创建的 Key |
| 模型 | 使用官方当前模型列表中的名称 |

这里按官方示例填写 `https://api.deepseek.com`。已有条目使用其他已验证地址时，不需要为了阅读本文而覆盖。保存后到成员资料中选择 DeepSeek 服务商，不会自动修改现有成员分工。[官方 API 入门](https://api-docs.deepseek.com/en/)

## 查看余额

打开“用量与额度”，刷新 DeepSeek API 钱包。余额查询使用官方 `GET https://api.deepseek.com/user/balance`，分别显示币种、总余额、充值余额、赠送余额及 API 可用状态；不同币种不相加，不换算成订阅百分比。[官方余额接口](https://api-docs.deepseek.com/api/get-user-balance/)

刷新不需要发送模型推理。实际发消息、执行任务则会按账号规则消耗 API 用量。没有填写 Key 时显示“未登录或无密钥”，这不等于余额为零。

## 常见问题

- 401：检查 Key 是否正确、是否被撤销以及是否填在 DeepSeek 条目。
- 能查余额但模型调用失败：分别检查余额可用状态、模型名称和请求错误，余额查询成功不代表所有模型都可用。
- 使用代理地址：当前用量查询只识别明确的官方来源，不会把代理 Key 自动发送给 DeepSeek 官方。
- 不要将 Key 发给聊天中的模型，让它帮你测试；通过服务商设置保存，再做有意的查询或调用。
