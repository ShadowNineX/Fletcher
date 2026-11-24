import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-campaign-"));

const episode = (episode, mission, secret = false) => ({episode, mission, secret, commercial: false, prior: 0, didSecret: false});
const commercial = (mission, secret = false, prior = 0, didSecret = false) => ({episode: 1, mission, secret, commercial: true, prior, didSecret});
const cases = [
    ...[1, 2, 3, 4].flatMap(ep => Array.from({length: 9}, (_, n) => episode(ep, n + 1))),
    episode(1, 3, true), episode(2, 5, true), episode(3, 6, true), episode(4, 2, true),
    ...Array.from({length: 32}, (_, n) => commercial(n + 1)),
    commercial(15, true), commercial(31, true), commercial(4, true, 9), commercial(16, false, 0, true),
];
const nameOf = c => c.commercial ? `MAP${String(c.mission).padStart(2, "0")}` : `E${c.episode}M${c.mission}`;

function lump(name) {
    const bytes = Buffer.alloc(8);
    bytes.write(name);
    return [bytes.readInt32LE(0), bytes.readInt32LE(4)];
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcher() {
    const choices = cases.map((c, i) => {
        const [low, high] = lump(nameOf(c));
        return `        case ${i}: name, secret, prior, didSecret = wad.LumpName{Low: ${low}, High: ${high}}, ${c.secret}, ${c.prior}, ${c.didSecret}`;
    });
    const source = `package main
import "play"
import "wad"
map "Doom campaign routes" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var name wad.LumpName
        secret, prior, didSecret := false, 0, false
        switch currentTick() {
${choices.join("\n")}
        }
        route := play.PlanCampaignRoute(name, secret, didSecret, prior)
        before := play.NewPlayerInventory(64)
        before.Armor, before.ArmorType, before.KillCount, before.ItemCount, before.SecretCount = 57, 2, 8, 5, 3
        before.Cards[0] = true
        before.Powers[2], before.DamageCount, before.BonusCount, before.FixedColormap = 124, 34, 9, 1
        actor := play.LevelActor{Physics: play.ActorPhysics{Body: play.MapActor{Flags: play.ActorShadow | play.ActorShootable}}}
        finished := play.FinishCampaignPlayer(before, actor, play.WeaponView{ExtraLight: 2})
        player := finished.Inventory
        after := play.CampaignSpawnInventory(player)
        log(route.Valid, route.Episode, route.LastMap, route.NextMap, route.ParTics, route.DidSecret, route.Finale,
            route.NextName.Low, route.NextName.High, player.Health, player.Armor, player.ArmorType,
            player.Ammo[0], player.KillCount, player.ItemCount, player.SecretCount, player.Cards[0], player.Powers[2],
            player.DamageCount, player.BonusCount, player.FixedColormap, finished.View.ExtraLight,
            finished.Actor.Physics.Body.Flags & play.ActorShadow != 0, after.KillCount, after.ItemCount, after.SecretCount)
    }
}
`;
    const input = path.join(scratch, "campaign.flt"), output = path.join(scratch, "campaign.json");
    writeFileSync(input, source);
    run("dotnet", [cli, "build", input, "--package-root", port, "-o", output]);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    return cases.map((c, i) => {
        for (let host = 0; host < 96 && sim.logs.length <= i; host++) sim.step();
        assert.equal(sim.logs.length, i + 1, nameOf(c));
        const [valid, episode, last, next, par, didSecret, finale, low, high, ...player] = Array.from(sim.logs[i], Number);
        assert.equal(valid, 1);
        if (finale !== 2) assert.deepEqual([low, high], lump(nameOf({...c, mission:next + 1})));
        assert.deepEqual(player.slice(-3), [0, 0, 0], "level setup resets per-map totals");
        return {episode, last, next, par, didSecret, finale, player: player.slice(0, -3)};
    });
}

function native(upstream) {
    const game = readFileSync(path.resolve(root, upstream, "g_game.c"), "utf8").replaceAll("\r\n", "\n");
    const functions = ["G_PlayerFinishLevel", "G_DoCompleted", "G_WorldDone"].map(name => extractFunction(game, "void", name)).join("\n");
    // The original par table has no episode-four row. Pad that undefined read
    // without changing the executable's route or any of the defined rows.
    const pars = game.match(/int pars\[4\]\[10\]\s*=\s*\{[\s\S]+?\};/)[0].replace("pars[4]", "pars[5]");
    const cpars = game.match(/int cpars\[32\]\s*=\s*\{[\s\S]+?\};/)[0];
    const dispatch = cases.map(c => `run(${c.episode}, ${c.mission}, ${+c.commercial}, ${+c.secret}, ${c.prior}, ${+c.didSecret});`).join("\n");
    const input = path.join(scratch, "campaign.c"), exe = path.join(scratch, "campaign.exe");
    writeFileSync(input, `#include <stdint.h>
#include <stdio.h>
#include <string.h>
enum { false, true, MAXPLAYERS=4, commercial=1, MF_SHADOW=0x40000, GS_INTERMISSION=1 };
enum { ga_nothing, ga_victory, ga_worlddone };
typedef struct { unsigned flags; } mobj_t;
typedef struct {
    mobj_t *mo;
    int powers[6], cards[6], extralight, fixedcolormap, damagecount, bonuscount;
    int health, armorpoints, armortype, ammo[4], killcount, itemcount, secretcount, didsecret, frags[4];
} player_t;
typedef struct { int in, skills, sitems, ssecret, stime, frags[4]; } wbplayerstruct_t;
typedef struct {
    int didsecret, epsd, last, next, maxkills, maxitems, maxsecret, maxfrags, partime, pnum;
    wbplayerstruct_t plyr[4];
} wbstartstruct_t;
static player_t players[4];
static int playeringame[4] = {1};
static int gamemode, gameepisode, gamemap, secretexit, consoleplayer, gamestate, gameaction;
static int automapactive, viewactive, totalkills, totalitems, totalsecret, leveltime, finale;
static void *statcopy;
static wbstartstruct_t wminfo;
static void AM_Stop(void) {}
static void WI_Start(wbstartstruct_t *info) { (void)info; }
static void F_StartFinale(void) { finale = gamemap == 30 ? 3 : 1; }
${pars}
${cpars}
${functions}
static void run(int ep, int mission, int mode, int secret, int prior, int didsecret) {
    mobj_t actor = {MF_SHADOW};
    memset(players, 0, sizeof(players));
    memset(&wminfo, 0, sizeof(wminfo));
    players[0] = (player_t){.mo=&actor, .health=64, .armorpoints=57, .armortype=2, .ammo={50}};
    player_t *p = &players[0];
    p->killcount=8; p->itemcount=5; p->secretcount=3; p->cards[0]=1; p->powers[2]=124;
    p->extralight=2; p->fixedcolormap=1; p->damagecount=34; p->bonuscount=9; p->didsecret=didsecret;
    gameepisode=ep; gamemap=mission; gamemode=mode; secretexit=secret; finale=0;
    wminfo.next=prior;
    G_DoCompleted();
    if (gameaction == ga_victory) {
        finale=2;
        wminfo.epsd=ep-1; wminfo.last=mission-1; wminfo.next=0; wminfo.didsecret=didsecret;
    } else { G_WorldDone(); }
    printf("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n",
        wminfo.epsd,wminfo.last,wminfo.next,wminfo.partime,wminfo.didsecret,finale,
        p->health,p->armorpoints,p->armortype,p->ammo[0],p->killcount,p->itemcount,p->secretcount,p->cards[0],p->powers[2],
        p->damagecount,p->bonuscount,p->fixedcolormap,p->extralight,!!(actor.flags&MF_SHADOW));
}
int main(void) { ${dispatch} return 0; }
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => {
        const [episode, last, next, par, didSecret, finale, ...player] = line.split(",").map(Number);
        return {episode, last, next, par, didSecret, finale, player};
    });
}

try {
    const observed = fletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(expected.length, cases.length);
        cases.forEach((c, i) => assert.deepEqual(observed[i], expected[i], nameOf(c) + (c.secret ? " secret" : "")));
        console.log(`Matched ${cases.length} campaign routes and level-finish records against pinned C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "c99bc4e108fcdd60ecb5958062c584b2a4b59347633009b190e800dcfec48300");
        console.log(`Verified ${cases.length} campaign routes and level-finish records against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-campaign-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
