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
