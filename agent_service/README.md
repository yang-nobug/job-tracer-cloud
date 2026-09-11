# 面试准备 Agent

该目录提供 Python、FastAPI 和 LangGraph 编排的面试准备服务。它只能通过 Node.js 提供的本机内部接口读取上下文、调用统一 AI 客户端，并在用户确认后写入准备清单。

## Linux 环境安装

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/python -m pip install -r agent_service/requirements.txt
```

Node 服务会优先使用 `PREP_AGENT_PYTHON` 指定的 Python；未指定时，Linux 使用 `.venv-agent/bin/python` 或 `python3.11`。

服务启动时需要以下内部环境变量，由 Node 运行时自动注入：

```text
JOB_TRACER_BASE_URL
PREP_AGENT_INTERNAL_TOKEN
PREP_AGENT_CONTROL_TOKEN
PREP_AGENT_CHECKPOINT_PATH
```

业务数据在应用数据库中，LangGraph Checkpoint 单独保存。正式云端版会将二者迁移到按工作空间隔离的云端存储。