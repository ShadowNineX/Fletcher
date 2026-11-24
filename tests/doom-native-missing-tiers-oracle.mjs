// Compile Doom's pinned wall-tier loop with a one-column framebuffer oracle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function nativeBoolean(value) {
    // A dash represents an unavailable tier. Keep the other tier in the
    // native case rather than dropping the whole projected column.
    return value !== "-" && Number(value) !== 0;
}

function integer(value, label) {
    assert.equal(typeof value, "number", `${label} must be a fixed-point number`);
    assert.ok(Number.isInteger(value), `${label} must be an integer`);
    return value;
}

export function runNativeMissingTiersOracle(upstream, scratch, cases) {
    assert.ok(Array.isArray(cases));
    const segs = readFileSync(path.join(upstream, "r_segs.c"), "utf8").replaceAll("\r\n", "\n");
    const renderLoop = extractFunction(segs, "void", "R_RenderSegLoop");
    const fixture = cases.map((entry, index) => {
        assert.equal(entry.length, 7, `case ${index} has seven fields`);
        const [height, topfrac, bottomfrac, pixhigh, pixlow, hasUpper, hasLower] = entry;
        return `{${integer(height, `case ${index} height`)},${integer(topfrac, `case ${index} topfrac`)},` +
            `${integer(bottomfrac, `case ${index} bottomfrac`)},${integer(pixhigh, `case ${index} pixhigh`)},` +
            `${integer(pixlow, `case ${index} pixlow`)},${Number(nativeBoolean(hasUpper))},${Number(nativeBoolean(hasLower))}}`;
    }).join(",\n    ");
    const scratchDirectory = path.resolve(scratch);
    const source = path.join(scratchDirectory, "missing-tiers-native.c");
    const executable = path.join(scratchDirectory, "missing-tiers-native.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>

typedef int boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef unsigned char byte;
typedef byte lighttable_t;
typedef struct { int top[1], bottom[1]; } visplane_t;
typedef void (*colfunc_t)(void);
enum { false, true, FRACBITS=16, FRACUNIT=1<<FRACBITS, ANGLETOFINESHIFT=19,
    HEIGHTBITS=12, HEIGHTUNIT=1<<HEIGHTBITS, LIGHTSCALESHIFT=12, MAXLIGHTSCALE=48 };

static boolean segtextured=true, markfloor=true, markceiling=true, maskedtexture=false;
static int toptexture, bottomtexture, midtexture, rw_x, rw_stopx, viewheight;
static fixed_t topfrac, bottomfrac, topstep, bottomstep, pixhigh, pixlow, pixhighstep, pixlowstep;
static fixed_t rw_offset, rw_distance, rw_scale=FRACUNIT, rw_scalestep;
static fixed_t rw_midtexturemid, rw_toptexturemid, rw_bottomtexturemid;
static angle_t rw_centerangle, xtoviewangle[1];
static fixed_t finetangent[1];
static lighttable_t light; static lighttable_t *walllightRows[MAXLIGHTSCALE];
static lighttable_t **walllights=walllightRows;
static int ceilingclip[1], floorclip[1], maskedtexturecol[1];
static visplane_t ceilingStore, floorStore, *ceilingplane=&ceilingStore, *floorplane=&floorStore;
static int dc_yl, dc_yh, dc_x; static fixed_t dc_texturemid, dc_iscale; static byte *dc_source; static lighttable_t *dc_colormap;
static fixed_t FixedMul(fixed_t a, fixed_t b) { return (fixed_t)(((int64_t)a*b)>>FRACBITS); }
static byte texture;
static byte *R_GetColumn(int textureId, int column) { (void)textureId; (void)column; return &texture; }
static int painted;
static void countColumn(void) { if (dc_yh >= dc_yl) painted += dc_yh-dc_yl+1; }
static colfunc_t colfunc=countColumn;

${renderLoop}

typedef struct { int height,topfrac,bottomfrac,pixhigh,pixlow,upper,lower; } fixture_t;
static const fixture_t fixtures[] = {
    ${fixture}
};
static void runCase(fixture_t item) {
    rw_x=0; rw_stopx=1; viewheight=item.height;
    topfrac=item.topfrac; bottomfrac=item.bottomfrac; pixhigh=item.pixhigh; pixlow=item.pixlow;
    topstep=bottomstep=pixhighstep=pixlowstep=rw_scalestep=0;
    toptexture=item.upper; bottomtexture=item.lower; midtexture=0; maskedtexture=false;
    ceilingclip[0]=-1; floorclip[0]=item.height; painted=0;
    ceilingStore=(visplane_t){{0},{0}}; floorStore=(visplane_t){{0},{0}};
    R_RenderSegLoop();
    printf("[%d,%d,%d]\\n", ceilingclip[0]+1, floorclip[0], painted);
}
int main(void) {
    for (int index=0; index<MAXLIGHTSCALE; ++index) walllightRows[index]=&light;
    for (unsigned index=0; index<sizeof(fixtures)/sizeof(fixtures[0]); ++index) runCase(fixtures[index]);
    return 0;
}
`);
    const compile = spawnSync(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable], {
        cwd: scratchDirectory, encoding: "utf8", timeout: 30_000,
    });
    if (compile.error) throw compile.error;
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(executable, [], { cwd: scratchDirectory, encoding: "utf8", timeout: 30_000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout.trim().split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row));
}
