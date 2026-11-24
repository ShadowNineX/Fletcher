// Compile id's pinned intermission ticker with rendering and animation stubbed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function pick(text, name) {
    const start = text.indexOf(`void ${name}(void)`);
    assert.ok(start >= 0, `Missing ${name}`);
    let depth = 0;
    for (let index = text.indexOf("{", start); index < text.length; index++) {
        if (text[index] === "{") depth++;
        if (text[index] === "}" && --depth === 0) return text.slice(start, index + 1);
    }
    assert.fail(`Unclosed ${name}`);
}

export function runNativeIntermissionOracle(upstream, scratch, { music = false, pointer = false } = {}) {
    const wi = readFileSync(path.join(upstream, "wi_stuff.c"), "utf8").replaceAll("\r\n", "\n");
    const functions = ["WI_initNoState", "WI_updateNoState", "WI_initShowNextLoc", "WI_updateShowNextLoc", "WI_initStats", "WI_updateStats", "WI_checkForAccelerate", "WI_Ticker"].map(name => pick(wi, name)).join("\n");
    const sounds = readFileSync(path.join(upstream, "sounds.h"), "utf8");
    const ids = sounds.match(/\bmus_None,[\s\S]*?\bNUMMUSIC\b/)?.[0];
    assert.ok(ids?.includes("mus_dm2int"), "extract the pinned music IDs");
    const input = path.join(scratch, "intermission-native.c");
    const executable = path.join(scratch, "intermission-native.exe");
    writeFileSync(input, `#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef int boolean;
enum { false, true, MAXPLAYERS=1, TICRATE=35, SHOWNEXTLOCDELAY=4, BT_ATTACK=1, BT_USE=2, StatCount=1, ShowNextLoc=2, NoState=3, commercial=1 };
enum { BT_SPECIAL=128, BTS_PAUSE=1 };
enum { sfx_pistol=1, sfx_barexp=2, sfx_sgcock=3 };
enum { ${ids} };
typedef struct { int buttons; } ticcmd_t; typedef struct { ticcmd_t cmd; boolean attackdown, usedown; } player_t;
typedef struct { int skills, sitems, ssecret, stime; } wbplayerstruct_t; typedef struct { int maxkills, maxitems, maxsecret, partime; } wbstartstruct_t;
static player_t players[1]; static boolean playeringame[1]={true}; static int me; static wbplayerstruct_t plrs[1]; static wbstartstruct_t record,*wbs=&record;
static int state,acceleratestage,sp_state,cnt_kills[1],cnt_items[1],cnt_secret[1],cnt_time,cnt_par,cnt_pause,cnt,bcnt,gamemode,sound; static boolean snl_pointeron;
static int deathmatch, netgame, music_trace, worldsDone, drawnPointer;
static void WI_updateAnimatedBack(void) {} static void WI_initAnimatedBack(void) {} static void WI_End(void) {} static void G_WorldDone(void) { ++worldsDone; } static void S_StartSound(int x,int y) { (void)x; sound=y; }
static void WI_updateDeathmatchStats(void) {} static void WI_updateNetgameStats(void) {}
static void S_ChangeMusic(int id, int loop) { if (music_trace) printf("%d %d %d %d\\n", gamemode, bcnt, id, loop); }
${functions}
static void WI_drawShowNextLoc(void) { drawnPointer=snl_pointeron; }
${pick(wi, "WI_drawNoState")}

static void tickButtons(int buttons) { players[0].cmd.buttons=buttons; WI_Ticker(); }
static void tracePointer(void) {
    for (int level=0; level<2; level++) {
        bcnt=0;
        WI_initStats();
        tickButtons(0);
        tickButtons(BT_ATTACK); // finish counting stats
        tickButtons(0);
        tickButtons(BT_USE);    // enter ShowNextLoc
        assert(state==ShowNextLoc);
        int first=snl_pointeron;
        WI_drawShowNextLoc();
        assert(drawnPointer==first);

        // Let the pointer blink off, then skip to NoState with a fresh
        // attack press. Only drawing this frame should set the latch again.
        for (int i=0; i<32; i++) {
            tickButtons(0);
            if (!snl_pointeron) break;
        }
        assert(state==ShowNextLoc && !snl_pointeron);
        tickButtons(BT_ATTACK);
        assert(state==NoState && !snl_pointeron);
        drawnPointer=-1;
        WI_drawNoState();
        assert(drawnPointer==snl_pointeron);
        printf("%d %d %d\\n",level,first,snl_pointeron);

        for (int i=0; i<10; i++) tickButtons(0);
        assert(worldsDone==level+1);
    }
}
int main(int argc, char **argv) {
    record=(wbstartstruct_t){100,10,1,70}; plrs[0]=(wbplayerstruct_t){50,10,0,140}; players[0].attackdown=true;
    if (argc > 1 && !strcmp(argv[1],"pointer")) { tracePointer(); return 0; }
    if (argc > 1) {
        music_trace=1;
        for (gamemode=0; gamemode<=commercial; gamemode++) {
            bcnt=0; WI_initStats();
            for (int tic=0; tic<3; tic++) WI_Ticker();
        }
        return 0;
    }
    WI_initStats();
    for (int tic=0; tic<52; tic++) {
        sound=0;
        // The pause command has the same low bit as attack.
        players[0].cmd.buttons=tic==39?(BT_SPECIAL|BTS_PAUSE):(tic==0||tic==41?BT_ATTACK:(tic==36?BT_USE:0));
        WI_Ticker();
        printf("%d %d %d %d %d %d %d %d %d %d %d %d\\n",tic,state,sp_state,cnt_pause,cnt,cnt_kills[0],cnt_items[0],cnt_secret[0],cnt_time,cnt_par,snl_pointeron,sound);
    }
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", executable]);
    const args = pointer ? ["pointer"] : music ? ["music"] : [];
    return run(executable, args).trim().split(/\r?\n/).filter(Boolean).map(line => line.split(" ").map(Number));
}
