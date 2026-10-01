#!/usr/bin/env python3
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

BASE = Path('automation/ai-command-x/analytics')


def known(values):
    return [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]


def fmt(value):
    return '未取得' if value is None else f'{value:g}'


def median(values):
    values = known(values)
    return round(statistics.median(values), 4) if values else None


def total(values):
    values = list(values)
    numbers = known(values)
    return sum(numbers) if numbers and len(numbers) == len(values) else None


def main():
    data = json.loads((BASE / 'posts.json').read_text(encoding='utf-8'))
    posts = data.get('posts', [])
    age_path = BASE / 'age_snapshots.json'
    ages = json.loads(age_path.read_text(encoding='utf-8')) if age_path.exists() else {'posts': {}}
    lines = [
        '# AI Command X Data Decision', '',
        f"- 取得日時: {data.get('generatedAt', '未取得')}",
        f'- 配信記録: {len(posts)}本。欠損値は0に置き換えない。',
        '- 購入数・売上・流入元別の購入帰属: 未取得。Xクリックとは別集計。',
        '- 同じ役割・同じ経過時間で最低3本を比較。現在値の合計だけで勝者を決めない。', '',
        '## 現在値の取得状況（投稿経過時間は混在）', '',
        '| 分類 | 本数 | 表示取得済み | 取得済み表示の小計 | クリック取得済み | 全件クリック合計 |',
        '|---|---:|---:|---:|---:|---:|',
    ]
    groups = defaultdict(list)
    for post in posts:
        group = post.get('noteDestination') if post.get('hasNoteLink') is True else 'unknown_link' if post.get('hasNoteLink') is None else post.get('contentType') or 'unmapped'
        groups[group or 'other_note'].append(post)
    for group, items in sorted(groups.items()):
        impressions = known(p.get('impressions') for p in items)
        clicks = known(p.get('clicks') for p in items)
        lines.append(f'| {group} | {len(items)} | {len(impressions)} | {fmt(sum(impressions) if impressions else None)} | {len(clicks)} | {fmt(total(p.get("clicks") for p in items))} |')
    for hours in (24, 72):
        snapshots = [entry[str(hours)]['snapshot'] for entry in ages.get('posts', {}).values() if entry.get(str(hours), {}).get('status') == 'captured' and entry[str(hours)].get('snapshot')]
        role_groups = defaultdict(list)
        for post in snapshots:
            if post.get('hasNoteLink') is None:
                continue
            role = 'note_link' if post.get('hasNoteLink') else post.get('contentType') or 'unmapped'
            role_groups[role].append(post)
        lines += ['', f'## {hours}時間後（許容窓+2時間）', '',
                  '- 集計対象は収集時刻と指標更新時刻の両方が許容窓に入った保存値。遅延・未取得は比較から除外。', '',
                  '| 役割 | 本数 | 表示中央値 | 表示取得済み | CTR中央値 % | CTR取得済み |',
                  '|---|---:|---:|---:|---:|---:|']
        for role, items in sorted(role_groups.items()):
            impressions = known(p.get('impressions') for p in items)
            rates = known(p.get('clickRatePct') for p in items)
            lines.append(f'| {role} | {len(items)} | {fmt(median(impressions))} | {len(impressions)} | {fmt(median(rates))} | {len(rates)} |')
        if not role_groups:
            lines.append('| 未取得 | 0 | 未取得 | 0 | 未取得 | 0 |')
        lines.append('- 同じ役割で比較する指標が3本分以上そろうまで、勝敗は保留。A/Bは各2本の設計なので記事別の勝者は決めない。')
        variants = defaultdict(list)
        for post in snapshots:
            if post.get('experimentId') == 'AM_HOOK_V1' and post.get('hookVariant'):
                variants[post['hookVariant']].append(post)
        if variants:
            lines += ['', '### AM_HOOK_V1', '', '| Variant | 表示取得済み | 表示中央値 |', '|---|---:|---:|']
            for variant, items in sorted(variants.items()):
                values = known(p.get('impressions') for p in items)
                lines.append(f'| {variant} | {len(values)} | {fmt(median(values))} |')
            lines.append('- A/B/C各3本以上の同経過時間の指標がそろうまで比較保留。')
    lines += ['', '## 次の判断', '',
              '- 3日目は投稿失敗・導線切れ・取得遅延を診断。7日目は同経過時間の内容比較。',
              '- 表示が弱い場合は同じ時間枠の冒頭、クリックが弱い場合は本文と誘導を検討。',
              '- 購入数が不明な間は購入率を推定しない。商品閲覧・購入の確認後に無料部分と説明の一致を確認。',
              '- 主要変数は一度に1つ。予約済み原稿・価格・別実験を勝手に変更しない。']
    (BASE / 'decision.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Wrote {BASE / "decision.md"}')


if __name__ == '__main__':
    main()
