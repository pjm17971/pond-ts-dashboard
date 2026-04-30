# pond-ts-dashboard

Working notes for agents operating on this repo. See [README.md](README.md)
for the user-facing description of the project; this file captures
conventions and operational context that survive across sessions.

## What this repo is

The read-side dashboard for the pond-ts ecosystem. Started as a
standalone live-streaming demo (`pond-web`); now `packages/web` of
the `pond-grpc-experiment` workspace, mirroring an aggregator's
`LiveSeries` over WebSocket. Several agents touch the wider pond-ts
stack across multiple repos:

- [pond-ts](https://github.com/pjm17971/pond-ts) — the library
- [pond-ts-dashboard](https://github.com/pjm17971/pond-ts-dashboard) — this repo
- [pond-grpc-experiment](https://github.com/pjm17971/pond-grpc-experiment) — three-tier topology test

The canonical version of cross-repo agent conventions lives in
pond-ts's CLAUDE.md; this file mirrors the parts that apply here.

## Agent identity in PRs and comments

Multiple agents (Claude pond-ts library, Claude gRPC experiment,
Codex webapp telemetry, etc.) currently operate against the same
GitHub identity. To keep PR timelines readable when several agents
have touched the same thread:

**When commenting on or reviewing a PR**, prefix the comment body
with an identifying header on its own line:

```
> _Posted by the dashboard agent (Claude)_

## <comment body>
```

Other examples (cross-repo):

- `> _Posted by the pond-ts library agent (Claude)_`
- `> _Posted by the gRPC experiment agent (Claude)_`
- `> _Posted by the webapp telemetry agent (Codex)_`

If a comment has a specific role within a review protocol, append
it: `_— adversarial review_`, `_— review response_`, `_— friction
report_`, `_— design feedback_`. The role tag matches section
header conventions in use across the pond-ts ecosystem.

**When committing**, the existing `Co-Authored-By:` trailer
attributes the agent — keep using it.

This convention is honour-system, not enforced — it exists so a
future reader (human or another agent) reading a PR timeline cold
can tell who said what without the conversation transcript.

If GitHub-UI-level identity becomes valuable enough to be worth
setting up (e.g. multiple agents converging on the same PR with
different roles, or external readers needing to filter comments by
author), the next step is per-agent bot accounts with `GH_TOKEN`
configured per session, or GitHub Apps with installation tokens.
Both are out of scope until the friction earns the plumbing.

## Project structure

Single Vite + React + TypeScript app rendering a live metrics
dashboard backed by pond-ts. See [README.md](README.md) for the
walkthrough; key entry points:

- `src/Dashboard.tsx` — layout shell.
- `src/useDashboardData.ts` — the pond pipeline (numbered steps).
- `src/sections/*.tsx` — pure renderers of the data hook's output.
- `src/Chart.tsx` / `src/BarChart.tsx` — Recharts adapters with the
  gap-aware, scatter-overlay, animation-off-by-default conventions.

Site is auto-deployed to GitHub Pages on push to `main` via
`.github/workflows/deploy.yml` — live at
<https://pjm17971.github.io/pond-ts-dashboard/>.
