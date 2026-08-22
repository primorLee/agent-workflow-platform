#!/usr/bin/env python3
"""
Agent Workflow Platform task scheduler.

读取 backlog 和 STATUS.md，输出下一批任务的结构化指令。
供任意 Agent 工作流调用，不是独立运行的服务。

用法:
    python workflows/runtime/scheduler.py status                          # 查看当前状态
    python workflows/runtime/scheduler.py next [mode]                     # 获取下一批任务
    python workflows/runtime/scheduler.py complete <id>                   # 标记任务完成
    python workflows/runtime/scheduler.py add <desc> [pri] [--depends T-001] [--group name]
    python workflows/runtime/scheduler.py backlog                         # 查看 backlog
    python workflows/runtime/scheduler.py heartbeat                       # 更新心跳
    python workflows/runtime/scheduler.py checkpoint <instruction>        # 保存断点
    python workflows/runtime/scheduler.py batch start [mode]|complete|status  # 原子 claim/批次管理
    python workflows/runtime/scheduler.py stats                           # 统计信息
"""

import errno
import json
import os
import re
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

WORKFLOW_HOME = Path(
    os.environ.get("AWP_WORKFLOW_HOME", Path(__file__).resolve().parent.parent)
).resolve()
PROJECT_ROOT = Path(
    os.environ.get("AWP_PROJECT_DIR", WORKFLOW_HOME.parent)
).resolve()
RUN_STATE = Path(
    os.environ.get("AWP_RUN_STATE", PROJECT_ROOT / ".agent-workflow" / "run-state.json")
).resolve()
STATE_LOCK = RUN_STATE.with_name(f".{RUN_STATE.name}.lock")
MODES_DIR = Path(os.environ.get("AWP_MODES_DIR", WORKFLOW_HOME / "modes")).resolve()
STATUS_MD = Path(
    os.environ.get("AWP_STATUS_FILE", PROJECT_ROOT / "STATUS.md")
).resolve()

_DEFAULT_STATE = {
    "schema_version": 1,
    "session": {
        "id": "",
        "status": "idle",
        "mode": None,
        "started_at": None,
        "last_heartbeat": None,
    },
    "checkpoint": {"resumable": False},
    "current_task": None,
    "backlog": [],
    "batches": [],
    "progress": {},
}


class StateLockTimeout(RuntimeError):
    """Raised instead of silently losing a concurrent state mutation."""


def now_iso():
    """Return a portable UTC timestamp for cross-host resume checks."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def default_state():
    """Return an independent, schema-valid state for a fresh project."""
    state = json.loads(json.dumps(_DEFAULT_STATE))
    state["session"]["id"] = f"S-{uuid.uuid4().hex}"
    state["session"]["started_at"] = now_iso()
    return state


def load_run_state():
    if RUN_STATE.exists():
        try:
            state = json.loads(RUN_STATE.read_text(encoding="utf-8"))
            if isinstance(state, dict):
                return state
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            pass
    return default_state()


def _lock_timeout_seconds():
    try:
        return max(0.1, float(os.environ.get("AWP_STATE_LOCK_TIMEOUT", "10")))
    except ValueError:
        return 10.0


def _replace_timeout_seconds():
    try:
        return max(0.1, float(os.environ.get("AWP_STATE_REPLACE_TIMEOUT", "5")))
    except ValueError:
        return 5.0


def _replace_run_state(source, destination):
    """Retry only transient OS sharing failures; never fall back to direct writes."""
    deadline = time.monotonic() + _replace_timeout_seconds()
    while True:
        try:
            os.replace(source, destination)
            return
        except OSError as exc:
            winerror = getattr(exc, "winerror", None)
            transient = (
                winerror in {5, 32, 33} or exc.errno in {errno.EINTR, errno.EBUSY}
            )
            if not transient or time.monotonic() >= deadline:
                raise
            time.sleep(0.01)


@contextmanager
def run_state_lock():
    """Hold an OS-level cross-process lock for one read/modify/write cycle."""
    STATE_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + _lock_timeout_seconds()
        locked = False
        while not locked:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise StateLockTimeout(
                        f"timed out waiting for run-state lock: {STATE_LOCK}"
                    ) from exc
                time.sleep(0.01)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def save_run_state(state):
    """Atomically replace run state while the caller holds ``run_state_lock``."""
    RUN_STATE.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(state, ensure_ascii=False, indent=2)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(RUN_STATE.parent), suffix=".tmp", prefix=".run-state-"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _replace_run_state(tmp_path, RUN_STATE)
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except OSError:
            pass


@contextmanager
def edit_run_state():
    """Serialize a complete read/modify/atomic-write transaction."""
    with run_state_lock():
        state = load_run_state()
        yield state
        save_run_state(state)

def load_mode(mode_name):
    path = MODES_DIR / f"{mode_name}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def _next_task_id(backlog):
    """从已有 ID 中推导下一个 ID，不依赖 backlog 长度"""
    max_num = 0
    for task in backlog:
        tid = task.get("id", "")
        m = re.match(r"T-(\d+)", tid)
        if m:
            max_num = max(max_num, int(m.group(1)))
    return f"T-{max_num + 1:03d}"


def _resolve_dependencies(tasks, backlog):
    """过滤掉依赖未完成的任务"""
    done_ids = {t["id"] for t in backlog if t.get("status") in ("done", "completed", "deferred")}
    ready = []
    for t in tasks:
        deps = t.get("depends", [])
        if all(d in done_ids for d in deps):
            ready.append(t)
    return ready


def _select_ready_tasks(state, mode):
    backlog = state.get("backlog", [])
    pending = [task for task in backlog if task.get("status") == "pending"]
    ready = _resolve_dependencies(pending, backlog)
    limit = max(1, int(mode.get("scheduling", {}).get("parallel_agents", 3)))
    return sorted(ready, key=lambda task: (task.get("priority", 5), task.get("id", "")))[:limit]


def _next_batch_id(batches):
    max_num = 0
    for batch in batches:
        match = re.fullmatch(r"B-(\d+)", str(batch.get("id", "")))
        if match:
            max_num = max(max_num, int(match.group(1)))
    return f"B-{max_num + 1:03d}"

def cmd_status():
    state = load_run_state()
    s = state.get("session", {})
    p = state.get("progress", {})
    bl = state.get("backlog", [])
    batches = state.get("batches", [])

    print(f"状态: {s.get('status', 'idle')}")
    print(f"模式: {s.get('mode', '未设置')}")
    print(f"最后心跳: {s.get('last_heartbeat', '无')}")
    print(f"本次完成任务: {p.get('tasks_completed_this_session', 0)}")
    print(f"本次完成批次: {p.get('batches_completed_this_session', 0)}")
    print(f"最后 commit: {p.get('last_commit', '无')}")
    print(f"最后 diary: {p.get('last_diary', '无')}")
    print(f"Backlog 条目: {len(bl)}")
    print(f"历史批次数: {len(batches)}")

    # 显示活跃批次
    active_batches = [b for b in batches if b.get("status") == "active"]
    if active_batches:
        print(f"\n活跃批次:")
        for b in active_batches:
            print(f"  [{b['id']}] {len(b.get('task_ids', []))} 个任务 — 启动于 {b.get('started_at', '')[:16]}")

    if p.get("errors"):
        print(f"\n最近错误:")
        for err in p["errors"][-3:]:
            print(f"  - {err}")


def cmd_next(mode_name="daily"):
    state = load_run_state()
    mode = load_mode(mode_name)
    if not mode:
        print(f"错误: 模式 '{mode_name}' 不存在", file=sys.stderr)
        sys.exit(1)

    backlog = state.get("backlog", [])
    pending = [task for task in backlog if task.get("status") == "pending"]
    ready = _resolve_dependencies(pending, backlog)
    selected = _select_ready_tasks(state, mode)
    scheduling = mode.get("scheduling", {})
    parallel_agents = max(1, int(scheduling.get("parallel_agents", 3)))

    if not selected:
        if pending:
            print(
                json.dumps(
                    {
                        "action": "blocked",
                        "message": f"有 {len(pending)} 个待处理任务，但全部被依赖阻塞",
                        "blocked_tasks": [
                            {"id": task["id"], "depends": task.get("depends", [])}
                            for task in pending[:5]
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(
                json.dumps(
                    {
                        "action": "read_status",
                        "message": "Backlog 为空，读 STATUS.md 找任务",
                        "file": str(STATUS_MD),
                        "mode": mode_name,
                        "parallel_agents": parallel_agents,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        return

    print(
        json.dumps(
            {
                "action": "execute_batch",
                "mode": mode_name,
                "parallel_agents": parallel_agents,
                "batch_strategy": scheduling.get("batch_strategy", "sequential"),
                "tasks": selected,
                "review_required": mode.get("review", {}).get(
                    "internal_review", False
                ),
                "diary_interval_min": mode.get("reporting", {}).get(
                    "diary_interval_min", 60
                ),
                "claim_command": f"scheduler.py batch start {mode_name}",
            },
            ensure_ascii=False,
            indent=2,
        )
    )

def cmd_complete(task_id):
    outcome = "missing"
    with edit_run_state() as state:
        backlog = state.get("backlog", [])
        for task in backlog:
            if task.get("id") != task_id:
                continue
            if task.get("status") == "done":
                outcome = "already_done"
                break
            task["status"] = "done"
            task["completed_at"] = now_iso()
            progress = state.setdefault("progress", {})
            progress["tasks_completed_this_session"] = (
                progress.get("tasks_completed_this_session", 0) + 1
            )
            outcome = "completed"
            break

    if outcome == "missing":
        print(f"警告: 任务 '{task_id}' 不在 backlog 中", file=sys.stderr)
        return
    if outcome == "already_done":
        print(f"任务 {task_id} 已经完成")
        return
    print(f"任务 {task_id} 已标记完成")


def cmd_add(description, priority=5, depends=None, group=None):
    with edit_run_state() as state:
        backlog = state.setdefault("backlog", [])
        task_id = _next_task_id(backlog)
        task = {
            "id": task_id,
            "description": description,
            "priority": priority,
            "status": "pending",
            "created_at": now_iso(),
        }
        if depends:
            task["depends"] = depends
        if group:
            task["group"] = group
        backlog.append(task)

    extras = []
    if depends:
        extras.append(f"依赖 {','.join(depends)}")
    if group:
        extras.append(f"分组 [{group}]")
    extra_str = f" ({'; '.join(extras)})" if extras else ""
    print(f"已添加: {task_id} — {description} (优先级 {priority}){extra_str}")

def cmd_backlog():
    state = load_run_state()
    backlog = state.get("backlog", [])

    if not backlog:
        print("Backlog 为空")
        return

    pending = [t for t in backlog if t.get("status") != "done"]
    done = [t for t in backlog if t.get("status") == "done"]

    if pending:
        # 按分组聚合
        groups = {}
        ungrouped = []
        for t in sorted(pending, key=lambda x: x.get("priority", 5)):
            g = t.get("group")
            if g:
                groups.setdefault(g, []).append(t)
            else:
                ungrouped.append(t)

        print(f"待完成 ({len(pending)}):")
        if groups:
            for gname, tasks in sorted(groups.items()):
                print(f"\n  [{gname}]")
                for t in tasks:
                    deps = f" (依赖: {','.join(t['depends'])})" if t.get("depends") else ""
                    print(f"    [{t['id']}] P{t.get('priority',5)} {t.get('description', t.get('desc', '无描述'))}{deps}")
        if ungrouped:
            if groups:
                print(f"\n  [未分组]")
            for t in ungrouped:
                deps = f" (依赖: {','.join(t['depends'])})" if t.get("depends") else ""
                prefix = "    " if groups else "  "
                print(f"{prefix}[{t['id']}] P{t.get('priority',5)} {t.get('description', t.get('desc', '无描述'))}{deps}")

    if done:
        print(f"\n已完成 ({len(done)}):")
        for t in done[-5:]:  # 最近5个
            print(f"  [{t['id']}] {t.get('description', t.get('desc', '无描述'))} — {t.get('completed_at','')[:16]}")


def cmd_heartbeat():
    """更新心跳时间戳，供守护进程检查"""
    with edit_run_state() as state:
        state.setdefault("session", {})["last_heartbeat"] = now_iso()


def cmd_checkpoint(instruction):
    """保存检查点，供下次 session 恢复"""
    with edit_run_state() as state:
        state["checkpoint"] = {
            "resumable": True,
            "resume_instruction": instruction,
            "saved_at": now_iso(),
            "context_files": [],
        }
    print(f"检查点已保存: {instruction[:80]}...")

# ─── 批次管理 ───


def cmd_batch(subcmd, mode_name=None):
    if subcmd == "start":
        with edit_run_state() as state:
            batches = state.setdefault("batches", [])
            if any(batch.get("status") == "active" for batch in batches):
                print("错误: 已有活跃批次，先完成或恢复它", file=sys.stderr)
                sys.exit(1)

            session = state.setdefault("session", {})
            effective_mode = mode_name or session.get("mode") or "daily"
            mode = load_mode(effective_mode)
            if not mode:
                print(f"错误: 模式 '{effective_mode}' 不存在", file=sys.stderr)
                sys.exit(1)

            selected = _select_ready_tasks(state, mode)
            if not selected:
                print("错误: 没有可 claim 的 dependency-ready pending 任务", file=sys.stderr)
                sys.exit(1)

            timestamp = now_iso()
            batch_id = _next_batch_id(batches)
            task_ids = []
            for task in selected:
                task["status"] = "in_progress"
                task["claimed_at"] = timestamp
                task["batch_id"] = batch_id
                task_ids.append(task["id"])

            batch = {
                "id": batch_id,
                "status": "active",
                "mode": effective_mode,
                "started_at": timestamp,
                "task_ids": task_ids,
                "completed_task_ids": [],
                "failed_task_ids": [],
            }
            batches.append(batch)
            progress = state.setdefault("progress", {})
            progress["current_batch"] = batch_id
            session["status"] = "active"
            session["mode"] = effective_mode
            session["last_heartbeat"] = timestamp

        print(
            json.dumps(
                {
                    "action": "batch_started",
                    "batch_id": batch_id,
                    "mode": effective_mode,
                    "task_count": len(task_ids),
                    "task_ids": task_ids,
                },
                ensure_ascii=False,
                indent=2,
            )
        )

    elif subcmd == "complete":
        completed_summaries = []
        with edit_run_state() as state:
            batches = state.setdefault("batches", [])
            active = [batch for batch in batches if batch.get("status") == "active"]
            if not active:
                print("错误: 没有活跃批次", file=sys.stderr)
                sys.exit(1)

            backlog_by_id = {
                task.get("id"): task for task in state.get("backlog", [])
            }
            unresolved = [
                task_id
                for batch in active
                for task_id in batch.get("task_ids", [])
                if backlog_by_id.get(task_id, {}).get("status")
                not in {"done", "failed", "deferred"}
            ]
            if unresolved:
                print(
                    "错误: 批次仍有未完成任务: " + ",".join(sorted(unresolved)),
                    file=sys.stderr,
                )
                sys.exit(1)

            timestamp = now_iso()
            for batch in active:
                task_ids = batch.get("task_ids", [])
                completed_ids = [
                    task_id
                    for task_id in task_ids
                    if backlog_by_id.get(task_id, {}).get("status") == "done"
                ]
                failed_ids = [
                    task_id
                    for task_id in task_ids
                    if backlog_by_id.get(task_id, {}).get("status") == "failed"
                ]
                batch["status"] = "completed" if not failed_ids else "failed"
                batch["completed_at"] = timestamp
                batch["completed_task_ids"] = completed_ids
                batch["failed_task_ids"] = failed_ids
                completed_summaries.append((batch["id"], completed_ids, failed_ids))

            progress = state.setdefault("progress", {})
            progress["batches_completed_this_session"] = (
                progress.get("batches_completed_this_session", 0) + len(active)
            )
            progress.pop("current_batch", None)

        for batch_id, completed_ids, failed_ids in completed_summaries:
            print(
                f"批次 {batch_id} 已完成 — "
                f"成功 {len(completed_ids)}, 失败 {len(failed_ids)}"
            )

    elif subcmd == "status":
        state = load_run_state()
        batches = state.get("batches", [])
        if not batches:
            print("没有批次记录")
            return

        active = [batch for batch in batches if batch.get("status") == "active"]
        completed = [
            batch
            for batch in batches
            if batch.get("status") in {"completed", "failed"}
        ]
        if active:
            print(f"活跃批次 ({len(active)}):")
            for batch in active:
                elapsed = ""
                if batch.get("started_at"):
                    try:
                        start = datetime.fromisoformat(batch["started_at"])
                        minutes = int(
                            (datetime.now(start.tzinfo) - start).total_seconds() / 60
                        )
                        elapsed = f" ({minutes}min)"
                    except ValueError:
                        pass
                print(
                    f"  [{batch['id']}] {len(batch.get('task_ids', []))} 个任务{elapsed}"
                )
        if completed:
            print("\n最近完成的批次 (最近5个):")
            for batch in completed[-5:]:
                ok = len(batch.get("completed_task_ids", []))
                fail = len(batch.get("failed_task_ids", []))
                print(
                    f"  [{batch['id']}] 成功 {ok} / 失败 {fail} — "
                    f"{batch.get('completed_at', '')[:16]}"
                )
    else:
        print(f"未知子命令: {subcmd}，可用: start, complete, status", file=sys.stderr)
        sys.exit(1)

# ─── 统计 ───


def cmd_stats():
    state = load_run_state()
    backlog = state.get("backlog", [])
    batches = state.get("batches", [])

    total = len(backlog)
    done = [t for t in backlog if t.get("status") == "done"]
    failed = [t for t in backlog if t.get("status") == "failed"]
    pending = [t for t in backlog if t.get("status") not in ("done", "failed")]

    print(f"=== 任务统计 ===")
    print(f"总计: {total}")
    print(f"已完成: {len(done)}")
    print(f"失败: {len(failed)}")
    print(f"待处理: {len(pending)}")

    if total > 0:
        completion_rate = len(done) / total * 100
        failure_rate = len(failed) / (len(done) + len(failed)) * 100 if (len(done) + len(failed)) > 0 else 0
        print(f"完成率: {completion_rate:.1f}%")
        if len(done) + len(failed) > 0:
            print(f"失败率: {failure_rate:.1f}%")

    # 平均耗时（仅已完成任务）
    durations = []
    for t in done:
        created = t.get("created_at")
        completed = t.get("completed_at")
        if created and completed:
            try:
                c = datetime.fromisoformat(created)
                d = datetime.fromisoformat(completed)
                durations.append((d - c).total_seconds())
            except ValueError:
                pass

    if durations:
        avg_sec = sum(durations) / len(durations)
        if avg_sec < 60:
            print(f"平均耗时: {avg_sec:.0f}s")
        elif avg_sec < 3600:
            print(f"平均耗时: {avg_sec/60:.1f}min")
        else:
            print(f"平均耗时: {avg_sec/3600:.1f}h")

    # 按分组统计
    groups = {}
    for t in backlog:
        g = t.get("group", "未分组")
        groups.setdefault(g, {"total": 0, "done": 0, "failed": 0})
        groups[g]["total"] += 1
        if t.get("status") == "done":
            groups[g]["done"] += 1
        elif t.get("status") == "failed":
            groups[g]["failed"] += 1

    if len(groups) > 1 or (len(groups) == 1 and "未分组" not in groups):
        print(f"\n=== 分组统计 ===")
        for gname, gs in sorted(groups.items()):
            rate = gs["done"] / gs["total"] * 100 if gs["total"] > 0 else 0
            print(f"  [{gname}] {gs['done']}/{gs['total']} ({rate:.0f}%)")

    # 批次统计
    if batches:
        completed_batches = [b for b in batches if b.get("status") == "completed"]
        print(f"\n=== 批次统计 ===")
        print(f"总批次: {len(batches)}")
        print(f"已完成: {len(completed_batches)}")
        print(f"活跃: {len(batches) - len(completed_batches)}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "status":
        cmd_status()
    elif cmd == "next":
        mode = sys.argv[2] if len(sys.argv) > 2 else "daily"
        cmd_next(mode)
    elif cmd == "complete":
        if len(sys.argv) < 3:
            print("用法: scheduler.py complete <task_id>", file=sys.stderr)
            sys.exit(1)
        cmd_complete(sys.argv[2])
    elif cmd == "add":
        if len(sys.argv) < 3:
            print("用法: scheduler.py add <desc> [pri] [--depends T-001] [--group name]", file=sys.stderr)
            sys.exit(1)
        desc = sys.argv[2]
        pri = 5
        depends = None
        group = None

        # 解析可选参数
        i = 3
        # 先检查第三个参数是否是纯数字（优先级）
        if i < len(sys.argv) and sys.argv[i].isdigit():
            pri = int(sys.argv[i])
            i += 1

        while i < len(sys.argv):
            if sys.argv[i] == "--depends" and i + 1 < len(sys.argv):
                depends = [d.strip() for d in sys.argv[i + 1].split(",")]
                i += 2
            elif sys.argv[i] == "--group" and i + 1 < len(sys.argv):
                group = sys.argv[i + 1]
                i += 2
            else:
                i += 1

        cmd_add(desc, pri, depends, group)
    elif cmd == "backlog":
        cmd_backlog()
    elif cmd == "heartbeat":
        cmd_heartbeat()
    elif cmd == "checkpoint":
        if len(sys.argv) < 3:
            print("用法: scheduler.py checkpoint <resume_instruction>", file=sys.stderr)
            sys.exit(1)
        cmd_checkpoint(sys.argv[2])
    elif cmd == "batch":
        if len(sys.argv) < 3:
            print("用法: scheduler.py batch start [mode]|complete|status", file=sys.stderr)
            sys.exit(1)
        mode = sys.argv[3] if len(sys.argv) > 3 else None
        cmd_batch(sys.argv[2], mode)
    elif cmd == "stats":
        cmd_stats()
    else:
        print(f"未知命令: {cmd}", file=sys.stderr)
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except StateLockTimeout as exc:
        print(f"错误: {exc}", file=sys.stderr)
        sys.exit(2)
