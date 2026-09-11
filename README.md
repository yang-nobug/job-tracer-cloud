# Job Tracer Cloud

Job Tracer 的云端协作版本，面向多用户的求职记录、面经知识库、面试准备与招聘日程管理。

> 当前状态：已完成 Ubuntu、Node.js、Nginx 和公网反向代理的部署链路验证。账号体系、工作空间隔离、PostgreSQL、对象存储与正式生产部署仍在开发中。当前测试实例不能录入真实个人资料或配置真实密钥。

## 当前能力

- 投递、看板、列表、统计、面试安排和动态记录；
- 招聘信息智能录入、面经知识库、答案生成与面试准备；
- 简历、项目档案、招聘邮件扫描与飞书分享等现有业务模块；
- 使用 Nginx 将公网 HTTP 请求反向代理至内部 Node 服务。

## 云端目标架构

```text
Browser
  -> Nginx / HTTPS
  -> Node.js API and Web application
  -> PostgreSQL (workspace-isolated data)
  -> Private object storage (resumes, recordings, screenshots)
  -> Background workers (mail scanning and AI tasks)
```

每位用户拥有独立工作空间。服务端必须从登录会话取得工作空间身份，并对数据库查询、文件读取、邮件配置和 AI 日志统一做权限隔离。

## 本地开发与服务器测试

要求：Node.js 24.x、Python 3.11 或 3.12（仅面试准备 Agent 需要）、Linux 编译工具。

```bash
npm ci
npm run build
PREP_AGENT_DISABLED=1 npm start
```

`npm ci` 若提示 `better-sqlite3` 和 `esbuild` 的安装脚本未批准，执行：

```bash
npm install-scripts approve better-sqlite3 esbuild
npm rebuild better-sqlite3 esbuild
```

测试期 Node 服务默认仅监听 `127.0.0.1:3210`，由 Nginx 对公网提供 HTTP 访问。不要直接开放 3210 或 3211 端口。

## 配置与安全

- `config.json`、`.env`、数据库、上传文件、录音和日志不会提交到 Git；
- 不要将模型 Key、邮箱授权码、OSS 密钥或飞书 Webhook 写入源码；
- 未完成登录和工作空间隔离前，不得把真实求职数据放入公网测试环境；
- 正式上线前必须启用域名、HTTPS、受限 SSH 访问、服务进程守护和自动备份。

## 开发路线

1. 用户、登录、会话与工作空间成员模型；
2. SQLite 迁移至 PostgreSQL，所有业务表按工作空间隔离；
3. 简历、截图、录音和材料迁移到私有对象存储；
4. 邮箱扫描、AI 任务和日志按工作空间隔离；
5. Docker、systemd、HTTPS、备份与监控；
6. 从本地版导入用户个人数据。