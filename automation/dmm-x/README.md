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
- workflow schedule remains disabled until a successful controlled test;
- the old private DMM scheduled workflow remains paused;
- public state contains only posting IDs/content IDs, never secret values.

Test:
Updating `automation/dmm-x/run-trigger.txt` triggers one controlled batch run.
After a successful test, add the daily cron back to the public workflow.

## Compliance discrepancy observed (2026-10-28 JST; informational safety audit)

This public runner is **not covered by the paused private repository workflow**. The public workflow `.github/workflows/dmm-x-public-runner.yml` contains an active daily `0 21 * * *` schedule (06:00 JST), despite this README's earlier controlled-test wording.

Source-of-truth `automation/dmm-x/state.json` currently records the **2026-10-26** batch with three Buffer external IDs (one engagement and two affiliate items, including `rank_first_reply` and `review_direct`), recovered from Buffer. This proves that the public runner had a separately active commercial queue; it does **not** by itself prove public X delivery, or confirm any 2026-10-27/28 batch. Check Buffer live IDs and X public URLs separately.

Policy review: X's official paid partnerships policy expressly includes commission-generating affiliate links and excludes adult/sexual products, services, entertainment and content from paid-partnership promotions. The older private repository README's "do not add new adult affiliate promotion" hold cannot be treated as effective across this public runner. See https://help.x.com/ja/rules-and-policies/paid-partnerships-policy and the private `innovation4131210-alt/dmm-x-auto-post` README (2026-10-15).

**Recommended guard:** do not infer compliance from PR disclosure or sensitive-media labeling. Verify the exact outbound content/category and pause any new prohibited affiliate placements until platform-policy applicability is resolved. This note changes no workflow, Buffer queue, published post, or schedule. Preserve existing external IDs and avoid duplicate creation.
