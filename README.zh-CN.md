<div align="center">
  <img src="apps/desktop/public/awp-mark.svg" alt="Agent Workflow Platform" width="96">
  <h1>Agent Workflow Platform</h1>
  <p><strong>开发 Agent 产品，从一套完整底座开始。</strong></p>
  <p>
    为 Agent 产品开发者准备的开源全栈底座：桌面客户端、控制面、Worker Runtime、
    多 Agent 工作流、管理端和运维体系，全部可以直接运行或按模块集成。
  </p>
  <p>
    <a href="#开始运行"><strong>开始运行</strong></a> ·
    <a href="#完整产品技术栈">平台能力</a> ·
    <a href="#系统如何协作">系统架构</a> ·
    <a href="docs/getting-started.md">完整文档</a> ·
    <a href="docs/assets/brand/README.md">品牌素材</a> ·
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

## Agent 之外的产品层

模型、Agent SDK 和 CLI 解决“Agent 如何思考与调用工具”。把这套能力交付成真正的
产品，还需要另一整套基础设施：用户界面、任务与 Session API、执行 Worker、
多 Agent 协作、管理端、可观测性、更新、部署和故障恢复。

Agent Workflow Platform（AWP）就是这层产品化底座。你带来模型、Agent Runtime
或 CLI，以及自己的领域逻辑；AWP 直接提供周围可复用的通用工程。

**当前真正接通的范围：** Desktop ↔ 一个 OpenAI-compatible 模型 ↔ 一个托管任务工具
↔ FastAPI 控制面 ↔ Python Worker。文件工作流 Runtime、Go VM Agent 组合库、Admin
与 Mobile 都有真实实现和独立测试，但没有全部预接到这一轮对话里。

| 你负责 | AWP 直接提供 |
| --- | --- |
| 模型、Agent SDK、Runtime 或 CLI | Electron 桌面体验、流式输出、对话、产物、设置和诊断 |
| 领域工具、Prompt 与业务逻辑 | 任务/Session 控制面、Worker 执行、多 Agent 工作流、审核门禁与恢复 |
| Provider 与部署选择 | 显式 Adapter、本地优先默认值、Admin/Mobile 监控、打包通道、指标和运维模式 |

你可以把整套仓库作为 Agent 产品起点，也可以只拿其中一个模块。各部分通过显式契约
组合，AWP 不要求你替换 Agent 原本的推理或工具调用方式。

![AWP 产品化总览：带来你的 Agent 核心，交付完整产品](docs/assets/readme/productization-overview.png)

这不是 Prompt 合集，也不是为了开源临时重写的干净玩具。它来自一个已经停止商业化、
但真实运行过六个月 Agent 任务的产品；公开版本保留经过事故检验的实现与回归测试，
并加入了 fail-closed 的公开发布边界。

## 选择你的起点

| 你想做什么 | 从这里开始 |
| --- | --- |
| 验证模型到 Worker 的整条参考链路 | 先启动 Compose，再运行 `python scripts/launch_local_agent_desktop.py --model <模型名>` |
| 在桌面产品壳中接入真实模型 | 运行 [OpenAI-compatible 黄金路径](#2-在-desktop-中运行真实模型) |
| 验证后端到 Worker 的完整执行链 | 运行 [Docker Compose 本地闭环](#1-跑通完整本地任务闭环) |
| 给现有产品加入多 Agent 编排 | 使用[独立工作流 Runtime](#4-给任意仓库加入可恢复工作流) |
| 保留已有 Agent Runtime | 分别集成[控制面](services/control-plane/README.md)、[Worker](services/worker-agent/README.md) 与[部署模式](deploy/README.md) |

## 完整产品技术栈

| | |
| --- | --- |
| **产品界面**<br>Electron + Vue 桌面工作台、只读 Admin 和 Expo Mobile 监控端，包含流式输出、对话、产物、设置、诊断与受约束的原生桥接。 | **控制面**<br>FastAPI 任务/Session API、SQLite/WAL、带鉴权 SSE、Worker 注册、心跳、健康检查、限流、脱敏日志和 Prometheus 指标。 |
| **执行 Runtime**<br>Python 轮询 Worker 与 Go 出站 WebSocket Agent，包含命令准入、取消、进程监管、Watchdog、私有状态和离线结果重放。 | **多 Agent 工作流系统**<br>依赖感知调度、跨进程锁、原子 Batch Claim、Checkpoint、Guardian 恢复、角色分离审核、复现门禁和可复用 Recipes。 |
| **部署与运维**<br>Docker Compose、严格 Redis 选择、随机密钥引导、Loopback Gateway、健康探针、SQLite WAL 备份/恢复、systemd、Prometheus 和 Grafana。 | **发布工程**<br>Stable/Preview 通道隔离、跨平台验证、完整历史密钥扫描、Manifest 与产物门禁、Go 离线验证、Race Detector 和回滚模式。 |

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

### 2. 在 Desktop 中运行真实模型

仓库内置的参考 Adapter 会把 OpenAI-compatible Chat Completions 接口转换成
AWP Desktop 使用的长生命周期 Agent CLI 子进程协议。使用本地 Ollama-compatible
接口时，只需要提供已经下载好的模型名：

~~~powershell
npm --prefix apps/desktop ci
$env:AWP_AGENT_MODEL='llama3.2'
npm --prefix apps/desktop run openai-compatible:electron
~~~

~~~bash
npm --prefix apps/desktop ci
AWP_AGENT_MODEL=llama3.2 npm --prefix apps/desktop run openai-compatible:electron
~~~

这条链路使用真实 Electron 应用，启动真实本地 CLI 进程，把 Provider 的流式响应送入
正常 UI 事件管线，并持久化模型 Session，使应用重启后能通过 `--resume` 恢复。远程
兼容接口还必须显式配置 `AWP_AGENT_API_BASE_URL`、`AWP_AGENT_API_TOKEN` 和
`AWP_AGENT_REMOTE_API_OPT_IN=1`。

参考 Adapter 默认只负责聊天。先启动本地 Compose Stack，再用下面一条命令显式开启
它唯一的托管任务工具，并启动同一条真实模型 Desktop 链路：

~~~bash
python scripts/launch_local_agent_desktop.py --model YOUR_TOOL_CAPABLE_MODEL
~~~

接口与模型必须支持 OpenAI 风格的流式 `tool_calls`。辅助脚本会在内存中读取随机
本地 Key，不把它打印出来。模型随后可以调用
`awp_run_managed_task`：Adapter 把受限 `argv` 提交到 FastAPI 控制面，可信 Worker
不经过 Shell 执行允许列表内的命令，再把结果送回模型与 Desktop。这是一条窄但真实
可跑的纵向链路，不是通用 Planning 或工具框架。已有 Agent CLI 只需实现
[Agent CLI 协议](docs/agent-cli-protocol.md)，设置绝对路径
`AWP_AGENT_CLI_EXECUTABLE` 与 `AWP_AGENT_DEFAULT_MODEL`，再运行
`npm --prefix apps/desktop run agent:electron`。

### 3. 启动确定性桌面工作台

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

### 4. 给任意仓库加入可恢复工作流

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

![AWP 系统总览与显式集成边界](docs/assets/readme/system-overview.png)

<details>
<summary>展开文本版架构图</summary>

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

</details>

桌面 Chat Adapter、FastAPI 控制面、文件持久化工作流 Runtime 和 Go VM 协议是四套
刻意分开的契约。虚线代表扩展边界，不代表隐藏路由。已经验证的 Compose 闭环使用
Python Worker。

完整说明见[架构与信任边界](docs/architecture.md)。

## 围绕真实故障设计

AWP 最重要的能力最初都是事故修复。只要公开仓库能安全复现对应问题，就同时保留
机制和可执行回归，而不只留下一个“看起来实现了”的源文件。

![AWP 可靠性闭环：保存状态、恢复意图、审核结果并沉淀经验](docs/assets/readme/reliability-loop.png)

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

- 真实模型 → 参考 CLI 进程 → Electron 流式响应 → 原生 Session 持久化恢复
- 显式开启后，同一模型可经过 FastAPI 控制面、真实 Python Worker、允许列表进程、
  工具结果回传，最终在 Desktop 得到回答
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

参考 Adapter 现在用唯一的 `awp_run_managed_task` 工具，把真实模型 Desktop 路径与
Compose 托管任务路径连成了一条显式开启的闭环。它不会把每条聊天自动变成任务，也
没有把文件工作流 Runtime 或可选 Go VM Agent 组合库偷偷接进这条链路。

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
| [examples/openai-compatible-agent-cli](examples/openai-compatible-agent-cli/README.md) | Desktop Agent CLI 协议的真实模型参考实现 |
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
- [Agent CLI 协议](docs/agent-cli-protocol.md) — 可执行文件、JSONL、流式输出、恢复和失败契约
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
