#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 3 ]]; then
    echo "usage: bash $0 PINNED_LINUXDOOM_SOURCE IWAD TRACE_DIRECTORY" >&2
    exit 2
fi

upstream=$(cd -- "$1" && pwd)
wad=$(realpath -- "$2")
fixture=$(cd -- "$(dirname -- "$0")" && pwd)/doom-demo-tic-oracle.c
mkdir -p -- "$3"
traces=$(cd -- "$3" && pwd)
build="$traces/build"
mkdir -p -- "$build"

sources=()
for source in "$upstream"/*.c; do
    case "${source##*/}" in
        i_main.c|i_net.c|i_video.c|i_sound.c|sndserver.c) continue ;;
        m_misc.c|p_setup.c|r_data.c|r_draw.c|r_things.c) sources+=("$build/${source##*/}") ;;
        *) sources+=("$source") ;;
    esac
done

# Keep the 1997 source intact. Adapt the temporary copies for 64-bit
# addresses and preserve the fixed-size WAD records.
sed -E 's/(int)([[:space:]]+defaultvalue;)/long\2/; s/\(int\)([[:space:]]*("|HUSTR_CHATMACRO))/\(long\)\1/g' \
    "$upstream/m_misc.c" > "$build/m_misc.c"
sed -E 's/\(int\)colormaps \+ 255\)\&~0xff/\(long\)colormaps + 255)\&~0xffL/;
    s/void[[:space:]]+\*\*columndirectory;/int columndirectory;/;
    s/(textures|texturecolumnlump|texturecolumnofs|texturecomposite)( = Z_Malloc \(numtextures)\*4,/\1\2*sizeof(*\1),/' \
    "$upstream/r_data.c" > "$build/r_data.c"
sed -e 's/(int)translationtables/(long)translationtables/; s/\& ~255);/\& ~255L);/' \
    "$upstream/r_draw.c" > "$build/r_draw.c"
sed 's/while (\*check != NULL)/while (check - namelist < NUMSPRITES \&\& *check != NULL)/' \
    "$upstream/r_things.c" > "$build/r_things.c"
sed 's/linebuffer = Z_Malloc (total\*4,/linebuffer = Z_Malloc (total*sizeof(*linebuffer),/' \
    "$upstream/p_setup.c" > "$build/p_setup.c"

if ! gcc -std=gnu89 -O1 -g -fcommon -fwrapv -fno-strict-aliasing \
    -DNORMALUNIX -DLINUX -DSNDSRV -I "$upstream" "${sources[@]}" "$fixture" \
    -lm -o "$build/oracle" > "$build/build.log" 2>&1; then
    cat "$build/build.log" >&2
    exit 1
fi

ulimit -c 0
for demo in 1 2 3 4; do
    log="$traces/native-demo-$demo.log"
    if ! "$build/oracle" "$wad" "DEMO$demo" > "$log" 2>&1; then
        tail -n 24 "$log" >&2
        exit 1
    fi
    printf 'DEMO%d: %s tics\n' "$demo" "$(grep -c '^DEMO-TIC ' "$log")"
done
