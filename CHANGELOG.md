# Changelog

## 0.7.0 — identity registry, multi-channel sessions, digests

Fork release (@yangguang760/pi-teammate), diverging from upstream v0.5.0.
Also includes the earlier reliability work published in the 0.6.x line:
identity takeover, presence leases, outbound watchdog, milestone gates.

### Added

- **Project-local persona registry** — `<proj_dir>/persona/<name>.yaml`;
  launch from the project root with `pi --agent-name <name>`. Resolution:
  flag → registry → legacy single-file `persona.yaml` (zero migration).
- **persona v2 fields** — `workspace` (permission scope), `channels`
  (declarative membership, auto-joined at startup), `channelName`
  (channel identity for cross-project shared channels), `skills`.
- **Permission bridge** — sessions inject
  `<active_agent name="...">` so `@gotgenes/pi-permission-system`
  per-agent frontmatter (`<cwd>/.pi/agents/<agent>.md`) keys on the
  teammate identity with zero changes to that extension.
- **Multi-channel sessions** — one session, one identity, N channels.
  Each channel gets its own SQLite DB + MAMORU instance; `--team-channel`
  and persona `channels` are joined as a union; `/team-join` adds more
  mid-session; `/team-leave [channel|all]`.
- **Cross-channel send routing** — recipients resolve by roster across all
  joined channels (session_id or display name); ambiguous names error with
  channel candidates instead of guessing; broadcasts default to the primary
  channel; optional `channel` param disambiguates.
- **Informational digests** — `broadcast`/`info_only` (need_reply=false) no
  longer interrupt the LLM per message; they buffer per channel and merge
  into one `[DIGEST]` block at the next turn boundary (cap 50, shows last
  20). need_reply=true broadcasts still inject immediately; task traffic is
  untouched.
- **Aggregate command views** — `/team-status`, `/team-roster`,
  `/task-status`, `/task-list` show `[channel]` sections across all joined
  channels; `/team-resume` lifts gates per channel or all; `/task-cancel`
  searches every joined channel.
- **(0.6.x line) identity takeover** — crash → new session → rejoin
  replays all downtime messages (no more cursor black hole);
- **(0.6.x line) presence leases** — 2s extension-timer heartbeat, stale
  peers tombstoned after 30s;
- **(0.6.x line) outbound watchdog** — a worker that dies mid-task is
  detected within one poll cycle and its task requeues to a live teammate
  (≤3 attempts, then dead-letter);
- **(0.6.x line) milestone gates** — `gate: "milestone"` on a task_req
  pauses the requester's reception until `/team-resume`.

### Notes

- Topic subscriptions / per-channel mute are deferred until real broadcast
  volume demands them.
- Rolling upgrade: pre-lease sessions don't renew leases and may be
  tombstoned by an upgraded peer after 30s — upgrade all members of a
  channel together.
