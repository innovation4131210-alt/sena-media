#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-media/camera-roll-v3}"
FPS=30
WIDTH=1080
HEIGHT=1920

find_shot() {
  local dir="$1"
  local n="$2"
  local ext
  for ext in png jpg jpeg webp; do
    if [[ -s "$dir/shot-$n.$ext" ]]; then
      printf '%s\n' "$dir/shot-$n.$ext"
      return 0
    fi
  done
  return 1
}

build_one() {
  local dir="$1"
  local id
  id="$(basename "$dir")"

  local s1 s2 s3
  s1="$(find_shot "$dir" 1)" || return 0
  s2="$(find_shot "$dir" 2)" || return 0
  s3="$(find_shot "$dir" 3)" || return 0

  local out="media/camera-roll-v3/${id}.mp4"
  mkdir -p "$(dirname "$out")"

  echo "Building camera-roll v3: $id"

  ffmpeg -hide_banner -loglevel warning -y \
    -loop 1 -t 2 -i "$s1" \
    -loop 1 -t 2 -i "$s2" \
    -loop 1 -t 2 -i "$s3" \
    -filter_complex "[0:v]scale=1120:1992:force_original_aspect_ratio=increase,crop=1080:1920:x='20+4*sin(4*t)':y='36+3*sin(3*t)',zoompan=z='1.000+0.00020*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=60:s=1080x1920:fps=30,setsar=1[v0];[1:v]scale=1120:1992:force_original_aspect_ratio=increase,crop=1080:1920:x='24+3*sin(3*t)':y='34+4*sin(4*t)',zoompan=z='1.012-0.00016*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=60:s=1080x1920:fps=30,setsar=1[v1];[2:v]scale=1120:1992:force_original_aspect_ratio=increase,crop=1080:1920:x='18+4*sin(5*t)':y='38+3*sin(2*t)',zoompan=z='1.002+0.00018*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=60:s=1080x1920:fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0,format=yuv420p[v]" \
    -map "[v]" -an -t 6 \
    -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p \
    -movflags +faststart -map_metadata -1 "$out"

  local duration width height size
  duration="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out")"
  width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nw=1:nk=1 "$out")"
  height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$out")"
  size="$(stat -c%s "$out")"

  awk -v d="$duration" 'BEGIN { exit !(d >= 5.9 && d <= 6.1) }'
  [[ "$width" == "$WIDTH" ]]
  [[ "$height" == "$HEIGHT" ]]
  [[ "$size" -gt 10000 ]]
  [[ "$size" -lt 95000000 ]]

  echo "Built $out duration=$duration size=$size"
}

shopt -s nullglob
for dir in "$ROOT"/*/; do
  build_one "${dir%/}"
done
