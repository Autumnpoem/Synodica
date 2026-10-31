# ChatGPT Pro 接入

当前项目通过 Codex CLI 使用 ChatGPT 订阅登录。ChatGPT Pro 网页会话、Codex 登录和 OpenAI Platform API Key 是不同入口；这里选择 Codex 的订阅登录。

## 准备和本地登录

先安装官方 Codex CLI，或确认已有安装：

```sh
codex --version
```

然后在运行项目的同一个系统用户下执行：

```sh
codex login
```

在打开的官方页面登录购买 Pro 的 ChatGPT 账号，完成后回到终端。已有有效登录通常无需重复登录。安装和登录以 [OpenAI 官方认证文档](https://learn.chatgpt.com/docs/auth)及其链接的安装入口为准。

## 无桌面的 Ubuntu

在 Ubuntu 的后端运行用户下执行：

```sh
codex login --device-auth
```

按终端显示的官方地址和一次性验证码，在自己电脑或手机上完成授权。官方说明可能要求先在账号安全设置或工作区权限中启用设备码登录；不可用时按官方文档的备用方案操作，不要把登录文件粘贴进聊天。[设备码与无界面登录](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)

## 项目中的配置

1. 打开“设置 → 服务商”。
2. 选择 Codex ChatGPT 订阅，API Key 留空。
3. 在成员资料中选择 Codex 服务商和该账号可用的模型。
4. 检查服务商状态；需要实际验证时，手动发一句简短消息。

填写 OpenAI Platform API Key 会走 API 计费身份，不是上述订阅登录。不要为了查询订阅额度而填一个 API Key。[官方认证与计费区别](https://learn.chatgpt.com/docs/auth)

## 查询额度

在“用量与额度”中找到 ChatGPT / Codex 订阅，点击该卡片的“刷新”。当前实现通过 Codex App Server 的只读额度方法获取数据，不为刷新而发起推理。

页面只显示服务端实际返回的窗口、额度池、使用比例和重置时间；不会把主窗口固定认作五小时，也不会把缺失的周窗口补成零。这里显示的是 Codex 对应的账户额度，不是 ChatGPT 网页所有模型的独立消息上限。

## 遇到问题

- 网页已登录，项目未登录：还要完成实际执行机器上的 Codex CLI 登录。
- 换账号后暂无旧记录：为了避免混用，项目会等当前身份确认后再展示账户数据。
- 能回答但无法查额度：检查 Codex 版本是否支持 App Server 额度查询，再核对卡片错误；不要用反复发送消息来探测额度。
- Ubuntu 重启后丢登录：检查服务用户及持久化目录，见 [多端说明](06-Ubuntu与多端登录位置.md)。
