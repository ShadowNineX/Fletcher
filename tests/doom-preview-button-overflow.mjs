// Fill the button list at load, then activate the seventeenth switch through the real preview controller.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root,"examples","doom-engine");
const scratch = mkdtempSync(path.join(os.tmpdir(),"fletcher-preview-button-overflow-"));
const fatal = "P_StartButton: no button slots left!";
const original = "SW1BRCOM", replacement = "SW2BRCOM";
function words(values) {
    const b = Buffer.alloc(2*values.length);
    values.forEach((v,i)=>b.writeUInt16LE(v & 65535,2*i));
    return b;
}
function textureDirectory() {
    const names = ["DUMMY",original,replacement], header = 4+4*names.length;
    const data = Buffer.alloc(header+22*names.length);
    data.writeInt32LE(names.length);
    for(const [i,name] of names.entries()){
        const offset=header+22*i;
        data.writeInt32LE(offset,4+4*i);
        data.write(name,offset,8);
        data.writeInt16LE(1,offset+12);
        data.writeInt16LE(1,offset+14);
    }
    return data;
}
function fixtureWad(special) {
    // Line 0 is 48 units in front of the player. The other sixteen switch
    // lines are behind the spawn, with unique sidedefs and button identities.
    const switches = Array.from({length:17},(_,i)=>[i?6:4,i?7:5,4,i?138:special,9,i,i]);
    const edges = [[0,1],[1,2],[2,3],[3,0]];
    const lines = [...switches,...edges.map(([a,b])=>[a,b,1,0,0,17,-1])];
    const sides = Buffer.alloc(18*30);
    for(let i=0;i<17;++i)sides.write(original,30*i+20,8);
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128,2);
    sector.writeInt16LE(160,20);
    const lumps = [
        ["PNAMES",Buffer.alloc(4)],["TEXTURE1",textureDirectory()],["E1M1",Buffer.alloc(0)],
        ["THINGS",words([0,0,0,1,7])],["LINEDEFS",words(lines.flat())],["SIDEDEFS",sides],
        ["VERTEXES",words([-224,-96,-224,96,224,96,224,-96,48,64,48,-64,-144,64,-144,-64])],
        ["SEGS",words(edges.flatMap(([a,b],i)=>[a,b,[0x4000,0,0xc000,0x8000][i],i+17,0,0]))],
        ["SSECTORS",words([4,0])],["NODES",Buffer.alloc(0)],["SECTORS",sector],["REJECT",Buffer.alloc(1)],
        ["BLOCKMAP",words([-256,-128,4,2,...Array(8).fill(12),0,...lines.keys(),-1])],
    ];
    const directory=12+lumps.reduce((n,[,data])=>n+data.length,0);
    const wad=Buffer.alloc(directory+16*lumps.length);
    wad.write("PWAD");wad.writeUInt32LE(lumps.length,4);wad.writeUInt32LE(directory,8);
    let offset=12;
    for(const [i,[name,data]] of lumps.entries()){
        const at=directory+16*i;
        wad.writeUInt32LE(offset,at);wad.writeUInt32LE(data.length,at+4);wad.write(name,at+8,8);
        data.copy(wad,offset);offset+=data.length;
    }
    return wad;
}
function preview(special) {
    const copy=path.join(scratch,`preview-${special}`), entry=path.join(copy,"main.flt");
    cpSync(path.join(port,"wad-bsp"),copy,{recursive:true});
    let code=readFileSync(entry,"utf8").replaceAll("\r\n","\n");
    function replace(anchor,text){
        assert.equal(code.split(anchor).length,2,"unique fixture anchor "+anchor);
        code=code.replace(anchor,text);
    }
    replace("next doors = play.LoadTimedDoors(level)",`seeded := play.LoadTimedDoors(level)
                                    textures := wad.LoadMountedTextureSet(mounts)
                                    for i := range play.MaxButtons {
                                        line := i + 1
                                        side := level.LineFrontSide(line)
                                        matched := wad.MatchSwitchTexture(level.SideMaterialAt(side), textures, 1)
                                        seeded.Switches = seeded.Switches.ChangeTexture(line, side, matched, true)
                                    }
                                    next doors = seeded
                                    log("seeded-buttons", seeded.Switches.ButtonCount, seeded.Switches.Revision, seeded.Switches.ButtonOverflow)`);
    const timeAnchor="levelTime := currentTick() - startTick - 1";
    replace(timeAnchor,timeAnchor+`
        if doors.Switches.ButtonCount > 0 {
            level := wad.LoadBspLevel(Archive, marker)
            side := doors.Switches.Textures.MaterialAt(level.LineFrontSide(0), wad.SideMaterial{}).Middle
            occupied := 0
            for i := range play.MaxButtons {
                button := doors.Switches.Buttons[i]
                if button.Tics > 0 && button.Line == i + 1 { occupied = occupied + 1 }
            }
            log("button-controller", currentTick(), levelTime, gameTime, player.Body.X, player.Body.Y,
                doors.Switches.ButtonOverflow, doors.Switches.ButtonCount, occupied, doors.Switches.Buttons[0].Tics,
                doors.Switches.Revision, side.Low, side.High, forward, use, fire)
        }`);
    for(const [stage,anchor] of [
        ["weapon","combat = tickPreviewWeapon(base, combat,"],
        ["actors","stepped := tickPreviewWorldActors(combat,"],
        ["dynamic","stepped := tickPreviewDynamicThinkers(combat,"],
        ["timers","used.Doors = used.Doors.TickButtonTimers(base)"],
    ])replace(anchor,`log("button-thinker", currentTick(), "${stage}")\n                    `+anchor);
    writeFileSync(entry,code);
    writeFileSync(path.join(scratch,"LEVEL.WAD"),fixtureWad(special));
    const output=path.join(scratch,"preview.json");
    const result=spawnSync("dotnet",[cli,"build",entry,"--package-root",port,"--asset-root",scratch,"-o",output],
        {cwd:root,encoding:"utf8",timeout:60000});
    if(result.error)throw result.error;
    assert.equal(result.status,0,result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output,"utf8")).data),true);
}
const samples=sim=>sim.logs.filter(([tag])=>tag==="button-controller").map(row=>row.slice(1).map(Number));
function drive(sim,keys,done,message) {
    for(let i=0;i<600 && !done();++i)sim.step([],new Map(),keys);
    assert.ok(done(),message+"; recent logs "+JSON.stringify(sim.logs.slice(-4)));
}
function verify(special, key, local, action, stages) {
    const sim=preview(special);
    drive(sim,[],()=>samples(sim).length>=2,"reach two pre-use gameplay tics");
    const seeded=sim.logs.find(([tag])=>tag==="seeded-buttons");
    assert.deepEqual(Array.from(seeded.slice(1),Number),[16,16,0]);
    assert.ok(sim.logs.some(([tag,,stage])=>tag==="button-thinker" && stage==="actors"),"normal actor thinkers ran before the trigger");
    const initialX=samples(sim).at(-1)[3];
    drive(sim,[23],()=>samples(sim).at(-1)[3]>initialX,"W moves the live player toward the switch");
    drive(sim,[key],()=>sim.logs.some(([tag])=>tag===fatal),`${action} reaches the seventeenth switch`);
    const pressed=samples(sim).findLast(row=>row[local]===1);
    assert.ok(pressed,`${action} sampled on the overflow tic`);
    assert.deepEqual(pressed.slice(5,8),[0,16,16]);
    assert.ok(pressed[8]>10,"existing timers still have time remaining at the seventeenth use");
    const post=()=>samples(sim).filter(row=>row[0]>pressed[0]);
    drive(sim,[23],()=>post().filter(row=>row[12]===1).length>=5,"observe later logical callbacks while W is held");
    assert.equal(sim.logs.filter(([tag])=>tag===fatal).length,1,"fatal diagnostic emitted once");
    const afterTrigger=sim.logs.filter(([tag,tic])=>tag==="button-thinker" && tic>=pressed[0]);
    assert.deepEqual(afterTrigger,stages.map(stage=>["button-thinker",pressed[0],stage]),
        "the trigger ends the current tic before actors, movers and button timers run");
    const name=Buffer.from(replacement);
    for(const row of post()){
        assert.deepEqual(row.slice(1,5),pressed.slice(1,5),"level time, game time and position stay at the failed tic");
        assert.deepEqual(row.slice(5,12),[1,16,16,pressed[8],17,name.readInt32LE(0),name.readInt32LE(4)],
            "existing timers and the seventeenth switch texture survive the fatal use");
    }
    console.log(`Passed ${action} switch overflow: one diagnostic, 16 retained timers, committed SW2 texture and frozen clocks.`);
}

try {
    verify(138,6,13,"F use",[]);
    verify(46,18,14,"R hitscan",["weapon"]);
} finally {
    rmSync(scratch,{recursive:true,force:true});
}
