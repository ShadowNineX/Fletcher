import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "fletcher-doom-status-face-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
function run(command, args) { const r = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 }); if (r.error) throw r.error; assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout; }

function fletcher() {
    const input = path.join(scratch, "status.flt"), output = path.join(scratch, "status.json");
    writeFileSync(input, `package main
import "play"
map "Doom status face" {
 screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
 register face play.StatusFace = play.StatusFace{}
 tick {
  profile := currentTick() / 80
  time := currentTick() % 80
  inventory := play.NewPlayerInventory(100)
  if profile == 1 { inventory.Health = 0 }
  if profile == 2 { inventory.BonusCount = 1; inventory.Weapons[play.WeaponChainsaw] = true }
  if profile == 3 && time > 0 { inventory.DamageCount = 1; inventory.Health = 80 }
  if profile == 4 && time > 0 { inventory.DamageCount = 1; inventory.Health = 80 }
  if profile == 5 { }
  if profile == 6 { inventory.Powers[play.PowerInvulnerability] = 1 }
  if profile == 7 && time > 0 { inventory.DamageCount = 1 }
  if profile == 8 && time > 0 { inventory.DamageCount = 1 }
  held := profile == 5 || profile == 9
  other := profile == 3 || profile == 7 || profile == 8
  heading := bits<32>(0)
  attacker := bits<32>(0)
  if profile == 3 { attacker = bits<32>(0x40000000) }
  if profile == 7 { attacker = bits<32>(0x60000000) }
  if profile == 8 { heading = bits<32>(0xf0000000); attacker = bits<32>(0x10000000) }
  current := face
  if time == 0 || profile == 9 && time == 2 { current = play.StartStatusFace(current, inventory) }
  current = play.TickStatusFace(current, inventory, heading, attacker, other, held, time + profile * 11)
  log(profile, time, current.Index, current.Count, current.OldHealth, current.LastAttackDown, current.PainOffset)
  next face = current
 }
}`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i < 10000 && sim.logs.length < 800; i++) sim.step();
    assert.equal(sim.logs.length, 800); return sim.logs.map(row => Array.from(row, Number));
}

function native(upstream) {
    const source = readFileSync(path.resolve(root, upstream, "st_stuff.c"), "utf8").replaceAll("\r\n", "\n");
    const calc = extractFunction(source, "int", "ST_calcPainOffset");
    const update = extractFunction(source, "void", "ST_updateFaceWidget");
    const file = path.join(scratch, "status.c"), exe = path.join(scratch, "status.exe");
    writeFileSync(file, `#include <stdio.h>
#include <stdint.h>
enum { NUMWEAPONS=9, TICRATE=35, pw_invulnerability=0, CF_GODMODE=2, ST_NUMPAINFACES=5, ST_NUMSTRAIGHTFACES=3, ST_NUMTURNFACES=2, ST_FACESTRIDE=8, ST_TURNOFFSET=3, ST_OUCHOFFSET=5, ST_EVILGRINOFFSET=6, ST_RAMPAGEOFFSET=7, ST_GODFACE=40, ST_DEADFACE=41, ST_EVILGRINCOUNT=70, ST_STRAIGHTFACECOUNT=17, ST_TURNCOUNT=35, ST_RAMPAGEDELAY=70, ST_MUCHPAIN=20 };
#define ANG45 ((angle_t)0x20000000u)
#define ANG180 ((angle_t)0x80000000u)
typedef int boolean; typedef uint32_t angle_t; typedef struct { int x,y; angle_t angle; } mobj_t;
#define true 1
#define false 0
typedef struct { int health,bonuscount,damagecount,attackdown; unsigned cheats; int powers[6]; boolean weaponowned[NUMWEAPONS]; mobj_t *attacker,*mo; } player_t;
static player_t player, *plyr=&player; static mobj_t mo, attacker; static int st_oldhealth=-1, st_facecount, st_faceindex, st_randomnumber; static boolean oldweaponsowned[NUMWEAPONS]; static angle_t forcedAngle;
static angle_t R_PointToAngle2(int x1,int y1,int x2,int y2) { return forcedAngle; }
${calc}
${update}
static void initData(void) { st_faceindex=0; st_oldhealth=-1; for(int i=0;i<NUMWEAPONS;i++) oldweaponsowned[i]=plyr->weaponowned[i]; }
int main(void) { for(int p=0;p<10;p++) for(int t=0;t<80;t++) { player=(player_t){.health=100}; player.weaponowned[0]=player.weaponowned[1]=1; mo.angle=0; player.mo=&mo; player.attacker=0; player.attackdown=p==5||p==9; if(p==1) player.health=0; if(p==2) {player.bonuscount=1;player.weaponowned[7]=1;} if(p==3&&t>0){player.damagecount=1;player.health=80;player.attacker=&attacker;forcedAngle=0x40000000u;} if(p==4&&t>0){player.damagecount=1;player.health=80;} if(p==6)player.powers[0]=1; if(p==7&&t>0){player.damagecount=1;player.attacker=&attacker;forcedAngle=0x60000000u;} if(p==8&&t>0){player.damagecount=1;player.attacker=&attacker;mo.angle=0xf0000000u;forcedAngle=0x10000000u;} if(t==0 || p==9&&t==2) initData(); st_randomnumber=t+p*11; ST_updateFaceWidget(); st_oldhealth=player.health; printf("%d,%d,%d,%d,%d,%d\\n",p,t,st_faceindex,st_facecount,st_oldhealth,0); } }
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", file, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => line.split(",").map(Number));
}

try {
    const rows = fletcher();
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(rows.length, expected.length);
        rows.forEach((row, i) => assert.deepEqual(row.slice(0, 5), expected[i].slice(0, 5), `profile ${row[0]}, tic ${row[1]}`));
        console.log(`Matched ${rows.length} synthetic status-face ticks with pinned st_stuff.c, including priority, unsigned angle, rapid-fire, and restart traces.`);
    } else console.log(`Built ${rows.length} synthetic status-face ticks; pass --upstream artifacts/doom-upstream for the pinned-C differential.`);
} finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
