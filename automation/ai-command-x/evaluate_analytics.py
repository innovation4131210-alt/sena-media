#!/usr/bin/env python3
import json
import statistics
from collections import defaultdict
from pathlib import Path

BASE = Path("automation/ai-command-x")
ANALYTICS = BASE / "analytics"
POSTS_ANALYTICS = ANALYTICS / "posts.json"
OUT = ANALYTICS / "decision.md"


def num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def median(values):
    vals = [num(v) for v in values]
    return round(statistics.median(vals), 4) if vals else 0.0


def main():
    data = json.loads(POSTS_ANALYTICS.read_text(encoding="utf-8"))
    posts = data.get("posts", [])

    lines = [
        "# AI Command X Data Decision",
        "",
        f"- Sent posts in 30-day window: {len(posts)}",
        "- Rule: do not change strategy from a single post; compare at least 3 posts in the same role.",
        "",
    ]

    if len(posts) < 6:
        lines += [
            "## Current decision",
            "",
            "Baseline collection phase. Keep 08:10 / 12:20 / 20:30 fixed and do not change multiple variables yet.",
            "Collect at least 6 sent posts before the first content-level adjustment.",
            "",
        ]

    groups = defaultdict(list)
    for p in posts:
        groups[p.get("contentType") or "unmapped"].append(p)

    lines += [
        "## By content type",
        "",
        "| Type | n | Median impressions | Median interaction % | Median click % | Total clicks |",
        "|---|---:|---:|---:|---:|---:|",
    ]

    eligible_nonlink = []
    eligible_link = []
    for typ in sorted(groups):
        items = groups[typ]
        imp = median([p.get("impressions") for p in items])
        ir = median([p.get("interactionRatePct") for p in items])
        cr = median([p.get("clickRatePct") for p in items])
        clicks = int(sum(num(p.get("clicks")) for p in items))
        lines.append(f"| {typ} | {len(items)} | {imp:g} | {ir:g} | {cr:g} | {clicks} |")

        if len(items) >= 3:
            if any(p.get("hasNoteLink") for p in items):
                eligible_link.append((typ, cr, clicks, len(items)))
            else:
                eligible_nonlink.append((typ, imp, ir, len(items)))

    lines += ["", "## Evidence-based next test", ""]

    if eligible_nonlink:
        best = sorted(eligible_nonlink, key=lambda x: (x[1], x[2]), reverse=True)[0]
        lines.append(
            f"- Non-link content: strongest current median impressions among sufficiently sampled types is **{best[0]}** "
            f"({best[1]:g}, n={best[3]}). Keep its structure as the control when testing a new hook."
        )
    else:
        lines.append("- Non-link content: no content type has 3 samples yet. No winner declared.")

    if eligible_link:
        best = sorted(eligible_link, key=lambda x: (x[1], x[2]), reverse=True)[0]
        lines.append(
            f"- Note-link content: strongest current median click rate among sufficiently sampled types is **{best[0]}** "
            f"({best[1]:g}%, total clicks={best[2]}, n={best[3]}). Keep its CTA as the control."
        )
    else:
        lines.append("- Note-link content: no link-post type has 3 samples yet. No CTA winner declared.")

    exp_posts = [p for p in posts if p.get("experimentId") == "AM_HOOK_V1" and p.get("hookVariant")]
    if exp_posts:
        variant_groups = defaultdict(list)
        for p in exp_posts:
            variant_groups[p["hookVariant"]].append(p)

        lines += ["", "## AM_HOOK_V1", ""]
        lines += [
            "| Hook variant | n | Median impressions | Median interaction % |",
            "|---|---:|---:|---:|",
        ]

        eligible_variants = []
        for variant in sorted(variant_groups):
            items = variant_groups[variant]
            imp = median([p.get("impressions") for p in items])
            ir = median([p.get("interactionRatePct") for p in items])
            lines.append(f"| {variant} | {len(items)} | {imp:g} | {ir:g} |")
            if len(items) >= 3:
                eligible_variants.append((variant, imp, ir, len(items)))

        if len(eligible_variants) == 3:
            best = sorted(eligible_variants, key=lambda x: (x[1], x[2]), reverse=True)[0]
            lines += [
                "",
                f"- All three variants reached n>=3. Highest current median impressions: **{best[0]}** ({best[1]:g}).",
                "- Treat this as the next control hook; keep posting time fixed when testing the next variable.",
            ]
        else:
            lines += [
                "",
                "- Hook experiment is still collecting samples. Do not declare a variant winner until every A/B/C group has at least 3 posts.",
            ]

    note_posts = [p for p in posts if p.get("hasNoteLink")]
    if note_posts:
        destination_groups = defaultdict(list)
        for p in note_posts:
            destination_groups[p.get("noteDestination") or "other_note"].append(p)

        lines += [
            "",
            "## Note funnel destinations",
            "",
            "| Destination | n | Impressions | Clicks | CTR % |",
            "|---|---:|---:|---:|---:|",
        ]
        for destination in sorted(destination_groups):
            items = destination_groups[destination]
            impressions = sum(num(p.get("impressions")) for p in items)
            clicks = sum(num(p.get("clicks")) for p in items)
            ctr = round((clicks / impressions) * 100, 4) if impressions else 0
            lines.append(
                f"| {destination} | {len(items)} | {int(impressions)} | {int(clicks)} | {ctr:g} |"
            )

    if len(note_posts) >= 3:
        impressions = sum(num(p.get("impressions")) for p in note_posts)
        clicks = sum(num(p.get("clicks")) for p in note_posts)
        ctr = round((clicks / impressions) * 100, 4) if impressions else 0
        lines += [
            "",
            f"- Aggregate note-link CTR: {ctr:g}% ({int(clicks)} clicks / {int(impressions)} impressions).",
            "- If link clicks rise but paid purchases do not, change the note offer/page before changing X reach tactics.",
        ]

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
