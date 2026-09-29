# AI Command X runner

Public execution runner for the AI司令室 X account (`ai_command_jp`).

## Role
This directory is an execution mirror. The canonical content/strategy lives in:
- `innovation4131210-alt/ai-command-x-autopost`

Files:
- `posts.json`: mirrored posting backlog (D01〜D30 / 90 posts)
- `buffer_queue.py`: Buffer queue reader/refiller
- `state.json`: verified used-content IDs and write history
- `collect_analytics.py`: Buffer post-performance collector
- `analytics/posts.json`: 30-day post-level metrics
- `analytics/posts.csv`: spreadsheet-friendly post-level metrics
- `analytics/daily.json`: daily aggregate metrics

## Posting automation
Workflow:
- `.github/workflows/ai-command-x-public-runner.yml`
- Daily at 00:05 JST
- Target queue: 9 scheduled posts
- Slots: 08:10 / 12:20 / 20:30 JST

## Analytics automation
Workflow:
- `.github/workflows/ai-command-x-analytics.yml`
- 07:15 JST
- 22:45 JST
- Rolling window: 30 days

Collected metrics:
- impressions
- likes
- comments
- reposts
- quotes
- clicks
- saves
- Buffer engagement rate
- calculated interaction rate
- calculated click rate
- note-link flag
- published X URL

## Safety
- Uses the existing repository secret `X_BUFFER_API_KEY`.
- Resolves the target channel by `ai_command_jp` before writes.
- Reads scheduled/sent posts before adding anything.
- Does not reuse a content ID already recorded as used.
- Persists state after successful Buffer writes.
- Buffer Free has a 10-post/channel scheduled limit; normal operation targets 9 to keep one spare slot.
- Analytics is read-only against Buffer; only snapshot files in this repository are changed.

## Cutover note
2026-09-29: moved recurring execution here because GitHub-hosted runners for the private AI Command repository were failing before workflow steps started (`runner_id=0`, empty steps). The private workflow is retained only as a manual fallback test to avoid two schedulers running in parallel.

## Current measurement status
The analytics pipeline is verified end-to-end. At initial setup time there were no sent Buffer posts yet, so the first snapshot contains zero rows. Once the first scheduled post is published, the next analytics run will populate the dataset automatically.


## Healthcheck
Workflow:
- `.github/workflows/ai-command-x-healthcheck.yml`
- Daily at 00:25 JST

Checks:
- Buffer channel resolves to `ai_command_jp`
- channel is not disconnected / locked / paused
- scheduled queue is at least 9 immediately after refill
- prepared unused backlog is at least 9 posts
- analytics snapshot is fresh
- note home / free-entry article / paid-product article are publicly reachable

Latest verified status (2026-09-29):
- health: OK
- scheduled: 10
- unused prepared: 80
- note public pages: all HTTP 200
