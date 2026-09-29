# AI Command X runner

Public execution runner for the AI司令室 X account (`ai_command_jp`).

## Role
This directory is an execution mirror. The canonical content/strategy lives in:
- `innovation4131210-alt/ai-command-x-autopost`

Files:
- `posts.json`: mirrored posting backlog
- `buffer_queue.py`: Buffer queue reader/refiller
- `state.json`: verified used-content IDs and write history

Workflow:
- `.github/workflows/ai-command-x-public-runner.yml`
- Daily at 00:05 JST
- Target queue: 9 scheduled posts
- Slots: 08:10 / 12:20 / 20:30 JST

## Safety
- Uses the existing repository secret `X_BUFFER_API_KEY`.
- Resolves the target channel by `ai_command_jp` before writes.
- Reads scheduled/sent posts before adding anything.
- Does not reuse a content ID already recorded as used.
- Persists state after successful Buffer writes.
- Buffer Free has a 10-post/channel scheduled limit; normal operation targets 9 to keep one spare slot.

## Cutover note
2026-09-29: moved recurring execution here because GitHub-hosted runners for the private AI Command repository were failing before workflow steps started (`runner_id=0`, empty steps). The private workflow is retained only as a manual fallback test to avoid two schedulers running in parallel.
