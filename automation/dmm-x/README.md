# DMM X public runner

This folder hosts the lightweight DMM -> Buffer queue job on the public `sena-media` repository.

Why:
- standard GitHub-hosted runners are free/unlimited for public repositories;
- the private account Actions quota was exhausted in September 2026;
- heavy MIO/SENA rendering and analytics must not be scheduled here.

Required repository Actions secrets:
- `DMM_BUFFER_API_KEY` — Buffer API key for the X channel `ero_mimimimi`
- `DMM_API_ID` — DMM Webservice API ID

Safety:
- secrets must never be committed to files;
- workflow schedule remains disabled while the X adult-affiliate paid-partnership policy hold is in effect; a technical test alone does not authorize restart;
- the old private DMM scheduled workflow remains paused;
- public state contains only posting IDs/content IDs, never secret values.

Test / restart prerequisites:
- Do not dispatch a commercial batch or restore cron merely to test posting.
- First resolve X paid-partnership policy applicability, then verify existing Buffer external IDs and the platform's live queue to prevent duplicates.
- Recheck future 12:30 / 21:30 / 23:30 JST dueAt slots only; never backfill missed slots.
- Use `customScheduled + dueAt`, not `addToQueue`. Campaign eligibility must cover the actual dueAt.

## Posting hold status (verified 2026-11-01 JST)

The earlier 2026-10-28 audit found a separately active public runner. That discrepancy has since been resolved **in workflow code**: `.github/workflows/dmm-x-public-runner.yml` now has `workflow_dispatch` only and its sole job has `if: ${{ false }}`, so commercial posting is paused. The private repository also records a posting hold. Do not infer from the presence of a manual trigger that the disabled job will post.

`automation/dmm-x/state.json` is the posting Source of Truth. Its latest batch is **2026-10-26**, with recovered external Buffer IDs for 12:30 (engagement), 21:30 (discovery affiliate) and 23:30 JST (decision affiliate). It does **not** demonstrate that later dates have no posts in Buffer; the live inventory is not fully verified. Neither missing newer IDs nor the elapsed dueAt authorizes backfilling or duplicate creation. Keep historical P0 completion and the two confirmed affiliate readbacks intact.

`dmm-x-live-audit.yml` is a separate **read-only** telemetry workflow, not the posting runner. Its saved Buffer API 429 cooldown currently ends **2026-11-12 08:40:53 JST**. Until that retryAt, inspect existing GitHub state and external IDs without re-querying Buffer. If a future audit read succeeds but git persistence fails, preserve the read payload as an artifact and do not repeat the Buffer read merely to repair a rebase/push conflict.

The X Paid Partnerships Policy expressly includes commission-generating affiliate links and excludes adult/sexual products, services and entertainment. PR disclosures or sensitive-media labeling do not override that restriction. Do not restart adult affiliate placement until platform-policy applicability is resolved, and do not disguise or route around the restriction. Official reference: https://help.x.com/ja/rules-and-policies/paid-partnerships-policy

Product-selection previews and popularity proxies are research data, not proof of live booking, an eligible sale at dueAt, or a DMM conversion. Never infer official sales or commissions from Buffer clicks.
