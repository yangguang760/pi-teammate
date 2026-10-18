# pi-teammate v2 设计提案:身份注册表 · 多频道成员资格 · 订阅式噪音控制

状态:PROPOSAL(未实施) · 2026-09
上游基线:ross-jill-ws/pi-teammate v0.5.0 + 本 fork(身份接管/lease/看门狗/milestone gate)

## 0. 要解决的三个问题

| # | 问题 | 根因 |
|---|---|---|
| P1 | persona.yaml 绑死 cwd,必须在角色目录里启动 pi | 身份(我是谁)与工作区(我能碰哪)耦合 |
| P2 | 一个角色要同时出现在多个 team(manager 跨项目 + 项目内),单一大群全员收噪音 | 会话↔频道 1:1 绑定 + 广播无订阅语义 |
| P3 | 自主协作缺人审控制(已由 fork 的 milestone gate 解决一半) | 需 per-channel 化 |

## 1. 开源调研结论(2026-09)

**没有现成实现命中我们的组合**:独立 TUI 进程会话 + 本地 durable 总线 + 身份/目录解耦 + 多频道成员 + 订阅式噪音控制 + 人审门控。

| 项目 | (a)身份 | (b)多团队/路由 | (c)传输 | (d)人审 | 可偷 |
|---|---|---|---|---|---|
| AutoGen 0.4 | agent=代码对象,身份只是字符串 | SelectorGroupChat 动态选人,单 runtime | in-process actor | UserProxyAgent | actor 模型:同一逻辑体可注册进多个 group |
| CrewAI | role/goal/backstory(YAML 友好) | Crew 内 hierarchical(Manager 分派),跨 Crew 弱 | in-process | task 层人工输入 | persona 字段演进方向(加 goal/skills) |
| LangGraph | 图节点 | 图即路由,interrupt() 原生 HITL | in-process,checkpoint 强 | interrupt() 最强 | gate 语义参照 |
| A2A(Linux Fdn, v1.0) | **Agent Card**:结构化 JSON 声明 name/skills/auth/endpoint | 按 capability 发现;Task 状态机(working/input-required/completed/failed/rejected) | HTTP/JSON-RPC/SSE,面向跨网络 | 无内置 | **Agent Card 化 persona**;task 状态机对齐 |
| Letta/MemGPT | 身份=持久记忆对象,与宿主进程解耦 | — | 服务化 | — | **身份与宿主解耦**的正当性 |
| Slack/Discord 模型 | 账号全局,与目录无关 | **频道订阅 + @mention 直达 + broadcast 降级** | durable | — | 噪音控制的成熟范式 |
| pi-team(同机另一扩展) | alias 与 cwd 无关 | 一 session 一 team,join 即订阅 | JSON 文件邮箱 | 5-turn 预算 + resume | alias 模型已被我们采纳 |

参考:A2A 规范 https://a2a-protocol.org/latest/specification/ ;AutoGen 0.4 actor runtime 与 CrewAI 对比见 DeepWiki/多源;LangGraph interrupt;Letta 文档。

## 2. 设计

### L1 项目内身份注册表(解 P1;用户决策:不做全局注册表)

```
<proj_dir>/persona/<name>.yaml        身份注册表(git 版本化,项目自包含)
<proj_dir>/persona.yaml               旧式单文件,兼容,最高优先
```

- 启动:`pi --agent-name <name>` 站在项目根,cwd = **workspace(权限范围)**
- 解析:--agent-name → `persona/<name>.yaml` → 旧式 `persona.yaml`。旧用户零迁移
- persona 新字段:
  - `workspace: /abs/path`(缺省 = 启动 cwd)
  - `channels: [proj-a, managers]`(声明性成员资格)
  - `channelName: projx-manager`(缺省 = name;**跨项目共享频道时必须限定名**,因频道库全局,同名同频道会 takeover 互斥)
  - `skills: [...]`(A2A Agent Card 兼容形态,供 roster 与未来跨机发现)
- 项目自包含代价:跨项目同名角色各存一份 yaml——可接受,身份本就随项目上下文微调

### L1.5 权限集成(用户已用 @gotgenes/pi-permission-system)

该权限系统原生支持三层覆盖 + per-agent frontmatter:
`全局 config → 项目 config → ~/.pi/agent/agents/<agent>.md → <cwd>/.pi/agents/<agent>.md`,策略字段 read/write/mcp/bash-patterns/skill。
它通过 session 中 `<active_agent name="…">` 标签(由 pi-agent-router 注入)识别当前角色。

桥接(一行):pi-teammate 在 before_agent_start 把 persona 名注入该标签 → 权限系统零改动,按角色自动生效。
职责分离:**persona 管身份/协作边界;角色权限策略放 `<cwd>/.pi/agents/<name>.md`(权限系统的地盘)**。

### L2 多频道会话(解 P2 前半)

- 一个 pi 会话 join N 个频道:`Map<channel, {db, mamoru, gate}>`,每频道独立 SQLite(本就隔离;fork 的 takeover/lease 均 per-channel,天然支持同名跨频道共存)
- index.ts 单实例 → 实例表重构;TUI footer 聚合:`2ch: proj-a(1 pend) managers(idle)`
- 系统提示的 teammates roster = 多频道花名册合并去重,标注所属频道
- 同名同频道仍互斥(takeover 语义不变);同名跨频道 = 同一身份多宿主,合法

### L3 订阅式噪音控制(解 P2 后半)

payload 增加两个可选字段(旧消息缺省 = mention 级,向后兼容):

```
priority: "direct" | "mention" | "broadcast"
topic:    "design" | "release" | ...   (自由字符串)
```

投递规则(传输层执行,模型无法无视):
- **direct**(显式 to=X):永远注入
- **mention**(broadcast 带 @name):注入被 @ 的人;其他人降 digest
- **broadcast** 纯广播:只注入声明订阅该 topic 的成员;其余进 per-channel digest 缓冲,MAMORU 每 N 分钟合并成一条摘要注入(1 条 ≤20 词 + detail 文件路径)

命令:`/team-mute <ch>`、`/team-digest <ch> <minutes>`、persona 里 `topics: [...]` 声明订阅。

### L4 人审控制(已建,补齐)

- milestone gate 按 channel 独立engage/恢复;`/team-resume [channel]`
- gate + digest 互斥优先级:gate > digest

### L5 跨机器发现(未来,不在本期)

A2A bridge:persona → agent-card 文件,HTTP bridge 供远端项目 PM 互通。本期只把 persona 字段演进到 card 兼容形态,不引 HTTP 栈。

## 3. 迁移路径(fork 上分阶段,全部向后兼容)

| 阶段 | 内容 | 量级 |
|---|---|---|
| M1 | L1 身份注册表 + `--agent-name` 解析链 | ~1 天 |
| M2 | L2 多频道实例化(index.ts 重构 + TUI 聚合) | 2-3 天,最大改动 |
| M3 | L3 priority/topic + digest + mute | 1-2 天 |
| M4 | 文档 + persona schema v2 + 迁移指南 | 0.5 天 |

风险:M2 动 bootstrapMamoru/commands 的单实例假设(19 处 getMamoru 调用),需要实例表适配层先落,再逐点替换。
