import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" } } });
const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "fletcher-doom-automap-view-"));
const cli = path.join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const unit = 65536, width = 128, height = 128;
const bounds = [-256 * unit, -192 * unit, 384 * unit, 320 * unit];
const player = [37 * unit + 123, -41 * unit + 456];
const moved = [player[0] + 3 * unit, player[1] + unit];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function native() {
    const input = path.join(scratch, "view.c"), exe = path.join(scratch, "view.exe");
    const upstream = values.upstream && readFileSync(path.resolve(root, values.upstream, "am_map.c"), "utf8").replaceAll("\r\n", "\n");
    const routines = upstream ? ["AM_changeWindowLoc", "AM_changeWindowScale", "AM_doFollowPlayer", "AM_Ticker"]
        .map(name => extractFunction(upstream, "void", name)).join("\n") : `
void AM_Ticker(void) {
    if (followplayer && (f_oldloc.x != body.x || f_oldloc.y != body.y)) {
        m_x=FTOM(MTOF(body.x))-m_w/2; m_y=FTOM(MTOF(body.y))-m_h/2; f_oldloc=body;
    }
    if (ftom_zoommul != FRACUNIT) {
        scale_mtof=FixedMul(scale_mtof,mtof_zoommul); scale_ftom=FixedDiv(FRACUNIT,scale_mtof); activate();
    }
    if (m_paninc.x || m_paninc.y) {
        followplayer=0; f_oldloc.x=MAXINT; m_x+=m_paninc.x; m_y+=m_paninc.y; clamp();
    }
}`;
    writeFileSync(input, `#include <stdio.h>
typedef int fixed_t; enum { FRACUNIT=65536, F_W=${width}, F_H=${height}, M_ZOOMIN=66846, MAXINT=2147483647 };
static fixed_t FixedMul(fixed_t a, fixed_t b) { return (fixed_t)(((long long)a*b)>>16); }
static fixed_t FixedDiv(fixed_t a, fixed_t b) { return (fixed_t)(((long long)a<<16)/b); }
static fixed_t min_x=${bounds[0]}, min_y=${bounds[1]}, max_x=${bounds[2]}, max_y=${bounds[3]};
static fixed_t min_scale_mtof,max_scale_mtof,scale_mtof,scale_ftom,m_x,m_y,m_x2,m_y2,m_w,m_h,old_m_x,old_m_y,old_m_w,old_m_h;
static int followplayer=1, automapactive=1, amclock, mtof_zoommul, ftom_zoommul;
typedef struct { fixed_t x,y; } point_t;
static point_t body={${player.join(",")}}, m_paninc, f_oldloc={MAXINT,0};
static struct { point_t *mo; } player={&body}, *plr=&player;
#define FTOM(x) FixedMul(((x)<<16),scale_ftom)
#define MTOF(x) (FixedMul((x),scale_mtof)>>16)
void activate(void) { m_x+=m_w/2; m_y+=m_h/2; m_w=FTOM(F_W); m_h=FTOM(F_H); m_x-=m_w/2; m_y-=m_h/2; }
void clamp(void) { if(m_x+m_w/2>max_x)m_x=max_x-m_w/2; else if(m_x+m_w/2<min_x)m_x=min_x-m_w/2; if(m_y+m_h/2>max_y)m_y=max_y-m_h/2; else if(m_y+m_h/2<min_y)m_y=min_y-m_h/2; }
void level(void) { fixed_t a=FixedDiv(F_W<<16,max_x-min_x),b=FixedDiv(F_H<<16,max_y-min_y); min_scale_mtof=a<b?a:b; max_scale_mtof=FixedDiv(F_H<<16,32*FRACUNIT); scale_mtof=FixedDiv(min_scale_mtof,45875); if(scale_mtof>max_scale_mtof)scale_mtof=min_scale_mtof; scale_ftom=FixedDiv(FRACUNIT,scale_mtof); }
void init(void) { m_w=FTOM(F_W); m_h=FTOM(F_H); m_x=body.x-m_w/2; m_y=body.y-m_h/2; clamp(); old_m_x=m_x;old_m_y=m_y;old_m_w=m_w;old_m_h=m_h; }
void save(void) { old_m_x=m_x;old_m_y=m_y;old_m_w=m_w;old_m_h=m_h; }
void restore(void) { m_w=old_m_w;m_h=old_m_h; if(!followplayer){m_x=old_m_x;m_y=old_m_y;}else{m_x=body.x-m_w/2;m_y=body.y-m_h/2;} scale_mtof=FixedDiv(F_W<<16,m_w);scale_ftom=FixedDiv(FRACUNIT,scale_mtof); }
void AM_activateNewScale(void) { activate(); }
void AM_minOutWindowScale(void) { scale_mtof=min_scale_mtof; scale_ftom=FixedDiv(FRACUNIT,scale_mtof); activate(); }
void AM_maxOutWindowScale(void) { scale_mtof=max_scale_mtof; scale_ftom=FixedDiv(FRACUNIT,scale_mtof); activate(); }
${routines}
void row(void) { printf("%d %d %d %d %d %d\\n",m_x,m_y,m_w,m_h,scale_mtof,followplayer); }
void tick(int zoom, int pan) {
    mtof_zoommul=zoom ? M_ZOOMIN : FRACUNIT; ftom_zoommul=zoom ? 64250 : FRACUNIT;
    m_paninc.x=pan ? FTOM(4) : 0;
    AM_Ticker(); row();
}
int main(void) {
    level(); init(); row();
    tick(1,0); tick(1,0); tick(0,0);
    body=(point_t){${moved.join(",")}};
    tick(0,0); tick(0,1);
    save(); AM_minOutWindowScale(); row(); restore(); row(); init(); row();
}
`);
    run("gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(" ").map(Number));
}

function fletcher() {
    const input = path.join(scratch, "main.flt"), output = path.join(scratch, "view.json");
    const b = `{MinX: ${bounds[0]}, MinY: ${bounds[1]}, MaxX: ${bounds[2]}, MaxY: ${bounds[3]}}`;
    writeFileSync(input, `package main
import "automap"
map "Doom automap view parity" {
 screen at (0, 0) size (${width}, ${height}) with { style = "solid", slice = true }
 register step int = 0
 register view automap.View = automap.View{}
 tick {
  if step == 0 { next view = automap.NewView(automap.Bounds${b}, ${player[0]}, ${player[1]}, ${width}, ${height})
  } else if step == 1 { next view = automap.TickView(view, automap.Bounds${b}, ${player[0]}, ${player[1]}, automap.ViewCommand{ZoomIn: true})
  } else if step == 2 { next view = automap.TickView(view, automap.Bounds${b}, ${player.join(", ")}, automap.ViewCommand{ZoomIn: true})
  } else if step == 3 { next view = automap.TickView(view, automap.Bounds${b}, ${player.join(", ")}, automap.ViewCommand{})
  } else if step == 4 { next view = automap.TickView(view, automap.Bounds${b}, ${moved.join(", ")}, automap.ViewCommand{})
  } else if step == 5 { next view = automap.TickView(view, automap.Bounds${b}, ${moved.join(", ")}, automap.ViewCommand{Right: true})
  } else if step == 6 || step == 7 { next view = automap.TickView(view, automap.Bounds${b}, ${moved.join(", ")}, automap.ViewCommand{Full: true})
  } else if step == 8 { next view = automap.RecenterView(view, automap.Bounds${b}, ${moved.join(", ")}) }
  log(view.Window.X, view.Window.Y, view.Window.MapWidth, view.Window.MapHeight, view.Window.Scale, view.Follow)
  next step = step + 1
 }
}`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i < 10; ++i) sim.step();
    return sim.logs.slice(1).map(row => row.map(Number));
}

try {
    assert.deepEqual(fletcher(), native());
    console.log("Doom automap startup, stationary zoom, moving follow, pan, full view, and reopen matched C.");
} finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
