# Ubuntu 共享办公室部署

本说明对应仓库里的 `deployment/` 模板，由 Codex 编写。先在自己的服务器准备 Node.js 22、npm、HTTPS 域名和反向代理。以下以 `/opt/opengrokbot` 为程序目录、`opengrokbot` 为运行用户；迁移现有办公室时沿用已有用户、令牌、配置和数据目录。

## 程序与目录

把这次交付的源代码放到程序目录。不要把本机的 `node_modules`、`team.json`、`data` 或官方登录缓存作为公开代码上传。

在程序目录执行：

```sh
npm ci
npm run pet:install
npm run typecheck
npm test
npm run test:client
npm run build
```

`pet:install` 安装并校验固定版本原版宠物。无图形服务器不需要为宠物启动 Xvfb。

服务模板使用以下位置：

| 内容 | 位置 |
|---|---|
| 程序 | `/opt/opengrokbot` |
| 运行账号 HOME | `/home/opengrokbot` |
| 办公室配置 | `/var/lib/opengrokbot/config/team.json` |
| 聊天、头像与项目记录 | `/var/lib/opengrokbot/data` |
| 私有环境文件 | `/etc/opengrokbot/office.env` |

首次部署才建立对应用户和目录，保证服务用户能写配置、数据和项目工作目录。首次启动没有团队配置时会建立默认配置；已有配置不要覆盖。项目实际文件夹也要备份，不能只备份聊天记录。

## 服务和 HTTPS

1. 把 `deployment/office.env.example` 复制为 `/etc/opengrokbot/office.env`，权限设为 `600`，由管理员编辑。把占位令牌换成自己的长随机值；迁移时继续使用旧办公室令牌。将允许来源换成真实的 HTTPS 根网址。
2. 把 `deployment/opengrokbot.service` 放到 `/etc/systemd/system/`。确认 Node 和官方 CLI 位于模板的 PATH 中；如装在其他位置，把实际路径加入服务 PATH。
3. 把 `deployment/Caddyfile` 的域名换成自己的域名，纳入已安装 Caddy 的配置。模板反向代理到 `127.0.0.1:4310`，并让事件流及时传输。按服务器已有方式配置域名、HTTPS 和对外端口。
4. 执行以下命令启动并查看状态：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now opengrokbot
sudo systemctl status opengrokbot
sudo journalctl -u opengrokbot -n 100 --no-pager
```

模板让后端只监听本机，由 HTTPS 代理对外提供页面。`OPENGROKBOT_TRUST_PROXY=1` 配合这个本机代理使用。不要把示例中的占位令牌原样上线。

## 模型账号

官方 CLI 的登录必须属于 `opengrokbot` 这个执行用户；在管理员账户登录不会自动共享。先确认服务用户能执行所需的 `codex`、`claude`、`gemini`，然后逐家按[订阅文档](subscriptions/README.md)完成授权。Kimi Code 和 DeepSeek Key 在服务器办公室的“设置 → 服务商”保存。

Mac/Windows App 和手机网页登录的是办公室；这不会代替 Ubuntu 上的模型登录。不要把浏览器 Cookie 或整套钥匙串导入服务器。

## 验收与更新

先用电脑和手机打开同一个 HTTPS 网址登录。只创建测试项目，检查另一个页面是否能即时看到新项目和头像变化；断开网络后重新连接，应恢复服务器最新状态。再用已经授权的成员进行一次真实对话，确认执行账号和模型符合预期。

更新前备份配置、数据、项目文件和私有环境文件。停止服务、更新程序、安装依赖和构建，再启动服务。更新代码不需要更换模型密钥。重启后已经中断的工作需要用户检查并决定继续，避免重复执行外部操作。

这份模板没有替你修改公网服务、DNS 或防火墙。桌面客户端使用见 [桌面端与新功能](桌面端与新功能.md)。
