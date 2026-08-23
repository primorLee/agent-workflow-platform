<div align="center">
  <img src="apps/desktop/public/awp-mark.svg" alt="Agent Workflow Platform" width="96">
  <h1>Agent Workflow Platform</h1>
  <p><strong>让长时间运行的 Agent 工作真正活过故障、断线和换 Session。</strong></p>
  <p>
    一套面向 Agent CLI 的本地优先桌面端、控制面、Worker Runtime 与持久化工作流系统：
    即使进程崩溃、网络中断、多个 Agent 并发或会话重启，任务仍能继续。
  </p>
  <p>
    <a href="#开始运行"><strong>开始运行</strong></a> ·
    <a href="#系统如何协作">系统架构</a> ·
    <a href="#围绕真实故障设计">生产经验</a> ·
    <a href="docs/getting-started.md">完整文档</a> ·
    <a href="README.md">English</a>
  </p>
  <p>
    <a href="https://github.com/primorLee/agent-workflow-platform/actions/workflows/ci.yml"><img src="https://github.com/primorLee/agent-workflow-platform/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/local--first-no%20account-16a34a.svg" alt="本地优先，无需账号">
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-475569.svg" alt="Windows、Linux、macOS">
  </p>
</div>

![Agent Workflow Platform 桌面端](apps/desktop/docs/desktop-demo.png)

大多数 Agent Demo，恰好停在真实工作开始的地方。

终端被关掉；网络请求成功了，但确认消息丢了；两个 Agent 同时领取了同一任务；
新 Session 记得结论，却不知道下一步究竟该执行什么；一次心跳延迟，Guardian 就把
仍在工作的任务误判为停止。

Agent Workflow Platform（AWP）把这些失败本身当成产品需要解决的问题。它给已有
Agent CLI 补上桌面体验、本地控制面、可信 Worker、持久化运行状态、恢复循环、审核
协议与运维工具，同时不强迫你把 Agent 的推理逻辑迁移到另一套框架。

这不是 Prompt 合集，也不是为了开源临时重写的干净玩具。它来自一个已经停止商业化、
但真实运行过六个月 Agent 任务的产品；公开版本保留经过事故检验的实现与回归测试，
并加入了 fail-closed 的公开发布边界。

## 从你需要的部分开始

| 你想做什么 | 从这里开始 |
| --- | --- |
| 先看到完整产品体验 | 运行无需账号的 [Electron 桌面演示](#2-启动桌面工作台) |
| 跑通真正的任务闭环 | 运行 [Docker Compose 本地闭环](#1-跑通完整本地任务闭环) |
| 让现有仓库具备跨 Session 恢复能力 | 使用[独立工作流 Runtime](#3-给任意仓库加入可恢复工作流) |
| 构建自己的 Agent 产品 | 分别复用[控制面](services/control-plane/README.md)、[Worker](services/worker-agent/README.md) 与[部署模式](deploy/README.md) |

## 你会得到什么

| | |
| --- | --- |
| **桌面工作台**<br>Electron + Vue、流式工具事件、重启后仍可恢复的对话与产物、受约束的桌面桥接、诊断、SSH Host Key 固定，以及隔离的 Stable/Preview 通道。 | **持久化工作流 Runtime**<br>依赖感知调度、跨进程锁、原子任务领取、Checkpoint、Guardian 恢复、角色分离审核，以及从失败沉淀 Recipe 的飞轮。 |
| **本地控制面**<br>FastAPI、SQLite/WAL、带鉴权的任务 SSE、Worker 注册、心跳、Session、健康检查、限流、脱敏日志和 Prometheus 指标。 | **两套 Worker 模型**<br>带崩溃安全离线结果队列的 Python 轮询 Worker，以及具备重连、准入、取消、进程监管、Watchdog 和重放包的 Go WebSocket Worker。 |
| **运维层**<br>Docker Compose、严格 Redis 选择、随机密钥引导、Loopback Gateway、健康探针、SQLite WAL 备份/恢复、systemd、Prometheus 和 Grafana。 | **公开发布门禁**<br>跨平台验证、完整历史密钥扫描、Manifest 与链接检查、不安全 Fixture 拒绝、Go 离线验证、Race Detector 和构建产物复扫。 |

## 开始运行

### 环境要求

| 运行路径 | 本地要求 |
| --- | --- |
| 完整本地任务闭环 | Docker Engine 或 Docker Desktop with Compose、Python 3.12 |
| 桌面工作台 | Node.js 22.12 或更高版本 |
| 独立工作流 Runtime | Python 3.10 或更高版本 |
| Go VM Agent 开发 | Go 1.25.13，以 [go.mod](services/vm-agent/go.mod) 为准 |

先克隆仓库：

~~~bash
git clone https://github.com/primorLee/agent-workflow-platform.git
cd agent-workflow-platform
~~~

### 1. 跑通完整本地任务闭环

这是最推荐的端到端入口。它会启动真实 FastAPI 控制面、Redis Broker、Python
Worker、随机密钥引导任务和 Loopback Gateway：

~~~bash
docker compose -f deploy/local/docker-compose.local-dev.yml up -d --build
python scripts/wait_for_http.py http://127.0.0.1:8100/v1/health/ready --timeout 120 --json-field database
python scripts/submit_local_task.py --timeout 60
~~~

最后一条命令会提交一个允许列表内、完全不经过 Shell 的 Python 任务，等待 Worker
注册、领取和执行，再打印返回结果。辅助脚本会自动读取生成的 API Key，但不会把它
输出到终端。

保留状态并停止 Stack：

~~~bash
docker compose -f deploy/local/docker-compose.local-dev.yml down --remove-orphans
~~~

只有明确要删除本地数据库、Worker Queue、Redis 数据和生成的密钥时，才额外使用
<code>-v</code>。

### 2. 启动桌面工作台

~~~bash
npm --prefix apps/desktop ci
npm --prefix apps/desktop run demo:electron
~~~

演示命令会干净构建 Renderer、Electron Main 和 Preload，然后启动真实 Electron
应用并连接项目自带的确定性 Loopback Adapter。它不需要账号，不会发送托管登录
请求，并且能在重启后恢复对话状态。

确定性回复不是 LLM，也不会被包装成 LLM。这个演示证明的是实际 UI、受限 HTTP
客户端、SSE 解析与渲染、持久化历史与产物契约，以及 Electron 生命周期。接入真实
Agent CLI 是一个显式 Adapter 选择；仓库不会捆绑任何专有 Provider 二进制。

只运行浏览器开发模式：

~~~bash
npm --prefix apps/desktop run dev
~~~

### 3. 给任意仓库加入可恢复工作流

Scheduler 和 Guardian 只使用 Python 标准库。所有可变状态默认位于已忽略的
<code>.agent-workflow/</code> 目录：

~~~bash
python workflows/runtime/scheduler.py add "Create a deterministic smoke test" 2 --group reliability
python workflows/runtime/scheduler.py heartbeat
python workflows/runtime/scheduler.py checkpoint "Run the regression and attach its output"
python workflows/runtime/guardian.py resume
~~~

写入 Checkpoint 后停止当前进程，再从新终端或新 Agent Session 执行最后一条命令。
恢复指令来自持久化状态，而不是聊天记忆。

调度模式、审核角色、六阶段复现门禁和事故 Recipes 见
[工作流指南](workflows/README.md)。

## 系统如何协作

~~~mermaid
flowchart TB
    subgraph Experience["体验层"]
        Desktop["Electron / Vue 桌面端"]
        Chat["项目自带 Chat + SSE Adapter"]
        CLI["显式配置的 Agent CLI Adapter"]
        Admin["只读管理端"]
        Mobile["Expo 监控端"]
        Desktop --> Chat --> CLI
    end

    subgraph Control["本地控制面"]
        API["FastAPI 任务与 Session API"]
        Broker["内存或严格 Redis Broker"]
        DB[("私有 SQLite / WAL")]
        API <--> Broker
        API <--> DB
    end

    subgraph Execution["执行层"]
        PyWorker["Python 轮询 Worker"]
        Process["允许列表内的可信进程"]
        VmAgent["Go VM Agent"]
        VmBroker["兼容的下游 WS Broker"]
        PyWorker --> Process
        VmAgent -.-> VmBroker
    end

    subgraph Workflow["持久化工作流层"]
        Scheduler["Scheduler + 审核门禁"]
        Guardian["Guardian 恢复"]
        State[("原子文件状态")]
        Scheduler <--> State
        Guardian <--> State
    end

    Desktop -. 可选监控 .-> API
    Admin --> API
    Mobile -. 兼容 API .-> API
    PyWorker <--> API
    Scheduler -. 可选 Adapter .-> API
    Metrics["Prometheus / Grafana"] --> API
~~~

桌面 Chat Adapter、FastAPI 控制面、文件持久化工作流 Runtime 和 Go VM 协议是四套
刻意分开的契约。虚线代表扩展边界，不代表隐藏路由。已经验证的 Compose 闭环使用
Python Worker。

完整说明见[架构与信任边界](docs/architecture.md)。

## 围绕真实故障设计

AWP 最重要的能力最初都是事故修复。只要公开仓库能安全复现对应问题，就同时保留
机制和可执行回归，而不只留下一个“看起来实现了”的源文件。

| 发生了什么 | 系统如何处理 | 直接查看 |
| --- | --- | --- |
| 进程或 Session 在完成部分工作后消失 | 原子保存 Checkpoint，并重建精确恢复指令 | [Scheduler](workflows/runtime/scheduler.py)、[Guardian](workflows/runtime/guardian.py) |
| 多个 Agent 同时更新同一 Run | 用 OS 锁覆盖读取、领取、更新和原子替换的完整事务 | [Workflow Validator](workflows/validation/validate_workflows.py) |
| Worker 完成任务时网络中断 | 持久化结果、恢复孤儿 Claim，并按 FIFO 重放 | [Python Worker](services/worker-agent/cloud_client.py)、[Go Queue](services/vm-agent/internal/queue/queue.go) |
| SSE 客户端在订阅与 Snapshot 之间重连 | 先订阅、再读取权威 Snapshot，并保证退订 | [SSE Route](services/control-plane/cloud/routes/events_stream.py) |
| SQLite 繁忙，或在线数据库需要备份 | 使用 WAL 感知并发，并在回归中真实恢复备份 | [运维测试](ops/tests/test_ops.py) |
| 一次心跳延迟 | 连续失败达到阈值后才告警，并应用冷却时间 | [滞回验证](scripts/verify_guardian_hysteresis.py) |
| 新版本进程存活但流量不健康 | 保留不可变版本，并恢复上一个 Stable Candidate | [Rollout Library](services/control-plane/cloud/rollout.py) |

完整事故与机制说明见[生产经验](docs/production-lessons.md)。

## 项目边界

好的开源项目应该明确告诉你哪些能力现在能跑，哪些是可组合库，哪些没有假装开源。

### 现在即可运行

- 完整的本地任务创建 → Worker 领取 → 执行 → 结果返回闭环
- 无需账号、支持持久化历史与产物的 Electron 和浏览器演示
- 独立 Scheduler、原子 Batch Claim、Checkpoint、审核角色、Recipes 与 Guardian 恢复
- 只读 Admin 和移动监控端
- Prometheus/Grafana 指标示例与 SQLite WAL 备份/恢复工具

### 经过测试的可组合库

- Go VM WebSocket 协议、SQLite Queue/Replay 和产物上传
- 健康门控 Rollout 状态机
- Fail-closed 的 OS User Workspace Helper

这些库有测试，但不会偷偷接入公开 FastAPI Demo 或默认 Go
<code>main</code>。准确的组合边界见[架构文档](docs/architecture.md)。

### 明确没有发布

- 托管商业服务、账号自动化、私有中继、客户数据或原产品身份
- 公共 VM Broker、VM Agent 自动更新器或远程多租户部署
- 捆绑的专有 Agent CLI
- 对任意不可信代码的安全隔离
- 已签名桌面安装包或官方 Release Tag

Python 与 Go Worker 都是可信任务启动器，不是 OS Sandbox。不可信任务必须运行在
无法读取宿主凭据的独立 VM、容器或 OS Identity 内。

## 仓库导航

| 路径 | 包含内容 |
| --- | --- |
| [apps/desktop](apps/desktop/README.md) | Electron/Vue 工作台、本地 Adapter、生命周期、打包和 UI 测试 |
| [apps/admin](apps/admin/README.md) | 只读 Vue 控制面监控端 |
| [apps/mobile](apps/mobile/README.md) | Expo 移动监控 Harness |
| [services/control-plane](services/control-plane/README.md) | FastAPI 任务、Session、Worker、SSE 服务和组合库 |
| [services/worker-agent](services/worker-agent/README.md) | Python 轮询 Worker、私有状态和离线结果重放 |
| [services/vm-agent](services/vm-agent/README.md) | Go WebSocket Worker、进程监管、Queue/Replay、产物和打包 |
| [workflows](workflows/README.md) | Scheduler、Guardian、角色、命令、Schema、Template 和 Recipe |
| [deploy](deploy/README.md) | 本地 Compose 与可观测性示例 |
| [ops](ops) | 健康探针、锁、WAL 备份、systemd 和回滚模式 |

## 验证项目

跨平台 Validator 可以只运行你关心的部分：

~~~bash
python scripts/doctor.py --component core
python scripts/validate.py --component static --component workflows
python scripts/validate.py --component control-plane --component worker-agent
python scripts/validate.py --component operations
~~~

组件门禁还覆盖 Desktop、Admin、Mobile 和 Go VM Agent。公开 CI 同时在 Windows、
Linux 和 macOS 上验证：

- Gitleaks 与 TruffleHog 完整历史扫描；
- 公开边界、Manifest、链接与生成产物检查；
- 控制面、Worker、Workflow、Desktop、Admin、Mobile 和运维测试；
- 真实 Docker Compose 任务闭环；
- Go 测试、Replay 压测、Race Detector、Vet、Build、模块完整性与可达漏洞扫描。

Validator 不会隐式安装组件依赖，也不会偷偷访问托管服务。完整开发矩阵见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [上手指南](docs/getting-started.md) — 各平台环境与所有可运行路径
- [系统架构](docs/architecture.md) — 契约、数据流和信任边界
- [生产经验](docs/production-lessons.md) — 塑造当前设计的真实故障
- [工作流索引](workflows/INDEX.md) — 命令、模式、角色、Template 和 Recipe
- [桌面端用户指南](apps/desktop/USER_GUIDE.md) — UI 与本地工作流
- [安全策略](SECURITY.md) — 安全问题报告渠道与运行假设
- [公开发布边界](docs/public-release-boundary.md) — 发布门禁会拒绝什么
- [来源说明](PROVENANCE.md) — 代码来源与抽取规则

## 项目来源与公开发布

AWP 是一个已停止商业化的 Agent CLI 产品中可以通用化的核心。公开仓库保留真实运行
后留下的实现和回归测试，同时删除凭据、客户数据、私有网络拓扑、托管商业与身份集成、
原产品身份，以及专用领域工作流。

项目从新的 Git 历史开始，因此被删除的私有材料无法从旧提交中恢复。公开边界由本地
验证和 CI 自动执行，而不是只依赖一次人工检查。

## 参与贡献与安全报告

欢迎 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，让新增
集成保持显式边界，并为每个被修复的故障模式补充回归测试。

安全问题请按照 [SECURITY.md](SECURITY.md) 使用 GitHub Private Security Advisory
报告。不要在公开 Issue 中粘贴凭据、私有路径或利用细节。

## 许可证

[MIT](LICENSE)