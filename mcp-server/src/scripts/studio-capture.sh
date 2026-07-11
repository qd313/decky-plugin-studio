#!/usr/bin/env bash
# bonsai-capture.sh — Steam Deck screenshot helper (game-mode QAM/bonsAI composited capture).
# Invoked locally on the Deck or via scripts/screenshot-deck.ps1 over SSH.
set +e

CAPTURE_MODE="auto"
OUT=""
DIAG="/tmp/bonsai-capture.diag"
RESULT_FILE="/tmp/bonsai-capture.result"
QUIET=0
CAPTURE_METHOD="kmsgrab"
RESOLVED_MODE="unknown"
RUN_EPOCH=$(date +%s)
MIN_PNG_BYTES=51200

TARGET_USER="${SUDO_USER:-${USER:-deck}}"
RD="/run/user/$(id -u "$TARGET_USER" 2>/dev/null || id -u deck)"
BONSAI_ALLOW_STEAMOS_RW="${BONSAI_ALLOW_STEAMOS_RW:-true}"

usage() {
  cat <<'EOF'
Usage: bonsai-capture.sh [options]

Capture Steam Deck UI for bonsAI / Decky debugging.

Options:
  --auto              Same as --mode auto (default)
  --mode MODE         auto | game | desktop
  --out PATH          Output PNG path (default: /tmp/deck_ui_capture.png or ~/Pictures/...)
  --diag PATH         Diagnostic log path (default: /tmp/bonsai-capture.diag)
  --quiet             Suppress non-error messages
  -h, --help          Show this help

Environment:
  BONSAI_ALLOW_STEAMOS_RW  Set to 0/false to skip steamos-readonly toggle for grim install

Game mode:  gamescope atom (full composition, QAM + overlays) -> kmsgrab fallback (game-only).
Desktop:    grim (Plasma Wayland) -> kmsgrab fallback.
Auto:       detect_mode() then dispatch.

On success prints:
  ---CAPTURE_RESULT--- mode=<mode> method=<method> bytes=<N> path=<out>
EOF
}

log() {
  [ "$QUIET" = 1 ] && return
  echo "$*" >&2
}

diag() {
  echo "$*" >>"$DIAG"
}

emit_result() {
  local bytes=0
  if [ -f "$OUT" ]; then
    bytes=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
  fi
  local line="---CAPTURE_RESULT--- mode=${RESOLVED_MODE} method=${CAPTURE_METHOD} bytes=${bytes} path=${OUT}"
  echo "$line"
  if [ -n "$RESULT_FILE" ]; then
    printf '%s\n' "$line" >"$RESULT_FILE" 2>/dev/null
    chmod 0644 "$RESULT_FILE" 2>/dev/null
  fi
}

validate_png() {
  local f="$1"
  [ -f "$f" ] || return 1
  local sz mt
  sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
  mt=$(stat -c%Y "$f" 2>/dev/null || echo 0)
  [ "$sz" -ge "$MIN_PNG_BYTES" ] || return 1
  [ "$mt" -ge "$RUN_EPOCH" ] || return 1
  return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --auto) CAPTURE_MODE="auto"; shift ;;
    --mode)
      CAPTURE_MODE="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    --diag)
      DIAG="${2:-}"
      shift 2
      ;;
    --result)
      RESULT_FILE="${2:-}"
      shift 2
      ;;
    --no-steamos-rw) BONSAI_ALLOW_STEAMOS_RW="false"; shift ;;
    --allow-steamos-rw) BONSAI_ALLOW_STEAMOS_RW="true"; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$CAPTURE_MODE" in
  auto|game|desktop) ;;
  *)
    echo "Invalid --mode: $CAPTURE_MODE (use auto, game, or desktop)" >&2
    exit 2
    ;;
esac

if [ -z "$OUT" ]; then
  if [ -n "${BONSAI_CAPTURE_OUT:-}" ]; then
    OUT="$BONSAI_CAPTURE_OUT"
  elif [ "$(id -u)" -eq 0 ] || [ -n "${SUDO_USER:-}" ]; then
    OUT="/tmp/deck_ui_capture.png"
  else
    UH=$(getent passwd "$TARGET_USER" | cut -d: -f6)
    mkdir -p "$UH/Pictures" 2>/dev/null
    OUT="$UH/Pictures/bonsai-capture-$(date +%Y%m%d_%H%M%S).png"
  fi
fi

: >"$DIAG"
diag "bonsai-capture start epoch=$RUN_EPOCH mode_flag=$CAPTURE_MODE out=$OUT user=$TARGET_USER rd=$RD"

detect_mode() {
  deck_uid=$(id -u "$TARGET_USER" 2>/dev/null) || deck_uid=1000
  if pgrep -x gamescope >/dev/null 2>&1 || pgrep -x gamescope-wl >/dev/null 2>&1; then
    gs_pids=$(pgrep -x gamescope 2>/dev/null; pgrep -x gamescope-wl 2>/dev/null)
    for pid in $gs_pids; do
      owner=$(stat -c%U "/proc/$pid" 2>/dev/null || echo "")
      if [ "$owner" = "$TARGET_USER" ] || [ -z "$owner" ]; then
        diag "detect_mode: game (gamescope pid=$pid owner=$owner)"
        echo "game"
        return 0
      fi
    done
    diag "detect_mode: game (gamescope running)"
    echo "game"
    return 0
  fi
  if pgrep -x plasmashell >/dev/null 2>&1 || pgrep -x kwin_wayland >/dev/null 2>&1; then
    diag "detect_mode: desktop (plasmashell/kwin_wayland)"
    echo "desktop"
    return 0
  fi
  diag "detect_mode: unknown"
  echo "unknown"
}

resolve_capture_mode() {
  if [ "$CAPTURE_MODE" = "auto" ]; then
    detect_mode
  else
    echo "$CAPTURE_MODE"
  fi
}

bonsai_env_from_pid() {
  local pid="$1"
  [ -r "/proc/$pid/environ" ] || return 1
  local envf
  envf=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null)
  local d xa
  d=$(echo "$envf" | sed -n 's/^DISPLAY=//p' | head -1)
  [ -z "$d" ] && return 1
  xa=$(echo "$envf" | sed -n 's/^XAUTHORITY=//p' | head -1)
  echo "$d|$xa"
  return 0
}

# Trigger Gamescope composited screenshot via X11 atom (mode 3 = full_composition).
bonsai_try_gamescope_atom_screenshot() {
  GS_OUT=/tmp/gamescope.png
  if ! command -v xprop >/dev/null 2>&1; then
    diag "gamescope-atom: xprop not found"
    return 1
  fi

  cand=/tmp/bonsai_xcands.$$
  : >"$cand"

  # Priority 1: gamescope / gamescope-wl PIDs (outer compositor — QAM + Decky).
  for pid in $(pgrep -x gamescope 2>/dev/null) $(pgrep -x gamescope-wl 2>/dev/null); do
    line=$(bonsai_env_from_pid "$pid") || continue
    echo "$line" >>"$cand"
    diag "gamescope-atom: candidate from gamescope pid=$pid -> $line"
  done

  # Priority 2: steam (not steamwebhelper — inner Xwayland pollutes candidates).
  for pid in $(pgrep -x steam 2>/dev/null); do
    line=$(bonsai_env_from_pid "$pid") || continue
    echo "$line" >>"$cand"
    diag "gamescope-atom: candidate from steam pid=$pid -> $line"
  done

  cands=$(awk '!seen[$0]++' "$cand")
  rm -f "$cand"

  for d in :0 :1 :2; do
    case $cands in *"$d|"*) ;; *) cands="${cands}"$'\n'"$d|" ;; esac
  done

  rm -f "$GS_OUT" 2>/dev/null || sudo rm -f "$GS_OUT" 2>/dev/null || true
  atom_epoch=$RUN_EPOCH

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    d="${line%%|*}"
    xa="${line#*|}"
    diag "gamescope-atom: trying DISPLAY=$d XAUTHORITY=${xa:-<none>}"
    if [ -n "$xa" ]; then
      sudo -u "$TARGET_USER" env DISPLAY="$d" XAUTHORITY="$xa" \
        xprop -root -f GAMESCOPECTRL_REQUEST_SCREENSHOT 32c \
        -set GAMESCOPECTRL_REQUEST_SCREENSHOT 3 >/dev/null 2>&1
    else
      sudo -u "$TARGET_USER" env DISPLAY="$d" \
        xprop -root -f GAMESCOPECTRL_REQUEST_SCREENSHOT 32c \
        -set GAMESCOPECTRL_REQUEST_SCREENSHOT 3 >/dev/null 2>&1
    fi
    rc=$?
    [ "$rc" != 0 ] && continue

    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if [ -f "$GS_OUT" ]; then
        gs_mt=$(stat -c%Y "$GS_OUT" 2>/dev/null || echo 0)
        gs_sz=$(stat -c%s "$GS_OUT" 2>/dev/null || echo 0)
        if [ "$gs_mt" -ge "$atom_epoch" ] && [ "$gs_sz" -ge "$MIN_PNG_BYTES" ]; then
          break
        fi
      fi
      sleep 0.25
    done

    if validate_png "$GS_OUT"; then
      cp "$GS_OUT" "$OUT" && chmod 0644 "$OUT" 2>/dev/null
      diag "gamescope-atom: success from $GS_OUT -> $OUT"
      return 0
    fi
    diag "gamescope-atom: stale or small png after DISPLAY=$d"
  done <<EOF_CANDS
$cands
EOF_CANDS

  diag "gamescope-atom: all candidates failed"
  return 1
}

bonsai_install_grim_portable() {
  UH=$(getent passwd "$TARGET_USER" | cut -d: -f6)
  GBIN="$UH/.local/bin"
  GEXE="$GBIN/grim"
  [ -x "$GEXE" ] && return 0
  mkdir -p "$GBIN"
  PKG=/tmp/bonsai_grim.pkg.tar.zst
  rm -f "$PKG"
  ok=0
  for url in \
    "https://steamdeck-packages.steamos.cloud/archlinux-mirror/extra/os/x86_64/grim-1.5.0-1-x86_64.pkg.tar.zst" \
    "https://geo.mirror.pkgbuild.com/extra/os/x86_64/grim-1.5.0-1-x86_64.pkg.tar.zst" \
    "https://archive.archlinux.org/packages/g/grim/grim-1.5.0-1-x86_64.pkg.tar.zst"
  do
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 12 --max-time 90 "$url" -o "$PKG" 2>/dev/null && ok=1 && break
    fi
    if command -v wget >/dev/null 2>&1; then
      wget -q --timeout=90 --tries=1 "$url" -O "$PKG" 2>/dev/null && ok=1 && break
    fi
  done
  [ "$ok" = 1 ] && [ -f "$PKG" ] || return 1
  rm -rf /tmp/bonsai_grim_extract && mkdir -p /tmp/bonsai_grim_extract
  if ! bsdtar -xf "$PKG" -C /tmp/bonsai_grim_extract usr/bin/grim 2>/dev/null; then
    tar -I zstd -xf "$PKG" -C /tmp/bonsai_grim_extract usr/bin/grim 2>/dev/null || return 1
  fi
  install -m 755 /tmp/bonsai_grim_extract/usr/bin/grim "$GEXE"
  chown "$TARGET_USER:$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")" "$GBIN" "$GEXE" 2>/dev/null || \
    chown "$TARGET_USER:$TARGET_USER" "$GBIN" "$GEXE"
  [ -x "$GEXE" ]
}

bonsai_resolve_grim_exe() {
  if command -v grim >/dev/null 2>&1; then
    command -v grim
    return 0
  fi
  UH=$(getent passwd "$TARGET_USER" | cut -d: -f6)
  if [ -x "$UH/.local/bin/grim" ]; then
    echo "$UH/.local/bin/grim"
    return 0
  fi
  return 1
}

bonsai_ensure_grim() {
  UH=$(getent passwd "$TARGET_USER" | cut -d: -f6)
  if command -v grim >/dev/null 2>&1 || [ -x "$UH/.local/bin/grim" ]; then
    return 0
  fi
  if bonsai_install_grim_portable >>/tmp/bonsai_grim_install.log 2>&1; then
    return 0
  fi
  : >/tmp/bonsai_grim_install.log
  if sudo pacman -Sy --needed --noconfirm grim >>/tmp/bonsai_grim_install.log 2>&1 && command -v grim >/dev/null 2>&1; then
    return 0
  fi
  case "$BONSAI_ALLOW_STEAMOS_RW" in
    0|false|FALSE|no|NO) return 1 ;;
  esac
  if ! command -v steamos-readonly >/dev/null 2>&1; then
    return 1
  fi
  if ! sudo steamos-readonly disable >>/tmp/bonsai_grim_install.log 2>&1; then
    return 1
  fi
  sudo pacman -Sy --needed --noconfirm grim >>/tmp/bonsai_grim_install.log 2>&1 || true
  if ! sudo steamos-readonly enable >>/tmp/bonsai_grim_install.log 2>&1; then
    log "WARNING: steamos-readonly enable failed after grim install attempt."
  fi
  command -v grim >/dev/null 2>&1
}

grim_sock_add() {
  local sp="$1"
  [ -S "$sp" ] || return
  local e
  for e in "${grim_socks[@]}"; do
    [ "$e" = "$sp" ] && return
  done
  grim_socks+=("$sp")
}

bonsai_scan_procs_for_wayland_sockets() {
  seen=/tmp/bonsai_wlseen.$$
  : >"$seen"
  deck_uid=$(id -u "$TARGET_USER" 2>/dev/null) || deck_uid=1000
  for pid in $(pgrep -x plasmashell 2>/dev/null) $(pgrep -x kwin_wayland 2>/dev/null) \
    $(pgrep -u "$deck_uid" plasmashell 2>/dev/null) $(pgrep -u "$deck_uid" 2>/dev/null | head -30); do
    [ -r "/proc/$pid/environ" ] || continue
    envf=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null)
    w=$(echo "$envf" | sed -n 's/^WAYLAND_DISPLAY=//p' | head -1)
    r=$(echo "$envf" | sed -n 's/^XDG_RUNTIME_DIR=//p' | head -1)
    [ -n "$w" ] && [ -n "$r" ] && [ -S "$r/$w" ] || continue
    k="${r}|${w}"
    grep -qxF "$k" "$seen" 2>/dev/null && continue
    echo "$k" >>"$seen"
    grim_sock_add "$r/$w"
    diag "grim: socket from pid=$pid -> $r/$w"
  done
  rm -f "$seen"
}

bonsai_try_grim_screenshot() {
  bonsai_ensure_grim || true
  GRIM_EXE=$(bonsai_resolve_grim_exe) || GRIM_EXE=""
  [ -n "$GRIM_EXE" ] || return 1

  shopt -s nullglob
  grim_socks=()
  bonsai_scan_procs_for_wayland_sockets
  for sock in "$RD"/wayland-*; do
    case "$sock" in *-ei) continue ;; esac
    grim_sock_add "$sock"
  done

  GRIM_DEADLINE=45
  for sock in "${grim_socks[@]}"; do
    [ -S "$sock" ] || continue
    wl=$(basename "$sock")
    sock_rd=$(dirname "$sock")
    diag "grim: trying $sock_rd WAYLAND_DISPLAY=$wl"
    grim_ok=0
    if command -v timeout >/dev/null 2>&1; then
      if sudo -u "$TARGET_USER" env XDG_RUNTIME_DIR="$sock_rd" WAYLAND_DISPLAY="$wl" \
        timeout "$GRIM_DEADLINE" "$GRIM_EXE" -t png "$OUT" 2>/tmp/bonsai_grim_err.log; then
        grim_ok=1
      fi
    else
      if sudo -u "$TARGET_USER" env XDG_RUNTIME_DIR="$sock_rd" WAYLAND_DISPLAY="$wl" \
        "$GRIM_EXE" -t png "$OUT" 2>/tmp/bonsai_grim_err.log; then
        grim_ok=1
      fi
    fi
    if [ "$grim_ok" = 1 ] && validate_png "$OUT"; then
      diag "grim: success on $sock"
      return 0
    fi
  done
  diag "grim: all sockets failed"
  return 1
}

bonsai_try_kmsgrab() {
  diag "kmsgrab: attempting primary-plane capture (overlays may be missing)"
  if command -v timeout >/dev/null 2>&1; then
    timeout 90 ffmpeg -loglevel error -device /dev/dri/card0 -f kmsgrab -i - \
      -vframes 1 -vf 'hwmap=derive_device=vaapi,hwdownload,format=bgr0' -y "$OUT"
    return $?
  fi
  ffmpeg -loglevel error -device /dev/dri/card0 -f kmsgrab -i - \
    -vframes 1 -vf 'hwmap=derive_device=vaapi,hwdownload,format=bgr0' -y "$OUT"
  return $?
}

capture_game_mode() {
  log "Game mode: gamescope atom (full composition) -> kmsgrab fallback"
  if bonsai_try_gamescope_atom_screenshot; then
    CAPTURE_METHOD="gamescope-atom"
    return 0
  fi
  log "Gamescope atom failed; falling back to kmsgrab (game-only, no QAM/overlays)"
  if bonsai_try_kmsgrab; then
    CAPTURE_METHOD="kmsgrab"
    return 0
  fi
  return 1
}

capture_desktop_mode() {
  log "Desktop mode: grim (Plasma Wayland) -> kmsgrab fallback"
  if bonsai_try_grim_screenshot; then
    CAPTURE_METHOD="grim"
    return 0
  fi
  if bonsai_try_kmsgrab; then
    CAPTURE_METHOD="kmsgrab"
    return 0
  fi
  return 1
}

capture_unknown_mode() {
  log "Unknown mode: trying gamescope atom then grim then kmsgrab"
  if bonsai_try_gamescope_atom_screenshot; then
    CAPTURE_METHOD="gamescope-atom"
    return 0
  fi
  if bonsai_try_grim_screenshot; then
    CAPTURE_METHOD="grim"
    return 0
  fi
  if bonsai_try_kmsgrab; then
    CAPTURE_METHOD="kmsgrab"
    return 0
  fi
  return 1
}

RESOLVED_MODE=$(resolve_capture_mode)
diag "resolved_mode=$RESOLVED_MODE"

FE=1
case "$RESOLVED_MODE" in
  game) capture_game_mode; FE=$? ;;
  desktop) capture_desktop_mode; FE=$? ;;
  *) capture_unknown_mode; FE=$? ;;
esac

if [ "$FE" -eq 0 ] && validate_png "$OUT"; then
  log "Capture OK: mode=$RESOLVED_MODE method=$CAPTURE_METHOD path=$OUT"
  emit_result
  exit 0
fi

diag "capture failed fe=$FE out_exists=$([ -f "$OUT" ] && echo yes || echo no)"
emit_result
exit "${FE:-1}"
