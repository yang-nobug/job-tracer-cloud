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
  -> Private server file storage (resumes, recordings, screenshots)
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

## PostgreSQL 数据库底座

云端版使用服务器本机的 PostgreSQL，连接串仅通过环境变量 `DATABASE_URL` 提供。参考 [`.env.example`](.env.example)；正式服务器应把实际值写入 `/etc/job-tracer/job-tracer.env`，不要在项目目录创建或提交真实 `.env` 文件。

数据库结构以 SQL 迁移的方式提交在 `server/src/database/migrations`。常用命令：

```bash
# 根据 TypeScript schema 生成新的 SQL 迁移（仅开发时执行）
npm run db:generate

# 对已配置 DATABASE_URL 的 PostgreSQL 执行尚未应用的迁移
npm run db:migrate

# 仅检查数据库是否可连接，不修改数据
npm run db:check
```

第一份迁移只创建云端身份和工作区基础表：`users`、`workspaces`、`workspace_members`、`sessions`。现有业务仍使用临时 SQLite 数据库，后续会按模块迁移并加入 `workspace_id`，不会把不同用户的数据合并在一起。

## 开发路线

1. 用户、审批注册、登录、会话与工作空间成员模型；
2. SQLite 迁移至 PostgreSQL，所有业务表按工作空间隔离；
3. 简历、截图、录音和材料迁移到服务器私有文件目录；
4. 邮箱扫描、AI 任务和日志按工作空间隔离；
5. Docker、systemd、HTTPS、备份与监控；
6. 从本地版导入用户个人数据。

## 账号审批与首次管理员

公开页面只允许提交注册申请。管理员在“账号与访问管理”中批准申请后，系统才会创建账号和个人工作区；申请中保存的密码哈希会随审批结果清除。首次管理员仅能由服务器终端创建一次：

```bash
export DATABASE_URL='postgresql://job_tracer:数据库密码@127.0.0.1:5432/job_tracer'
export BOOTSTRAP_ADMIN_EMAIL='你的邮箱'
export BOOTSTRAP_ADMIN_DISPLAY_NAME='管理员昵称'
export BOOTSTRAP_ADMIN_PASSWORD='至少12位的登录密码'
npm run auth:bootstrap
unset DATABASE_URL BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_DISPLAY_NAME BOOTSTRAP_ADMIN_PASSWORD
```

当前阶段，账号与审批数据已经使用 PostgreSQL；投递、日程、知识库等既有业务仍在 SQLite，尚未按 `workspace_id` 隔离。因此不能把“账号已登录”误认为“业务数据已完成多用户隔离”。业务数据迁移完成前，后端只允许平台管理员访问既有业务接口；已批准的普通用户会看到迁移提示页，避免看到共享旧数据。
