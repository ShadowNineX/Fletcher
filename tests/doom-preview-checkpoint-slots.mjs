// Exercise the installed classic-profile controller with a local WAD map.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const { values } = parseArgs({ options: { map: { type: "string" } } });
assert.ok(values.map, "Pass --map PATH to a compiled 160×120 classic RGB campaign");
const scene = simulator(decode(JSON.parse(readFileSync(values.map, "utf8")).data), true);
const names = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const keys = { F1: 37, F2: 38, F3: 39, F4: 40, F6: 42, F7: 43, F9: 45, F10: 46,
    Space: 49, Enter: 50, Tab: 51, Alt: 54, Backspace: 55, Down: 57, Left: 58, Right: 59 };
const read = label => scene.logs.filter(row => row[0] === label).map(row => Array.from(row).slice(1));
const menuVoices = Object.entries({ cursor: 71, adjust: 79, back: 87, close: 95, select: 103 })
    .flatMap(([cue, x]) => [x, x - 4].map(bank => ({ x: bank, y: 148, cue, powered: false })));
const menuPulses = [];

function step(key) {
    scene.step([], new Map(), key ? [keys[key] ?? names.indexOf(key)] : []);
    for (const voice of menuVoices) {
        const powered = scene.value(voice) > 0;
        if (powered && !voice.powered) menuPulses.push(voice.cue);
        voice.powered = powered;
    }
}

function advance(count, key) {
    for (let tick = 0; tick < count; tick++) step(key);
}

function tap(key) {
    advance(3, key);
    advance(3);
}

function tapSound(key, expected) {
    const before = menuPulses.length;
    tap(key);
    // The controller can still be presenting the backdrop when the key pulse
    // arrives. Leave time for the next commit and physical sound hop.
    for (let tick = 0; tick < 8 && expected && menuPulses.length === before; tick++) step();
    assert.deepEqual(menuPulses.slice(before), expected ? [expected] : [], `${key} menu sound`);
}

function until(label, count, key, limit = 100) {
    for (let frame = 0; frame < limit; frame++) {
        step(key);
        const logs = read(label);
        if (logs.length >= count) return logs.at(-1);
    }
    assert.fail(`${label} #${count} did not occur. Recent logs: ${JSON.stringify(scene.logs.slice(-10))}`);
}

function screenHash(height = 240, left = 0, top = 0, width = 320) {
    const colors = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        colors[y * width + x] = scene.tileAt({ x: x + left - 160, y: y + top - 120 }).extra;
    return createHash("sha256").update(colors).digest("hex");
}

until("Doom title initialized", 1);
advance(8);
const titleFrame = screenHash();
const titleUpperFrame = screenHash(200);
tapSound("F1", "back");
const creditPage = screenHash(200); // Omit the animated cursor near the bottom.
assert.notEqual(creditPage, titleUpperFrame, "F1 opens a help page over the title");
tapSound("Backspace", "back");
assert.notEqual(screenHash(200), creditPage, "retail F1 jumps to CREDIT, with HELP1 behind it");
tapSound("Enter", "select");
assert.equal(screenHash(200), creditPage, "Enter advances from HELP1 to CREDIT");
tapSound("Tab", "close");
assert.equal(screenHash(), titleFrame, "Tab closes the help panel to the live title");
tapSound("F3", "back");
const emptyLoadMenu = screenHash(50, 72, 30, 180);
tapSound("Enter");
assert.equal(read("Doom checkpoint loaded").length, 0);
assert.equal(screenHash(50, 72, 30, 180), emptyLoadMenu, "selecting an empty row keeps the Load heading visible");
tap("Tab");
tap("T"); tap("Enter"); tap("Enter"); tap("Enter");
until("Doom campaign started", 1);
advance(80);

tap("F9"); tap("Enter");
assert.equal(read("Doom checkpoint loaded").length, 0, "F9 before the first quicksave is harmless");

tap("F6"); tap("3"); tap("Enter");
for (const key of ["F", "T", "Space", "9", "X", "Backspace", "Tab"]) tap(key);
assert.equal(read("Doom checkpoint saved").length, 0, "cancelling the editor makes no checkpoint");
assert.equal(read("Doom mouse enabled").length, 0, "typing 9 in a save name leaves pointer input alone");
tap("Enter");
for (const key of ["F", "T", "Space", "7", "Alt", "Left", "X", "Backspace"]) tap(key);
assert.deepEqual(until("Doom checkpoint saved", 1, "Enter"), [3, "FT 7"]);
const firstFrame = screenHash();
advance(8);
tap("W"); tap("R");
assert.notEqual(screenHash(), firstFrame, "movement and fire create a distinct checkpoint");

tap("F2"); tap("6"); tap("Enter");
for (const key of "SECOND") tap(key);
assert.deepEqual(until("Doom checkpoint saved", 2, "Enter"), [6, "SECOND"]);
const secondFrame = screenHash();
assert.notEqual(secondFrame, firstFrame);
advance(8);

tap("F9"); tap("N");
assert.equal(read("Doom checkpoint loaded").length, 0, "declining quickload leaves the current run alone");
tap("F9");
assert.deepEqual(until("Doom checkpoint loaded", 1, "Y"), [3, "FT 7"]);
assert.equal(screenHash(), firstFrame, "quickload returns to the first-selected slot");
advance(8);

tap("F3"); tap("6");
assert.deepEqual(until("Doom checkpoint loaded", 2, "Enter"), [6, "SECOND"]);
assert.equal(screenHash(), secondFrame, "the later save retained an independent framebuffer");
advance(8);

tap("F6"); tap("N");
assert.equal(read("Doom checkpoint saved").length, 2, "declining quicksave keeps both slots");
tap("F6");
assert.deepEqual(until("Doom checkpoint saved", 3, "Y"), [3, "FT 7"]);
const replacedFrame = screenHash();
advance(8);
tap("F9");
assert.deepEqual(until("Doom checkpoint loaded", 3, "Y"), [3, "FT 7"]);
assert.equal(screenHash(), replacedFrame, "confirmed quicksave replaced the quick slot");
advance(8);

tap("F10");
const quitPrompt = screenHash(54, 100, 90, 120);
tap("Enter");
assert.equal(screenHash(54, 100, 90, 120), quitPrompt, "Enter leaves the Quit prompt waiting for Y or N");
tap("N");
assert.equal(read("Doom returned to title").length, 0, "declining Quit keeps the current run");
assert.notEqual(screenHash(54, 100, 90, 120), quitPrompt);
tap("F10");
until("Doom returned to title", 1, "Y");
advance(75);
assert.equal(screenHash(), titleFrame, "confirmed Quit finishes the title wipe in the host map");
tap("F9");
assert.deepEqual(until("Doom checkpoint loaded", 4, "Y"), [3, "FT 7"]);
assert.equal(screenHash(), replacedFrame, "the in-session quick slot survives the return to title");
advance(8); // Let the Quickload confirmation's close cue finish before F4.

const soundHeading = () => screenHash(26, 56, 40, 208);
const effectsMeter = () => screenHash(22, 76, 85, 60);
const musicMeter = () => screenHash(22, 76, 124, 60);
const openBeforeSound = read("Doom campaign menu opened").length;
const closeBeforeSound = read("Doom campaign menu closed").length;
const bareSoundHeading = soundHeading();
tapSound("F4", "back");
assert.equal(read("Doom campaign menu opened").length, openBeforeSound + 1);
const soundTitle = soundHeading();
assert.notEqual(soundTitle, bareSoundHeading, "F4 draws the Sound Volume panel");
tapSound("Down", "cursor"); // Visit Music so the ordinary Sound menu remembers that cursor.
tapSound("Left", "adjust");
tapSound("Right", "adjust");
tapSound("Backspace", "back");
assert.notEqual(soundHeading(), soundTitle, "Backspace returns from Sound Volume to Options");
tapSound("Enter", "select");
assert.equal(soundHeading(), soundTitle, "Options returns to the same Sound Volume panel");
tapSound("Tab", "close");
assert.equal(read("Doom campaign menu closed").length, closeBeforeSound + 1);
assert.notEqual(soundHeading(), soundTitle, "Tab closes Sound Volume to gameplay");

tap("F4");
const effectsOn = effectsMeter();
const musicOn = musicMeter();
tap("Left");
assert.notEqual(effectsMeter(), effectsOn, "F4 reopens at Sound Effects even when Music was selected last");
assert.equal(musicMeter(), musicOn, "adjusting Sound Effects leaves the music meter alone");
tap("Right");
assert.equal(effectsMeter(), effectsOn, "the Sound Effects adjustment can be reversed");
tap("Tab");

const endGameArea = () => screenHash(54, 32, 86, 256);
const titleReturns = read("Doom returned to title").length;
tap("P"); // Freeze the same level backdrop behind both text overlays.
tap("T"); tap("Down"); tap("Enter"); tap("Enter"); // Main → Options → End Game.
const optionsPrompt = endGameArea();
tap("N");
assert.equal(read("Doom returned to title").length, titleReturns);
assert.notEqual(endGameArea(), optionsPrompt, "N closes the Options End Game prompt");
tapSound("F7", "back");
assert.equal(endGameArea(), optionsPrompt, "F7 opens the same End Game prompt as Options");
tapSound("Enter");
assert.equal(endGameArea(), optionsPrompt, "Enter leaves End Game waiting for Y or N");
tapSound("N", "close");
assert.equal(read("Doom returned to title").length, titleReturns, "declining F7 continues the current game");
tap("F7");
until("Doom returned to title", titleReturns + 1, "Y");
advance(75);
assert.equal(screenHash(), titleFrame, "confirming F7 returns to the title");

const openBeforeAttractF7 = read("Doom campaign menu opened").length;
tap("F7");
assert.equal(read("Doom campaign menu opened").length, openBeforeAttractF7, "F7 does not open on the title");
assert.equal(screenHash(), titleFrame, "title F7 leaves the title frame visible");
until("Doom demo started", read("Doom demo started").length + 1, undefined, 400);
advance(55); // Allow the demo's entrance melt to finish.
tap("F7");
assert.equal(read("Doom campaign menu opened").length, openBeforeAttractF7, "F7 does not open during a demo");
assert.equal(read("Doom returned to title").length, titleReturns + 1);

tap("F9");
assert.deepEqual(until("Doom checkpoint loaded", 5, "Y"), [3, "FT 7"]);
assert.equal(screenHash(), replacedFrame, "F7 preserves the named quick slot");
tap("F3"); tap("6");
assert.deepEqual(until("Doom checkpoint loaded", 6, "Enter"), [6, "SECOND"]);
assert.equal(screenHash(), secondFrame, "F7 preserves other named slots");
advance(8);
tapSound("T", "back");
tapSound("O", "cursor");
tapSound("O", "cursor"); // Options remains selected and the same-row cue is audible.
tapSound("Enter", "select");
tapSound("E", "cursor"); // End Game, without the Fletcher sensitivity alias.
tapSound("G", "cursor"); // Graphic Detail, without changing it.
tapSound("S", "cursor"); // Screen Size.
tapSound("S", "cursor"); // Sound Volume, past the spacer rows.
tapSound("Enter", "select");
tapSound("M", "cursor");
const musicBeforeAdjust = musicMeter();
tapSound("Left", "adjust");
assert.notEqual(musicMeter(), musicBeforeAdjust, "M selects the music slider");
tapSound("Right", "adjust");
tapSound("Tab", "close");

tapSound("T", "back");
tapSound("N", "cursor");
tapSound("Enter", "select");
tapSound("T", "cursor"); // Episode rows own T before Fletcher's Back alias.
tapSound("T", "cursor");
tapSound("Backspace", "back");
tapSound("Tab", "close");
console.log("Classic Help, letter navigation, Quit, Sound Volume, End Game, native menu cue onsets, and exact checkpoint restores passed.");
