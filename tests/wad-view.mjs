import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const { values } = parseArgs({ options: {
    output: { type: "string" }, bspOutput: { type: "string" }, portalOutput: { type: "string" },
    mergedOutput: { type: "string" }, texturedOutput: { type: "string" }, wallOutput: { type: "string" },
    skyOutput: { type: "string" }, walkingOutput: { type: "string" }, spriteOutput: { type: "string" },
    spriteOracle: { type: "string" }, maskedOutput: { type: "string" }, maskedOracle: { type: "string" },
    animatedOutput: { type: "string" }, animationOracle: { type: "string" }, animatedMaterials: { type: "boolean" },
    scrollOutput: { type: "string" }, scrollOracle: { type: "string" }, lightOutput: { type: "string" }, doorOutput: { type: "string" },
    taggedDoorOutput: { type: "string" }, switchOutput: { type: "string" }, taggedLightOutput: { type: "string" },
    stairsOutput: { type: "string" }, donutOutput: { type: "string" },
    floorOutput: { type: "string" }, ceilingOutput: { type: "string" }, platformOutput: { type: "string" },
    cli: { type: "string" }, drawSegmentCapacity: { type: "boolean" }, bspDepth: { type: "boolean" },
    maskedRaster: { type: "boolean" },
    spriteCapacity: { type: "boolean" }, visplaneCapacity: { type: "boolean" }, bspBoundary: { type: "boolean" },
    resourceIndex: { type: "boolean" }, resourceIndexOutput: { type: "string" },
} });
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-wad-view-"));

const empty = Buffer.alloc(0);
const padding = Array.from({ length: 130 }, () => ["PADDING", empty]);

function fixture(invalidIndex = false) {
    const vertices = Buffer.alloc(16);
    for (const [index, value] of [-100, -50, 100, -50, 100, 50, -100, 50].entries()) {
        vertices.writeInt16LE(value, index * 2);
    }
    const lines = Buffer.alloc(5 * 14);
    for (const [i, [a, b]] of [[0, 1], [1, 2], [2, 3], [3, 0], [0, invalidIndex ? 7 : 2]].entries()) {
        lines.writeUInt16LE(a, i * 14);
        lines.writeUInt16LE(b, i * 14 + 2);
        lines.writeUInt16LE(i === 4 ? 4 : 0, i * 14 + 4);
    }
    return encodeWad([
        ...padding,
        ["MAP01", empty], ["THINGS", empty], ["LINEDEFS", lines], ["SIDEDEFS", empty], ["VERTEXES", vertices],
    ]);
}

function planeResources(sky = false, animated = false) {
    const flatA = Buffer.from(Array.from({ length: 4096 }, (_, i) => ((i & 63) * 11 + (i >> 6) * 19) & 255));
    const flatB = Buffer.from(Array.from({ length: 4096 }, (_, i) => ((i & 63) * 23 + (i >> 6) * 5 + 7) & 255));
    const palette = Buffer.alloc(256 * 3);
    const rgb = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [255, 128, 0],
        [255, 255, 0], [0, 255, 0], [0, 0, 255], [128, 0, 128]];
    for (let i = 0; i < 256; i++) palette.set(rgb[i & 7], i * 3);
    const rows = Buffer.from(Array.from({ length: 32 * 256 }, (_, i) => ((i & 255) + (i >> 8) * 3) & 255));
    const flats = animated ? [
        ["TILE_B", flatB], ["NUKAGE1", flatA], ["NUKAGE2", flatA.map(value => value + 1)],
        ["NUKAGE3", flatA.map(value => value + 2)],
    ] : [["TILE_A", flatA], ["TILE_B", flatB]];
    if (sky) flats.push(["F_SKY1", Buffer.alloc(4096)]);
    return [["F_START", empty], ...flats, ["F_END", empty], ["PLAYPAL", palette], ["COLORMAP", rows]];
}

function corridorPlaneResources() {
    // Identical colormap rows isolate geometry from the lights that give the
    // corridor's floors and ceilings separate visplane keys.
    return planeResources().map(([name, data]) => {
        if (name === "COLORMAP") return [name, data.map((_, index) => index & 255)];
        if (name === "TILE_A" || name === "TILE_B") return [name, Buffer.alloc(data.length, name === "TILE_A" ? 2 : 6)];
        return [name, data];
    });
}

function postPatch(color) {
    const width = 8, header = 8 + width * 4, columnSize = 32;
    const patch = Buffer.alloc(header + width * columnSize);
    patch.writeInt16LE(width);
    patch.writeInt16LE(31, 2);
    patch.writeInt16LE(4, 4);
    patch.writeInt16LE(32, 6);
    for (let x = 0; x < width; x++) {
        const start = header + x * columnSize;
        patch.writeUInt32LE(start, 8 + x * 4);
        patch[start + 1] = 8;
        for (let y = 0; y < 8; y++) patch[start + 3 + y] = color(x, y, 0);
        patch[start + 12] = 16;
        patch[start + 13] = 15;
        for (let y = 0; y < 15; y++) patch[start + 15 + y] = color(x, y, 1);
        patch[start + 31] = 255;
    }
    return patch;
}

function spriteResources(color, shaded = false, name = "BAR1A0", frames = []) {
    const sprites = frames.length ? frames : name === "BAR1A0" ? [["BAR1A0", color], ["BAR1B0", color]] : [[name, color]];
    const palette = planeResources().find(([name]) => name === "PLAYPAL");
    const rows = Buffer.from(Array.from({ length: 32 * 256 }, (_, index) => {
        const row = index >> 8;
        return (index + (shaded ? row * 3 + (row >> 3) : 0)) & 255;
    }));
    return [palette, ["COLORMAP", rows], ["S_START", empty], ...sprites.map(([spriteName, spriteColor]) => [spriteName,
        postPatch(spriteColor ?? ((x, y, post) => post === 0 ? x * 3 + y * 5 + 2 : x * 5 + y * 3 + 1))]), ["S_END", empty]];
}

function maskedWallResources(color, overlapping = false) {
    const names = Buffer.alloc(12);
    names.writeInt32LE(1);
    names.write("FCPATCH", 4);
    const textures = Buffer.alloc(12 + 22 + (overlapping ? 42 : 32));
    textures.writeInt32LE(2);
    textures.writeInt32LE(12, 4);
    textures.writeInt32LE(34, 8);
    for (const [offset, name] of [[12, "VOID"], [34, "FENCE"]]) {
        textures.write(name, offset);
        textures.writeInt16LE(8, offset + 12);
        textures.writeInt16LE(31, offset + 14);
    }
    textures.writeInt16LE(overlapping ? 2 : 1, 34 + 20);
    if (overlapping) {
        // The second placement overlaps the first in the right half of FENCE.
        textures.writeInt16LE(4, 34 + 32);
        textures.writeInt16LE(5, 34 + 34);
    }
    return [["PNAMES", names], ["TEXTURE1", textures], ["FCPATCH", postPatch(color)]];
}

function wallTextureResources(sky = false, textureNames = ["VOID", "W_MID", "W_UP", "W_LOW"], heights = {}) {
    const names = sky ? [...textureNames, "SKY2"] : textureNames;
    const patchCount = names.length - 1;
    const patchNames = Buffer.alloc(4 + patchCount * 8);
    patchNames.writeInt32LE(patchCount);
    const header = 4 + names.length * 4;
    const textures = Buffer.alloc(header + 22 + patchCount * 32);
    textures.writeInt32LE(names.length);
    const patches = [];
    let definition = header;
    for (const [index, name] of names.entries()) {
        const width = name === "SKY2" ? 256 : 8;
        textures.writeInt32LE(definition, 4 + index * 4);
        textures.write(name, definition);
        textures.writeInt16LE(width, definition + 12);
        textures.writeInt16LE(heights[name] ?? 128, definition + 14);
        if (index === 0) {
            definition += 22;
        } else {
            textures.writeInt16LE(1, definition + 20);
            textures.writeInt16LE(index - 1, definition + 26);
            definition += 32;
            const patchName = `PATCH${index}`;
            patchNames.write(patchName, 4 + (index - 1) * 8);
            const columnStart = 8 + width * 4;
            const patch = Buffer.alloc(columnStart + width * 133);
            patch.writeInt16LE(width);
            patch.writeInt16LE(128, 2);
            for (let x = 0; x < width; ++x) {
                const offset = columnStart + x * 133;
                patch.writeInt32LE(offset, 8 + x * 4);
                patch[offset + 1] = 128;
                for (let y = 0; y < 128; ++y) patch[offset + 3 + y] = ((x >> 5) + x * 3 + y * 5 + index * 11) & 255;
                patch[offset + 132] = 255;
            }
            patches.push([patchName, patch]);
        }
    }
    return [["PNAMES", patchNames], ["TEXTURE1", textures], ...patches];
}

function bspFixture({
    invalidIndex = false, portals = false, merged = false, textured = false, wallTextures = false, sky = false, heading = 0,
    lightLevel = 160, blockMap = false, spriteView = "", drawSprite = false, spriteX = 48,
    spriteKind = 2035, spriteLump = "BAR1A0", spriteLumps = [],
    spriteThings = [],
    maskedView = false, withMask = false, animated = false, flatFrame = 1, wallFrame = 1,
    scrolling = false, scrollOffset = 0, doorSwitch = "",
    sectorLevels = [], sectorSpecials = [], sectorTags = [], shadeSprites = false,
    sectorFloors = [], sectorFloorNames = [], wallTextureHeights = {},
    doorCeiling = null, doorSpecial = 0, nextDoorSpecial = 0, doorX = 40, doorBackX = 64, doorLineTag = 0,
    reverseFirstPortal = false, clipFarSpriteSector = false,
    walkover = [], bspDepth = 0, planeCorridor = 0,
} = {}) {
    const door = doorCeiling !== null;
    const shape = planeCorridor > 0 ? Array.from({ length: planeCorridor }, (_, i) => {
        const x = 24 + 2 * i;
        return { edge: [x, 512, x, -512], direction: 0xc000, floor: 0, ceiling: 96, light: 160 };
    }) : door ? [
        { edge: [doorX, 160, doorX, -160], direction: 0xc000, floor: 0, ceiling: 128, light: 160 },
        { edge: [doorBackX, 160, doorBackX, -160], direction: 0xc000, floor: 0, ceiling: doorCeiling, light: 144 },
        { edge: [160, 160, 160, -160], direction: 0xc000, floor: 0, ceiling: 128, light: 96 },
    ] : maskedView ? [
        { edge: [24, 12, 24, -12], direction: 0xc000, floor: 24, ceiling: 70, light: 160 },
        { edge: [88, 160, 88, -160], direction: 0xc000, floor: 24, ceiling: 70, light: 160 },
    ] : spriteView ? [
        { edge: [24, 160, 24, -160], direction: 0xc000, floor: 0, ceiling: spriteView === "portal" ? 46 : 96, light: 160 },
        { edge: [88, 160, 88, -160], direction: 0xc000, floor: 24, ceiling: 96, light: 160 },
    ] : merged ? [
        { edge: [128, 160, 128, 11], direction: 0xc000, floor: 0, ceiling: 72, light: lightLevel },
        { edge: [128, 11, 128, -160], direction: 0xc000, floor: 0, ceiling: 72, light: lightLevel },
    ] : portals ? [
        { edge: [64, 160, 64, -160], direction: 0xc000, floor: 0, ceiling: 96, light: 160 },
        { edge: [96, 160, 96, -160], direction: 0xc000, floor: 24, ceiling: 56, light: sky ? 96 : 160 },
        { edge: [128, 160, 128, -160], direction: 0xc000, floor: 0, ceiling: 128, light: 96 },
    ] : [
        { edge: [64, 16, 96, -16], direction: 0xe000, floor: 0, ceiling: 64, light: 160 },
        { edge: [128, 160, 128, -160], direction: 0xc000, floor: 0, ceiling: 80, light: 96 },
    ];
    for (let index = 0; index < bspDepth; index++) {
        const x = 161 + index;
        shape.push({ edge: [x, 160, x, -160], direction: 0xc000, floor: 0, ceiling: 72, light: 96 });
    }
    const actors = drawSprite ? [{ x: spriteX, y: 0, kind: spriteKind, options: 7 }, ...spriteThings] : spriteThings;
    const thing = Buffer.alloc((actors.length + 1) * 10);
    thing.writeUInt16LE(heading, 4);
    thing.writeUInt16LE(1, 6); // Player-one start at (0, 0).
    for (const [index, actor] of actors.entries()) {
        const offset = (index + 1) * 10;
        thing.writeInt16LE(actor.x, offset);
        thing.writeInt16LE(actor.y ?? 0, offset + 2);
        thing.writeUInt16LE(actor.kind, offset + 6);
        thing.writeUInt16LE(actor.options ?? 7, offset + 8);
    }
    const lineCount = shape.length + walkover.length;
    const lines = Buffer.alloc(lineCount * 14);
    const segs = Buffer.alloc(shape.length * 12);
    const leaves = Buffer.alloc((merged ? shape.length - 1 : shape.length) * 4);
    const sides = Buffer.alloc(shape.length * 60);
    const sectors = Buffer.alloc(shape.length * 26);
    const vertices = Buffer.alloc(lineCount * 8);
    for (const [i, { edge, direction, floor, ceiling, light }] of shape.entries()) {
        const twoSided = (door || portals || planeCorridor > 0 || maskedView || spriteView === "portal" || spriteView === "open") &&
            i < shape.length - 1;
        const reversed = twoSided && i === 0 && reverseFirstPortal;
        const line = i * 14;
        lines.writeUInt16LE(i * 2 + (reversed ? 1 : 0), line);
        lines.writeUInt16LE(i * 2 + (reversed ? 0 : 1), line + 2);
        const peg = wallTextures ? (twoSided && i === 0 ? (sky ? 24 : 8) : i === 0 ? 16 : 0) : 0;
        lines.writeUInt16LE((twoSided ? 4 : 0) | peg, line + 4);
        if (i === 0 && scrolling) lines.writeUInt16LE(48, line + 6);
        if (door && i < 2) lines.writeUInt16LE(i === 0 ? doorSpecial : nextDoorSpecial, line + 6);
        if (door && i === 0) lines.writeInt16LE(doorLineTag, line + 8);
        lines.writeUInt16LE(i * 2 + (reversed ? 1 : 0), line + 10);
        lines.writeUInt16LE(twoSided ? i * 2 + (reversed ? 0 : 1) : 0xffff, line + 12);
        const seg = i * 12;
        segs.writeUInt16LE(i * 2, seg);
        segs.writeUInt16LE(invalidIndex && i === 0 ? 19 : i * 2 + 1, seg + 2);
        segs.writeUInt16LE(direction, seg + 4);
        segs.writeUInt16LE(i, seg + 6);
        segs.writeUInt16LE(reversed ? 1 : 0, seg + 8);
        if (!merged || i >= 2) {
            const leaf = merged ? i - 1 : i;
            leaves.writeUInt16LE(1, leaf * 4);
            leaves.writeUInt16LE(i, leaf * 4 + 2);
        }
        sides.writeUInt16LE(merged ? 0 : i, i * 60 + 28);
        if (twoSided) sides.writeUInt16LE(i + 1, i * 60 + 58);
        if (wallTextures) {
            segs.writeInt16LE(5 + 2 * i, seg + 10);
            sides.writeInt16LE(3 - 4 * i + (i === 0 ? scrollOffset : 0), i * 60);
            sides.writeInt16LE(-4 + 3 * i, i * 60 + 2);
            sides.write(doorSwitch && i === 0 ? doorSwitch : "W_UP", i * 60 + 4);
            sides.write("W_LOW", i * 60 + 12);
            if (!twoSided) sides.write(animated ? `SLADRIP${wallFrame}` : "W_MID", i * 60 + 20);
        }
        if (maskedView && withMask && twoSided) sides.write("FENCE", i * 60 + 20);
        sectors.writeInt16LE(sectorFloors[i] ?? floor, i * 26);
        sectors.writeInt16LE(ceiling, i * 26 + 2);
        sectors.write(sectorFloorNames[i] ?? (animated ? `NUKAGE${flatFrame}` : "TILE_A"), i * 26 + 4);
        sectors.write(sky && i < 2 ? "F_SKY1" : "TILE_B", i * 26 + 12);
        sectors.writeInt16LE(sectorLevels[i] ?? light, i * 26 + 20);
        sectors.writeUInt16LE(sectorSpecials[i] ?? 0, i * 26 + 22);
        sectors.writeInt16LE(sectorTags[i] ?? 0, i * 26 + 24);
        for (const [axis, coordinate] of edge.entries()) vertices.writeInt16LE(coordinate, i * 8 + axis * 2);
    }
    // Interaction traces may also use lines that have no rendered seg.
    for (const [i, { x, special, tag, twoSided = true }] of walkover.entries()) {
        const index = shape.length + i;
        const line = index * 14;
        lines.writeUInt16LE(index * 2, line);
        lines.writeUInt16LE(index * 2 + 1, line + 2);
        lines.writeUInt16LE(twoSided ? 4 : 0, line + 4);
        lines.writeUInt16LE(special, line + 6);
        lines.writeInt16LE(tag, line + 8);
        if (!twoSided) lines.writeUInt16LE(0xffff, line + 12);
        for (const [axis, coordinate] of [x, 160, x, -160].entries()) {
            vertices.writeInt16LE(coordinate, index * 8 + axis * 2);
        }
    }
    if (merged) leaves.writeUInt16LE(2, 0);
    const partitions = planeCorridor > 0 ? Array.from({ length: planeCorridor - 1 }, (_, i) => {
        const near = planeCorridor - i - 2, x = 24 + 2 * near;
        return {
            info: [x, 0, 0, 1, 512, -512, x + 2, 22 + 2 * planeCorridor, 512, -512, x, x],
            front: i === 0 ? 0x8000 + near + 1 : i - 1,
            back: 0x8000 + near,
        };
    }) : door ? [
        { info: [doorBackX, 0, 0, 1, 160, -160, 160, 160, 160, -160, doorBackX, doorBackX], front: 0x8002, back: 0x8001 },
        { info: [doorX, 0, 0, 1, 160, -160, doorBackX, 160, 160, -160, doorX, doorX], front: 0, back: 0x8000 },
    ] : spriteView || maskedView ? [
        { info: [36, 0, 0, 1, ...(clipFarSpriteSector ? [16, -16, -88, -88] : [160, -160, 88, 88]),
            160, -160, 24, 24], front: 0x8001, back: 0x8000 },
    ] : merged ? Array.from({ length: bspDepth }, (_, index) => {
        const x = 160 + index;
        return {
            info: [x, 0, 0, 1, 160, -160, x + 1, x + 1, 160, -160, 128, x],
            front: 0x8001 + index,
            back: index === 0 ? 0x8000 : index - 1,
        };
    }) : portals ? [
        { info: [112, 0, 0, 1, 160, -160, 128, 128, 160, -160, 96, 96], front: 0x8002, back: 0x8001 },
        { info: [80, 0, 0, 1, 160, -160, 96, 128, 160, -160, 64, 64], front: 0, back: 0x8000 },
    ] : [
        { info: [112, 0, 0, 1, 160, -160, 128, 128, 16, -16, 64, 96], front: 0x8001, back: 0x8000 },
    ];
    const nodes = Buffer.alloc(partitions.length * 28);
    for (const [i, { info, front, back }] of partitions.entries()) {
        for (const [word, value] of info.entries()) nodes.writeInt16LE(value, i * 28 + word * 2);
        nodes.writeUInt16LE(front, i * 28 + 24);
        nodes.writeUInt16LE(back, i * 28 + 26);
    }
    const spatial = [];
    if (blockMap) {
        const cells = 3 * 4;
        const list = [0, ...Array.from({ length: lineCount }, (_, i) => i), -1];
        const words = [-64, -256, 3, 4, ...Array(cells).fill(4 + cells), ...list];
        const blocks = Buffer.alloc(words.length * 2);
        for (const [i, word] of words.entries()) blocks.writeInt16LE(word, i * 2);
        spatial.push(["REJECT", Buffer.alloc(Math.ceil(shape.length ** 2 / 8))], ["BLOCKMAP", blocks]);
    }
    return encodeWad([
        ["PACK", Buffer.alloc(45_200, 0x5a)], ...padding, [sky ? "MAP12" : "MAP01", empty], ["THINGS", thing],
        ["LINEDEFS", lines], ["SIDEDEFS", sides], ["VERTEXES", vertices], ["SEGS", segs],
        ["SSECTORS", leaves], ["NODES", nodes], ["SECTORS", sectors], ...spatial,
        ...(planeCorridor > 0 ? corridorPlaneResources() : textured || wallTextures ? planeResources(sky, animated) : []),
        ...(wallTextures ? wallTextureResources(sky, animated ? ["VOID", "UNUSED", "SLADRIP1", "SLADRIP2", "SLADRIP3"]
            : doorSwitch ? ["VOID", "W_MID", "W_UP", "W_LOW", "SW1BRCOM", "SW2BRCOM"] : undefined, wallTextureHeights) : []),
        ...(maskedView ? spriteResources(() => 1) : spriteView ? spriteResources(undefined, shadeSprites, spriteLump, spriteLumps) : []),
        ...(withMask ? maskedWallResources(() => 2) : []),
    ]);
}

function encodeWad(lumps) {
    const directoryOffset = 12 + lumps.reduce((bytes, [, content]) => bytes + content.length, 0);
    const wad = Buffer.alloc(directoryOffset + lumps.length * 16);
    wad.write("PWAD");
    wad.writeInt32LE(lumps.length, 4);
    wad.writeInt32LE(directoryOffset, 8);
    let offset = 12;
    for (const [i, [name, content]] of lumps.entries()) {
        const entry = directoryOffset + i * 16;
        wad.writeInt32LE(offset, entry);
        wad.writeInt32LE(content.length, entry + 4);
        wad.write(name, entry + 8);
        content.copy(wad, offset);
        offset += content.length;
    }
    return wad;
}

function buildSource(wad, output, source, simulate = simulator) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad);
    const result = spawnSync("dotnet", [cli, "build", source,
        "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const wrapper = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(wrapper.data, "base64")[2], 1);
    return simulate(decode(wrapper.data));
}

function bspSimulator(tiles) {
    const controller = tiles.find(tile => tile.type === 33 && tile.payload?.toString().startsWith("let __fletcherRun,"));
    assert.ok(controller, "the sliced BSP preview has a split code controller");
    // Observe the controller's committed tick in the simulator. A code tile
    // has no signal destinations, and the saved map retains its original code.
    const monitor = `\nalways(() => world.setSignal(${controller.x}, ${controller.y}, state.fletcherLogicalTick ?? 0));`;
    controller.payload = Buffer.concat([controller.payload, Buffer.from(monitor)]);
    const sim = simulator(tiles);
    sim.stepTic = (keys = [], hostLimit = 32) => {
        const next = sim.value(controller) + 1;
        sim.step([], new Map(), keys);
        let hosts = 1;
        for (; hosts < hostLimit && sim.value(controller) < next; hosts++) sim.step();
        assert.equal(sim.value(controller), next, `one logical BSP tic must commit within ${hostLimit} host ticks`);
        return hosts;
    };
    return sim;
}

let flatPalettePreview;
function build(wad, output, demo = "wad-view") {
    if (demo === "wad-bsp") {
        if (!flatPalettePreview) {
            flatPalettePreview = mkdtempSync(path.join(scratch, "flat-palette-preview-"));
            const sample = path.join(port, demo);
            for (const file of readdirSync(sample).filter(file => file.endsWith(".flt"))) {
                const source = readFileSync(path.join(sample, file), "utf8");
                // The pixel oracles project the WAD palette to the nearest native color.
                const fixture = file === "display.flt" ? source.replace("const ContrastColors = true", "const ContrastColors = false")
                    .replace("const DitherColors = true", "const DitherColors = false") : source;
                writeFileSync(path.join(flatPalettePreview, file), fixture);
            }
        }
        return buildSource(wad, output, path.join(flatPalettePreview, "main.flt"), bspSimulator);
    }
    return buildSource(wad, output, path.join(port, demo, "main.flt"));
}

function waitForBsp(sim, hostLimit = 32) {
    let hosts = 0;
    for (; hosts < hostLimit && sim.logs.length === 0; hosts++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
    return hosts;
}

function frameDigest(sim) {
    return createHash("sha256").update(framePixels(sim)).digest("hex");
}

function framePixels(sim) {
    const pixels = [];
    for (let y = -48; y < 48; y++) {
        for (let x = -64; x < 64; x++) pixels.push(sim.tileAt({ x, y }).extra);
    }
    return Buffer.from(pixels);
}

function verifyLargeBsp() {
    const small = bspFixture({ merged: true });
    function expanded(invalid) {
        const directory = small.readInt32LE(8);
        const count = small.readInt32LE(4);
        const segmentCount = 8192;
        const lumps = [];
        for (let i = 0; i < count; i++) {
            const entry = directory + i * 16;
            const name = small.toString("latin1", entry + 8, entry + 16).replace(/\0.*$/s, "");
            const offset = small.readInt32LE(entry);
            let data = small.subarray(offset, offset + small.readInt32LE(entry + 4));
            if (name === "SEGS") {
                const original = data;
                data = Buffer.alloc(segmentCount * 12);
                original.copy(data);
                for (let segment = original.length / 12; segment < segmentCount; segment++) {
                    original.copy(data, segment * 12, 0, 12); // All added segs are occluded by the first.
                }
                if (invalid) data.writeUInt16LE(0xffff, (segmentCount - 1) * 12);
            } else if (name === "SSECTORS") {
                data = Buffer.from(data);
                data.writeUInt16LE(segmentCount);
            }
            lumps.push([name, data]);
        }
        return encodeWad(lumps);
    }

    const large = build(expanded(false), path.join(scratch, "large-bsp.json"), "wad-bsp");
    for (let i = 0; i < 3; i++) large.step();
    assert.equal(large.tileWrites, 0, "the first slice keeps the whole working frame private");
    assert.deepEqual(large.logs, []);
    for (let i = 0; !large.tileWrites && i < 32; i++) large.step();
    assert.deepEqual(JSON.parse(JSON.stringify(large.logs)), [["Classic WAD BSP frame rendered"]]);
    assert.equal(frameDigest(large), "75884ae1fe5db706c525aeccdc2393eb89ca25a2896cea264a08912e4fa548d6",
        "a large sliced scene matches its visible segments in the pinned small-scene frame");

    const invalid = build(expanded(true), path.join(scratch, "large-invalid-bsp.json"), "wad-bsp");
    for (let i = 0; !invalid.logs.length && i < 32; i++) invalid.step();
    assert.deepEqual(JSON.parse(JSON.stringify(invalid.logs)), [["Invalid classic BSP records"]]);
    assert.equal(invalid.tileWrites, 0, "an invalid record beyond the first bitset word leaves the screen untouched");
}

function classicDepthFixture(depth) {
    assert.ok(depth > 0 && depth < 0x8000, "classic BSP depth fits the unsigned child index");
    const leaves = depth + 1;
    // Reuse one complete opaque wall for every leaf. Unique geometry would hit
    // the classic vertex and SSECTOR indices before the BSP reaches its own
    // 32,767-node boundary, while repeated SEG records remain a valid map.
    const source = bspFixture({ portals: true, wallTextures: true, blockMap: true });
    return editBspLumps(source, (name, original) => {
        if (name === "SEGS") {
            const data = Buffer.alloc(leaves * 12);
            for (let index = 0; index < leaves; index++) original.copy(data, index * 12, 24, 36);
            return data;
        }
        if (name === "SSECTORS") {
            const data = Buffer.alloc(leaves * 4);
            for (let index = 0; index < leaves; index++) {
                data.writeUInt16LE(1, index * 4);
                data.writeUInt16LE(index, index * 4 + 2);
            }
            return data;
        }
        if (name === "NODES") {
            const data = Buffer.alloc(depth * 28);
            const geometry = [160, 0, 0, 1, 160, -160, 161, 161, 160, -160, 128, 160];
            for (let index = 0; index < depth; index++) {
                const offset = index * 28;
                for (const [word, value] of geometry.entries()) data.writeInt16LE(value, offset + word * 2);
                data.writeUInt16LE(0x8000 + index + 1, offset + 24);
                data.writeUInt16LE(index === 0 ? 0x8000 : index - 1, offset + 26);
            }
            return data;
        }
        return original;
    });
}

function verifyDeepBsp(qualifyClassicBoundary = false) {
    const map = { merged: true, blockMap: true };
    const reference = build(bspFixture(map), path.join(scratch, "shallow-bsp.json"), "wad-bsp");
    // The near wall is reached after 260 splits. It covers all columns
    // before the renderer unwinds and tests the deferred far walls.
    const wad = bspFixture({ ...map, bspDepth: 260 });
    const deep = build(wad, path.join(scratch, "deep-bsp.json"), "wad-bsp");
    const reordered = editBspLumps(wad, (name, original) => {
        if (name !== "NODES") return original;
        const data = Buffer.alloc(original.length);
        const root = original.length / 28 - 1;
        const remap = index => index === root ? root : root - index - 1;
        for (let i = 0; i <= root; i++) {
            const offset = remap(i) * 28;
            original.copy(data, offset, i * 28, (i + 1) * 28);
            for (const at of [offset + 24, offset + 26]) {
                const child = data.readUInt16LE(at);
                if (child < 0x8000) data.writeUInt16LE(remap(child), at);
            }
        }
        const firstChildren = [data.readUInt16LE(24), data.readUInt16LE(26)];
        assert.ok(firstChildren.some(child => child > 0 && child < 0x8000), "node zero has a forward child");
        return data;
    });
    const shuffled = build(reordered, path.join(scratch, "reordered-bsp.json"), "wad-bsp");
    waitForBsp(reference, 128);
    waitForBsp(deep, 128);
    waitForBsp(shuffled, 256);
    const initial = framePixels(reference);
    assert.deepEqual(framePixels(deep), initial, "the wall beyond 260 ancestors renders before any deferred wall");
    assert.deepEqual(framePixels(shuffled), initial, "node ordering does not affect the opening");
    for (const sim of [reference, deep, shuffled]) sim.stepTic([23]);
    const moved = framePixels(reference);
    assert.notDeepEqual(moved, initial, "the reference moves on W");
    assert.deepEqual(framePixels(deep), moved, "the deep BSP commits the same movement");
    assert.deepEqual(framePixels(shuffled), moved, "forward child references preserve the first move");

    // All children in this disconnected cycle are in bounds and have one
    // parent. The root reaches only leaves 0 and 1.
    const disconnected = editBspLumps(bspFixture({ ...map, bspDepth: 3 }), (name, original) => {
        if (name !== "NODES") return original;
        const data = Buffer.from(original);
        for (const [i, [front, back]] of [[1, 0x8002], [0, 0x8003], [0x8000, 0x8001]].entries()) {
            data.writeUInt16LE(front, i * 28 + 24);
            data.writeUInt16LE(back, i * 28 + 26);
        }
        return data;
    });
    const cycle = build(disconnected, path.join(scratch, "disconnected-bsp-cycle.json"), "wad-bsp");
    assertInvalidBsp(cycle, 64);
    console.log("WAD view passed rendering and movement through 260 reordered BSP ancestors and rejected a disconnected cycle.");

    if (qualifyClassicBoundary) {
        const boundaryReference = build(classicDepthFixture(1), path.join(scratch, "classic-depth-reference.json"), "wad-bsp");
        const openingHosts = waitForBsp(boundaryReference, 64);
        const opening = framePixels(boundaryReference);
        const boundaryCases = [];
        for (const depth of [8193, 32767]) {
            const simulation = build(classicDepthFixture(depth), path.join(scratch, `classic-depth-${depth}.json`), "wad-bsp");
            const hosts = waitForBsp(simulation, 4096);
            assert.deepEqual(framePixels(simulation), opening, `the wall beyond ${depth} ancestors matches the shallow opening`);
            boundaryCases.push({ depth, simulation, openingHosts: hosts });
        }
        const referenceMoveHosts = boundaryReference.stepTic([23], 64);
        const moved = framePixels(boundaryReference);
        assert.notDeepEqual(moved, opening, "the classic-depth reference moves on W");
        for (const { depth, simulation, openingHosts: hosts } of boundaryCases) {
            const movementHosts = simulation.stepTic([23], 4096);
            assert.deepEqual(framePixels(simulation), moved, `movement commits through ${depth} BSP ancestors`);
            console.log(`Classic BSP depth ${depth} matched full opening and movement frames in ${hosts} opening and ${movementHosts} movement host ticks.`);
        }
        console.log(`Classic BSP depth reference used ${openingHosts} opening and ${referenceMoveHosts} movement host ticks.`);
    }
}

function editBspLumps(wad, edit, additional = []) {
    const directory = wad.readInt32LE(8);
    const lumps = Array.from({ length: wad.readInt32LE(4) }, (_, i) => {
        const entry = directory + i * 16;
        const name = wad.toString("ascii", entry + 8, entry + 16).replace(/\0.*$/, "");
        const offset = wad.readInt32LE(entry);
        const original = wad.subarray(offset, offset + wad.readInt32LE(entry + 4));
        return [name, edit(name, original)];
    });
    return encodeWad([...lumps, ...additional]);
}

function verifyLargeResourceIndex() {
    const wad = bspFixture({ merged: true, textured: true, wallTextures: true, blockMap: true });
    const additional = Array.from({ length: 9000 }, (_, index) => [
        `D${String(index).padStart(7, "0")}`, Buffer.alloc(0),
    ]);
    const expanded = editBspLumps(wad, (name, original) => {
        if (name !== "TEXTURE1") return original;
        const count = original.readInt32LE();
        const extra = 1800, headerGrowth = extra * 4;
        const data = Buffer.alloc(original.length + headerGrowth + extra * 22);
        data.writeInt32LE(count + extra);
        for (let index = 0; index < count; index++) {
            const pos = 4 + index * 4;
            data.writeInt32LE(original.readInt32LE(pos) + headerGrowth, pos);
        }
        const header = 4 + count * 4;
        original.copy(data, header + headerGrowth, header);
        for (let index = 0; index < extra; index++) {
            const record = original.length + headerGrowth + index * 22;
            data.writeInt32LE(record, header + index * 4);
            data.write(`T${String(index).padStart(7, "0")}`, record);
            data.writeInt16LE(8, record + 12);
            data.writeInt16LE(8, record + 14);
        }
        return data;
    }, additional);
    const reference = build(wad, path.join(scratch, "resource-index-small.json"), "wad-bsp");
    const output = path.join(scratch, "resource-index-large.json");
    const large = build(expanded, output, "wad-bsp");
    waitForBsp(reference, 64);
    waitForBsp(large, 32);
    const opening = frameDigest(reference);
    assert.equal(frameDigest(large), opening);
    for (const sim of [reference, large]) sim.stepTic([23]);
    const moved = frameDigest(reference);
    assert.notEqual(moved, opening);
    assert.equal(frameDigest(large), moved);
    if (values.resourceIndexOutput) copyFileSync(output, path.resolve(values.resourceIndexOutput));
    console.log("WAD view preserved the opening and movement pixels with 9,000 extra lumps and 1,800 extra textures.");
}

function assertInvalidBsp(sim, hostLimit) {
    for (let host = 0; host < hostLimit && sim.logs.length === 0; host++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Invalid classic BSP records"]]);
    assert.equal(sim.tileWrites, 0, "invalid geometry leaves the screen unpainted");
}

function verifyClassicSegBoundary() {
    const wad = bspFixture({ merged: true, blockMap: true, bspDepth: 1 });
    const max = 0x7fff, count = 2 * max;
    function buildCase(kind) {
        const packed = editBspLumps(wad, (name, original) => {
            if (name === "SEGS") {
                const data = Buffer.alloc((count + Number(kind === "padded")) * 12);
                for (let i = 0; i < max; i++) original.copy(data, i * 12, 24, 36);
                for (let i = max; i < count; i++) original.copy(data, i * 12, 0, 12);
                original.copy(data, max * 12, 0, 24);
                if (kind === "padded") original.copy(data, count * 12, 24, 36);
                if (kind === "collision") {
                    // Separate the two visible SEGs by one cache rotation.
                    const filler = Buffer.from(original.subarray(24, 36));
                    filler.writeUInt16LE(original.readUInt16LE(26), 0);
                    filler.writeUInt16LE(original.readUInt16LE(24), 2);
                    filler.writeUInt16LE(0x4000, 4);
                    const second = max + 4096;
                    for (let i = max + 1; i < second; i++) filler.copy(data, i * 12);
                    original.copy(data, second * 12, 12, 24);
                }
                if (kind === "bad-last") data.writeUInt16LE(0xffff, (count - 1) * 12);
                return data;
            }
            if (name === "SSECTORS") {
                const data = Buffer.from(original);
                const farCount = kind === "padded" ? max - 1 : max;
                for (const [i, value] of [max, max, farCount, 0].entries()) data.writeUInt16LE(value, i * 2);
                return data;
            }
            return original;
        });
        return build(packed, path.join(scratch, "classic-seg-" + kind + ".json"), "wad-bsp");
    }
    const reference = build(wad, path.join(scratch, "classic-seg-reference.json"), "wad-bsp");
    const boundary = buildCase("boundary");
    const collision = buildCase("collision");
    const padded = buildCase("padded");
    const overlapping = editBspLumps(wad, (name, original) => {
        if (name !== "SSECTORS") return original;
        const data = Buffer.from(original);
        data.writeUInt16LE(2, 4);
        data.writeUInt16LE(1, 6);
        return data;
    });
    const shared = build(overlapping, path.join(scratch, "classic-seg-shared.json"), "wad-bsp");
    waitForBsp(reference, 64);
    // The full validation pass fits while decoding only the walls the viewport visits.
    // Eagerly decoding and caching all 65,534 walls exceeds this fixture's startup window.
    waitForBsp(boundary, 64);
    waitForBsp(collision, 64);
    const initial = frameDigest(reference);
    assert.equal(frameDigest(boundary), initial, "the visible leaf starts at SEG 32767");
    assert.equal(frameDigest(collision), initial, "two visible SEGs can share a cache slot");
    for (const [sim, label] of [[padded, "unused interior and trailing SEGs"], [shared, "overlapping subsector ranges"]]) {
        waitForBsp(sim, 64);
        assert.equal(frameDigest(sim), initial, `${label} preserve the opening frame`);
    }
    for (const sim of [reference, boundary, collision, padded, shared]) sim.stepTic([23], 2400);
    assert.notEqual(frameDigest(reference), initial, "the reference moved");
    assert.equal(frameDigest(boundary), frameDigest(reference), "the first move preserves the full frame at the signed limit");
    assert.equal(frameDigest(collision), frameDigest(reference), "a cache replacement preserves the next frame");
    assert.equal(frameDigest(padded), frameDigest(reference), "a padded SEG lump preserves the next frame");
    assert.equal(frameDigest(shared), frameDigest(reference), "shared SEG references preserve the next frame");
    assertInvalidBsp(buildCase("bad-last"), 64);
    console.log("WAD view matched the signed SEG boundary, 65,535 records with unused entries, and shared subsector ranges. Invalid referenced SEGs were rejected.");
}

function verifyVisplaneCapacity() {
    const sectors = 140;
    function render(name, sectorLevels) {
        const simulation = build(bspFixture({ planeCorridor: sectors, sectorLevels, blockMap: true }),
            path.join(scratch, `visplane-capacity-${name}.json`), "wad-bsp");
        waitForBsp(simulation, 120);
        return simulation;
    }

    const reference = render("uniform", []);
    const expanded = render("split", Array.from({ length: sectors }, (_, index) => 21 + index));
    const initial = framePixels(reference);
    assert.ok(initial.includes(1), "the floor is red");
    assert.ok(initial.includes(2), "the ceiling is blue");
    assert.ok(framePixels(expanded).equals(initial), "280 plane keys render the same opening as two");

    for (let tic = 0; tic < 10; tic++) {
        for (const simulation of [reference, expanded]) simulation.stepTic([23], 120);
    }
    const moved = framePixels(reference);
    assert.ok(!moved.equals(initial), "movement changes the corridor's projected walls");
    assert.ok(framePixels(expanded).equals(moved), "the floor and ceiling retain exact pixels after movement");
}

function verifyDrawSegmentCapacity() {
    const small = bspFixture({ maskedView: true, withMask: true, blockMap: true, drawSprite: true });
    function expanded(maskedRanges) {
        const directory = small.readInt32LE(8);
        const lumps = [];
        for (let i = 0; i < small.readInt32LE(4); i++) {
            const entry = directory + i * 16;
            const name = small.toString("ascii", entry + 8, entry + 16).replace(/\0.*$/, "");
            const offset = small.readInt32LE(entry);
            const original = small.subarray(offset, offset + small.readInt32LE(entry + 4));
            let data = original;
            if (name === "VERTEXES") {
                data = Buffer.from(original);
                data.writeInt16LE(1, 2);
                data.writeInt16LE(-1, 6);
            } else if (name === "SEGS") {
                data = Buffer.alloc((maskedRanges + 1) * 12);
                for (let range = 0; range < maskedRanges; range++) original.copy(data, range * 12, 0, 12);
                original.copy(data, maskedRanges * 12, 12);
            } else if (name === "SSECTORS") {
                data = Buffer.from(original);
                data.writeUInt16LE(maskedRanges, 0);
                data.writeUInt16LE(maskedRanges, 6);
            }
            lumps.push([name, data]);
        }
        return encodeWad(lumps);
    }

    // Each pass through the thin fence contributes a draw segment. Its
    // transparent center leaves the columns open for the next segment.
    const reference = build(expanded(1), path.join(scratch, "draw-segment-reference.json"), "wad-bsp");
    const large = build(expanded(1056), path.join(scratch, "draw-segment-capacity.json"), "wad-bsp");
    waitForBsp(reference, 120);
    waitForBsp(large, 480);
    const initial = framePixels(reference);
    assert.deepEqual(framePixels(large), initial, "the sprite and back wall survive beyond 1024 retained draw segments");
    for (const sim of [reference, large]) sim.stepTic([23], 480);
    const moved = framePixels(reference);
    assert.notDeepEqual(moved, initial, "the movement sample changes the frame");
    assert.deepEqual(framePixels(large), moved, "movement commits through the large masked scene");

    // Exercise the page summaries with real projected geometry. Each group of
    // 32 duplicate fence SEGs occupies one draw-segment page and a distinct
    // horizontal band. The barrels only overlap the center band, so both the
    // silhouette and masked scans can reject the other pages without changing
    // Doom's reverse draw order. Page 32 also crosses into overflow storage.
    const bands = 33;
    const crowded = bspFixture({ maskedView: true, withMask: true, blockMap: true, drawSprite: true, spriteX: 72,
        spriteThings: Array.from({ length: 31 }, () => ({ x: 72, y: 0, kind: 2035 })) });
    function disjointPages(copies, interleaved = false) {
        const segmentCount = bands * copies;
        return editBspLumps(crowded, (name, original) => {
            if (name === "VERTEXES") {
                const data = Buffer.alloc((bands * 2 + 2) * 4);
                for (let band = 0; band < bands; band++) {
                    const firstY = 65 - band * 4;
                    const endY = firstY - 1;
                    const vertex = band * 8;
                    data.writeInt16LE(64, vertex);
                    data.writeInt16LE(firstY, vertex + 2);
                    data.writeInt16LE(64, vertex + 4);
                    data.writeInt16LE(endY, vertex + 6);
                }
                // Preserve the far back wall from the two-segment fixture.
                original.copy(data, bands * 8, 8, 16);
                return data;
            }
            if (name === "LINEDEFS") {
                const data = Buffer.from(original);
                data.writeUInt16LE(bands * 2, 14);
                data.writeUInt16LE(bands * 2 + 1, 16);
                return data;
            }
            if (name === "SEGS") {
                const data = Buffer.alloc((segmentCount + 1) * 12);
                for (let band = 0; band < bands; band++) {
                    for (let copy = 0; copy < copies; copy++) {
                        const index = interleaved ? copy * bands + band : band * copies + copy;
                        const segment = index * 12;
                        original.copy(data, segment, 0, 12);
                        data.writeUInt16LE(band * 2, segment);
                        data.writeUInt16LE(band * 2 + 1, segment + 2);
                    }
                }
                original.copy(data, segmentCount * 12, 12, 24);
                data.writeUInt16LE(bands * 2, segmentCount * 12);
                data.writeUInt16LE(bands * 2 + 1, segmentCount * 12 + 2);
                return data;
            }
            if (name === "SSECTORS") {
                const data = Buffer.from(original);
                data.writeUInt16LE(segmentCount, 0);
                data.writeUInt16LE(segmentCount, 6);
                return data;
            }
            if (name === "SECTORS") {
                const data = Buffer.from(original);
                // Give the masked portal both upper and lower silhouettes.
                data.writeInt16LE(0, 26);
                data.writeInt16LE(96, 28);
                return data;
            }
            return original;
        });
    }

    const disjointReference = build(disjointPages(1), path.join(scratch, "draw-segment-disjoint-reference.json"), "wad-bsp");
    const disjointExpanded = build(disjointPages(32), path.join(scratch, "draw-segment-disjoint-pages.json"), "wad-bsp");
    const disjointInterleaved = build(disjointPages(32, true), path.join(scratch, "draw-segment-interleaved-pages.json"), "wad-bsp");
    waitForBsp(disjointReference, 480);
    const disjointHosts = waitForBsp(disjointExpanded, 1200);
    const interleavedHosts = waitForBsp(disjointInterleaved, 1200);
    const disjointInitial = framePixels(disjointReference);
    const disjointActual = framePixels(disjointExpanded);
    assert.deepEqual(disjointActual, disjointInitial,
        "disjoint draw-segment pages preserve the crowded sprite and masked-wall frame");
    assert.deepEqual(framePixels(disjointInterleaved), disjointInitial,
        "segment ordering does not change horizontally disjoint bands");
    assert.ok(disjointHosts < interleavedHosts,
        `coherent page bounds reduce deterministic render slices (${disjointHosts} < ${interleavedHosts})`);
    for (const sim of [disjointReference, disjointExpanded, disjointInterleaved]) sim.stepTic([23], 1200);
    const disjointMoved = framePixels(disjointReference);
    assert.notDeepEqual(disjointMoved, disjointInitial, "movement changes the disjoint masked scene");
    assert.deepEqual(framePixels(disjointExpanded), disjointMoved,
        "disjoint page pruning preserves the crowded frame after movement");
    assert.deepEqual(framePixels(disjointInterleaved), disjointMoved,
        "interleaved pages preserve the same crowded frame after movement");

    const probe = mkdtempSync(path.join(scratch, "draw-segment-pages-"));
    const source = path.join(probe, "main.flt");
    writeFileSync(source, `package main
import "engine"
import "sprites"
import "walls"

type ProbeMask struct {
    Shade color
    MarkerX int
}

func (mask ProbeMask) DrawMask(first int, end int, drawn [engine.CoverageWords]bits<32>) [engine.CoverageWords]bits<32> {
    if first <= 4 && end > 4 {
        if drawn[0][4] {
            pixel(mask.MarkerX, 1, true, color.Blue)
        } else {
            pixel(4, 0, true, mask.Shade)
            pixel(mask.MarkerX, 0, true, mask.Shade)
            drawn[0] = drawn[0] | 16
        }
    }
    return drawn
}

map "Draw segment pages" {
    screen at (0, 0) size (8, 8) with {style = "solid", hold = true, slice = true}
    tick {
        var coverage engine.ColumnCoverage
        coverage.TrackDrawSegments = true
        for index := range 1026 {
            segment := engine.DrawSegment{Span: engine.ColumnSpan{First: 4, End: 5}}
            if index == 1023 {
                segment.Masked = true
                segment.Mask = ProbeMask{Shade: color.Green, MarkerX: 5}
            } else if index == 1024 {
                segment.Masked = true
                segment.Mask = ProbeMask{Shade: color.Red, MarkerX: 6}
            }
            coverage.DrawSegments = coverage.DrawSegments.Append(segment)
        }
        coverage = engine.CoverSpan(coverage, engine.ColumnSpan{First: 1, End: 2})
        unit := engine.FracUnit
        first, last := engine.Vertex{X: 32 * unit, Y: 16 * unit}, engine.Vertex{X: 32 * unit, Y: -16 * unit}
        camera := engine.Camera{Z: 32 * unit, View: engine.NewViewProjection(8)}
        surface := walls.Surface{Front: engine.SectorHeights{Ceiling: 64 * unit}, Solid: true, Shade: color.Green}
        angle := engine.PointToAngle(0, 0, first.X, first.Y)
        projection := walls.ProjectedWall{Span: engine.ColumnSpan{First: 0, End: 3}, FirstAngle: angle}
        view := walls.WallView{Height: 8}
        coverage = walls.DrawProjectedWall(camera, coverage, first, last, 0xc0000000, surface, view, projection, walls.WadShading{})
        lastStored := coverage.DrawSegments.At(1027)
        log(coverage.DrawSegments.Count, coverage.StoredWallRange, coverage.Failed, lastStored.Span.First, lastStored.Span.End,
            engine.ColumnOpen(coverage, 0), engine.ColumnOpen(coverage, 2))
        projection.Span = engine.ColumnSpan{First: 3, End: 4}
        coverage = walls.DrawProjectedWall(camera, coverage, first, last, 0xc0000000, surface, view, projection, walls.WadShading{})
        log(coverage.DrawSegments.Count, coverage.StoredWallRange, coverage.Failed, engine.ColumnOpen(coverage, 3))
        visible := sprites.AddVisibleSprite(sprites.VisibleSprites{}, sprites.ProjectedSprite{
            Valid: true, Span: engine.ColumnSpan{First: 4, End: 5}, Scale: unit})
        walls.DrawMaskedPass(coverage, visible, 8, walls.WadShading{Valid: true}, 0)
    }
}
`);
    const paged = buildSource(empty, path.join(scratch, "draw-segment-pages.json"), source);
    const columnPixels = x => Array.from({ length: 8 }, (_, y) => paged.tileAt({ x, y }).extra);
    const initialColumns = [0, 2, 3, 5, 6].map(columnPixels);
    for (let i = 0; i < 128 && !paged.logs.length; i++) paged.step();
    assert.deepEqual(JSON.parse(JSON.stringify(paged.logs)), [
        [1028, true, false, 2, 3, false, false], [1029, true, false, false],
    ], "every solid fragment beyond the inline pages paints and occludes its span");
    for (const [index, column] of [0, 2, 3].entries()) {
        assert.notDeepEqual(columnPixels(column), initialColumns[index], "every retained solid range paints");
    }
    const earlier = columnPixels(5)[0], later = columnPixels(6)[0];
    assert.notEqual(earlier, initialColumns[3][0], "the earlier mask paints its marker");
    assert.notEqual(later, initialColumns[4][0], "the later mask paints its marker");
    assert.notEqual(earlier, later, "the mask colors distinguish draw order");
    assert.equal(columnPixels(4)[0], earlier, "the masked pass paints the earlier mask over the later one across pages");
    for (const column of [5, 6]) {
        assert.equal(columnPixels(column)[1], 2, "the final mask pass remembers columns already painted behind the sprite");
    }
}

function verifyMaskRaster() {
    const palette = planeResources().find(([name]) => name === "PLAYPAL");
    const rows = Buffer.from(Array.from({ length: 32 * 256 }, (_, i) => ((i & 255) + (i >> 8) * 3) & 255));
    const textures = maskedWallResources((x, y, post) => post === 0 ? x * 3 + y * 5 + 2 : x * 5 + y * 3 + 1);
    const wad = encodeWad([palette, ["COLORMAP", rows], ...textures]);
    const pinnedFrames = {
        default: "2de260cdbfa3350f879716fc9892e274649b97ebb584df8ad17fc64b62a79bea",
        lower: "e14681ea61df2cee2e11ce06b08a9580ba918d46431bdd48c22051337975e10b",
    };
    const source = path.join(scratch, "raster-check.flt");
    for (const [peg, digest] of Object.entries(pinnedFrames)) {
        writeFileSync(source, `package main
import "engine"
import "wad"
import "walls"
const Archive = readFile("LEVEL.WAD")
map "Masked wall raster" {
    screen at (-64, -48) size (128, 96) with { style = "solid", hold = true }
    tick {
        materials := walls.LoadMaterials(wad.OpenArchive(Archive), wad.LumpName{})
        wall := wad.WallSegment{TwoSided: true, First: engine.Vertex{Y: 65536}, Light: 80,
            Front: engine.SectorHeights{Ceiling: 80 << 16}, Back: engine.SectorHeights{Floor: 16 << 16, Ceiling: 64 << 16}}
        side := wad.SideMaterial{Middle: wad.LumpName{Low: 0x434e4546, High: 0x45}, OffsetV: 3 << 16,
            PegBottom: ${peg === "lower"}}
        tier := walls.ResolveWallMaterials(materials, wall, side, 41 << 16)
        run := walls.WallTextureRun{Bounds: engine.ColumnSpan{First: 58, End: 62}, Width: 128, Height: 96,
            Scale: engine.WallScale{First: 65536, Last: 90112, Step: 8192}}
        for i := range 4 { run.Columns[58 + i] = i }
        var clips [engine.MaxViewWidth]bits<32>
        clips[58] = (36 << 16) | 62
        clips[59] = (31 << 16) | 70
        clips[61] = (46 << 16) | 66
        mask := walls.MaskedWall{Run: run, Tier: tier.Masked, Shade: materials.Shade,
            Light: tier.Light, ExtraLight: tier.ExtraLight, Clips: clips}
        drawn := mask.DrawMask(58, 60, [engine.CoverageWords]bits<32>{})
        complete := mask.DrawMask(58, 62, drawn)
        log(complete[1])
    }
}
`);
        const sim = buildSource(wad, path.join(scratch, `masked-raster-${peg}.json`), source);
        sim.step();
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [[0x3c000000]]);
        assert.equal(frameDigest(sim), digest, `pinned Doom mask raster with ${peg} pegging`);
        if (values.maskedOracle) {
            const swatches = [7, 0, 1, 5, 3, 4, 2, 6];
            const nativeFrame = readFileSync(path.resolve(values.maskedOracle, `masked-native-${peg}.bin`));
            assert.deepEqual(framePixels(sim), nativeFrame.map(i => i === 255 ? 7 : swatches[i & 7]),
                `native Doom mask pixels with ${peg} pegging`);
        }
    }
}

function verifyWideMaskRaster() {
    const palette = planeResources().find(([name]) => name === "PLAYPAL");
    const rows = Buffer.from(Array.from({ length: 32 * 256 }, (_, i) => ((i & 255) + (i >> 8) * 3) & 255));
    const textures = maskedWallResources((x, y, post) => x * 29 + y * 17 + post * 11, true);
    const wad = encodeWad([palette, ["COLORMAP", rows], ...textures]);
    const source = path.join(mkdtempSync(path.join(scratch, "wide-mask-")), "main.flt");
    writeFileSync(source, `package main
import "engine"
import "wad"
import "walls"
const Archive = readFile("LEVEL.WAD")
map "Wide masked wall raster" {
    screen at (-64, -48) size (128, 96) with { style = "solid", hold = true, slice = true }
    tick {
        materials := walls.LoadMaterials(wad.OpenArchive(Archive), wad.LumpName{})
        materials.Shade = materials.Shade.WithDithering()
        materials.Shade.DetailShift, materials.Shade.ScreenX, materials.Shade.ScreenY = 1, 3, 2
        wall := wad.WallSegment{TwoSided: true, First: engine.Vertex{Y: 65536}, Light: 80,
            Front: engine.SectorHeights{Ceiling: 64 << 16}, Back: engine.SectorHeights{Ceiling: 64 << 16}}
        side := wad.SideMaterial{Middle: wad.LumpName{Low: 0x434e4546, High: 0x45}}
        tier := walls.ResolveWallMaterials(materials, wall, side, 48 << 16)
        run := walls.WallTextureRun{Bounds: engine.ColumnSpan{End: 62}, Width: 62, Height: 92,
            Scale: engine.WallScale{First: 3 << 16, Last: 3 << 16}}
        var clips [engine.MaxViewWidth]bits<32>
        for x := range 62 {
            run.Columns[x] = (x >> 2) - 3
            clips[x] = (bits<32>(5 + x % 3) << 16) | bits<32>(82 - x % 5)
        }
        mask := walls.MaskedWall{Run: run, Tier: tier.Masked, Shade: materials.Shade, Light: tier.Light, Clips: clips}
        var drawn [engine.CoverageWords]bits<32>
        for range 12 { drawn = mask.DrawMask(0, 62, [engine.CoverageWords]bits<32>{}) }
        log(drawn[0], drawn[1])
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "wide-mask-raster.json"), source);
    let hosts = 0;
    for (; hosts < 7 && !sim.logs.length; hosts++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [[0xffffffff, 0x3fffffff]],
        "the sliced mask draws both wrapped source types within seven host ticks");
    assert.equal(frameDigest(sim), "61c81fa551f694715c657da861e86e464b8575e69fa1391694db0b53c6aceea1",
        "direct posts and overlapping patches match the pre-optimization frame");
    console.log(`Wide masked wall raster matched the reference frame in ${hosts} host ticks.`);
}

function verifyAnimatedMaterials() {
    const fixture = { merged: true, wallTextures: true, animated: true };
    const expected = new Map();
    for (const [flatFrame, wallFrame] of [[1, 1], [2, 3], [3, 1], [1, 2]]) {
        const map = path.join(scratch, `animation-reference-${flatFrame}-${wallFrame}.json`);
        const sim = build(bspFixture({ ...fixture, flatFrame, wallFrame }), map, "wad-bsp");
        waitForBsp(sim);
        expected.set(`${flatFrame},${wallFrame}`, frameDigest(sim));
    }
    assert.equal(new Set(expected.values()).size, expected.size, "each explicit material pair makes a distinct frame");

    // The upstream oracle uses global bases 100 and 200. The fixture uses
    // bases 1 and 2, yielding the same modulo phase for both three-frame ranges.
    const tics = [0, 1, 7, 8, 9, 15, 16, 24, 32];
    const pinned = [[2, 3], [2, 3], [2, 3], [3, 1], [3, 1], [3, 1], [1, 2], [2, 3], [3, 1]];
    if (values.animationOracle) {
        const native = spawnSync(path.resolve(values.animationOracle), [], { encoding: "utf8", timeout: 5000 });
        assert.equal(native.status, 0, native.error?.message ?? native.stderr);
        const rows = native.stdout.trim().split(/\r?\n/).map(line => {
            const [tic, , flat, , , , texture] = line.split(/\s+/);
            return [Number(tic), Number(flat) - 99, Number(texture) - 199];
        });
        assert.deepEqual(rows, tics.map((tic, index) => [tic, ...pinned[index]]));
    }
    const expectedAt = new Map(tics.map((tic, i) => [tic, expected.get(pinned[i].join(","))]));

    for (const blockMap of [false, true]) {
        const output = path.join(scratch, `animation-${blockMap ? "walking" : "fixed"}.json`);
        const sim = build(bspFixture({ ...fixture, blockMap }), output, "wad-bsp");
        waitForBsp(sim);
        assert.equal(frameDigest(sim), expected.get("1,1"), "level starts with untranslated resources");
        for (let tic = 0; tic <= 32; tic++) {
            const previousWrites = sim.tileWrites;
            sim.stepTic();
            if (expectedAt.has(tic)) assert.equal(frameDigest(sim), expectedAt.get(tic), `animated frame at level tic ${tic}`);
            if (tic % 8 !== 0) assert.equal(sim.tileWrites, previousWrites, `idle camera holds at level tic ${tic}`);
        }
        if (blockMap) {
            const before = frameDigest(sim);
            sim.stepTic([1]); // Turn between animation boundaries.
            assert.notEqual(frameDigest(sim), before, "animated materials coexist with keyboard movement");
        }
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
        if (values.animatedOutput && blockMap) writeFileSync(path.resolve(values.animatedOutput), readFileSync(output));
    }
}

function verifyAnimatedPegging() {
    const textures = wallTextureResources(false, ["VOID", "UNUSED", "SLADRIP1", "SLADRIP2", "SLADRIP3"],
        { SLADRIP1: 30, SLADRIP2: 45, SLADRIP3: 60 });
    const wad = encodeWad([...planeResources(), ...textures]);
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "engine"
import "wad"
import "walls"
const Archive = readFile("LEVEL.WAD")
map "Animated peg heights" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    tick {
        materials := walls.LoadMaterials(wad.OpenArchive(Archive), wad.LumpName{})
        materials.Animations = wad.IndexFrameAnimations(wad.LoadAnimations(materials.Flats, materials.Textures))
        name := wad.LumpName{Low: 0x44414c53, High: 0x31504952}
        side := wad.SideMaterial{Middle: name, Upper: name, Lower: name, PegBottom: true}
        wall := wad.WallSegment{Front: engine.SectorHeights{Ceiling: 80 << 16},
            Back: engine.SectorHeights{Floor: 16 << 16, Ceiling: 64 << 16}}
        opaque := walls.ResolveWallMaterials(materials, wall, side, 41 << 16)
        wall.TwoSided = true
        portal := walls.ResolveWallMaterials(materials, wall, side, 41 << 16)
        log(opaque.Middle.Texture.Height, opaque.Middle.Middle >> 16,
            portal.Upper.Texture.Height, portal.Upper.Middle >> 16,
            portal.Lower.Texture.Height, portal.Lower.Middle >> 16,
            portal.Masked.Texture.Height, portal.Masked.Middle >> 16)
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "animated-peg-heights.json"), source);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [[60, -11, 60, 53, 60, 39, 60, 35]],
        "opaque tiers use the base texture height; the masked tier uses translated height");
}

function verifyLineScrolling() {
    const fixture = { merged: true, wallTextures: true };
    const updateCounts = [0, 1, 2, 7, 8, 9];
    const expected = new Map();
    for (const tic of updateCounts) {
        const map = path.join(scratch, `scroll-reference-${tic}.json`);
        const sim = build(bspFixture({ ...fixture, scrollOffset: tic }), map, "wad-bsp");
        waitForBsp(sim);
        expected.set(tic, frameDigest(sim));
    }
    assert.notEqual(expected.get(0), expected.get(1));
    assert.notEqual(expected.get(1), expected.get(2));
    assert.equal(expected.get(0), expected.get(8), "the eight-column texture wraps around");
    assert.equal(expected.get(1), expected.get(9));

    if (values.scrollOracle) {
        const native = spawnSync(path.resolve(values.scrollOracle), [], { encoding: "utf8", timeout: 5000 });
        assert.equal(native.status, 0, native.error?.message ?? native.stderr);
        const rows = native.stdout.trim().split(/\r?\n/).map(line => line.split(/\s+/).map(Number));
        assert.deepEqual(rows, Array.from({ length: 10 }, (_, tic) => [
            tic, (3 + tic) * 65536, -65536, ((2147450880 + 2 * tic * 65536) | 0),
        ]));
    }

    for (const blockMap of [false, true]) {
        const map = path.join(scratch, `scroll-${blockMap ? "walking" : "fixed"}.json`);
        const sim = build(bspFixture({ ...fixture, scrolling: true, blockMap }), map, "wad-bsp");
        waitForBsp(sim);
        for (let tic = 0; tic <= 9; tic++) {
            if (expected.has(tic)) assert.equal(frameDigest(sim), expected.get(tic), `special 48 after ${tic} game tics`);
            sim.stepTic();
        }
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
        if (values.scrollOutput && blockMap) writeFileSync(path.resolve(values.scrollOutput), readFileSync(map));
    }

    // Extra lines have no SEGs and all scroll the visible first sidedef.
    const scrolls = 65;
    const extra = Array.from({ length: scrolls }, (_, i) => ({ x: 256 + i, special: 48, tag: 0 }));
    const dense = build(bspFixture({ ...fixture, walkover: extra }), path.join(scratch, "scroll-dense.json"), "wad-bsp");
    waitForBsp(dense);
    assert.equal(frameDigest(dense), expected.get(0), "dense scrolls start at the original offset");
    dense.stepTic();
    assert.equal(frameDigest(dense), expected.get(1), "all 65 contributions wrap to the first shifted column");
    dense.roundTripScriptState();
    dense.stepTic();
    assert.equal(frameDigest(dense), expected.get(2), "scroll multiplicities survive a state round trip");
}

function verifySectorLighting() {
    // Both sectors share ceiling height and material. At the strobe's dark
    // level their lighting also matches, which changes the portal plane mark.
    const fixture = { spriteView: "open", wallTextures: true, shadeSprites: true };
    function render(name, options) {
        const map = path.join(scratch, `sector-light-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim };
    }
    const bright = framePixels(render("bright", { drawSprite: true, sectorLevels: [96, 160] }).sim);
    const dark = framePixels(render("dark", { drawSprite: true, sectorLevels: [96, 96] }).sim);
    const brightScene = framePixels(render("bright-scene", { sectorLevels: [96, 160] }).sim);
    const darkScene = framePixels(render("dark-scene", { sectorLevels: [96, 96] }).sim);
    // Compare separate bands of the unobstructed far wall and far floor.
    for (const [first, end, plane] of [[24, 46, "wall"], [64, 88, "floor"]]) {
        assert.notDeepEqual(brightScene.subarray(first * 128, end * 128), darkScene.subarray(first * 128, end * 128),
            `sector lighting changes the ${plane}'s shading`);
    }
    assert.ok(bright.some((color, i) => color !== brightScene[i] && dark[i] !== darkScene[i] && dark[i] !== color),
        "the actor sprite changes shade with its sector");

    for (const blockMap of [false, true]) {
        const { map, sim } = render(blockMap ? "walking-strobe" : "fixed-strobe", {
            drawSprite: true, blockMap, sectorLevels: [96, 160], sectorSpecials: [0, 13],
        });
        assert.deepEqual(framePixels(sim), bright, "startup uses the WAD's original light level");
        for (let tic = 1; tic <= 21; tic++) {
            const previousWrites = sim.tileWrites;
            sim.stepTic();
            const lit = tic >= 16 && tic < 21;
            assert.deepEqual(framePixels(sim), lit ? bright : dark, `synchronized strobe at tic ${tic}`);
            if (tic !== 1 && tic !== 16 && tic !== 21) {
                assert.equal(sim.tileWrites, previousWrites, "hold the frame while light and camera are unchanged");
            }
        }
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
        if (values.lightOutput && blockMap) writeFileSync(path.resolve(values.lightOutput), readFileSync(map));
    }
}

function verifyDoorPreview() {
    const fixture = { wallTextures: true, blockMap: true };
    function render(name, options) {
        const map = path.join(scratch, `door-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim };
    }
    const references = new Map([0, 2, 32, 56, 124].map(doorCeiling => [
        doorCeiling, render(`reference-${doorCeiling}`, { doorCeiling }).sim,
    ]));
    const { map, sim } = render("manual-open", { doorCeiling: 0, doorSpecial: 31 });
    assert.equal(frameDigest(sim), frameDigest(references.get(0)), "startup shows a closed door");
    const expected = new Map([...references].map(([ceiling, reference]) => [ceiling / 2, frameDigest(reference)]));
    assert.ok(new Set(expected.values()).size >= 4, "ceiling heights give distinct visible door positions");
    for (let tic = 1; tic <= 64; tic++) {
        sim.stepTic(tic === 1 ? [6] : []); // F: use.
        if (expected.has(tic)) assert.equal(frameDigest(sim), expected.get(tic), `door ceiling at tic ${tic}`);
    }
    const fullyOpen = frameDigest(sim);
    assert.equal(fullyOpen, expected.get(62));
    const writes = sim.tileWrites;
    sim.stepTic([6]);
    assert.equal(sim.tileWrites, writes, "an open-only door stays open when used again");

    const open = references.get(124), closed = references.get(0);
    for (let tic = 0; tic < 65; tic++) { open.stepTic(); closed.stepTic(); }
    for (let tic = 1; tic <= 40; tic++) {
        for (const walking of [sim, open, closed]) walking.stepTic([23]);
        if (tic % 8 === 0) assert.equal(frameDigest(sim), frameDigest(open), "the moving door and static opening have the same collision");
    }
    assert.notEqual(frameDigest(sim), fullyOpen, "the player advances into the map");
    assert.notEqual(frameDigest(sim), frameDigest(closed), "the closed door blocks the same walk");
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.doorOutput) writeFileSync(path.resolve(values.doorOutput), readFileSync(map));

    const raising = render("manual-raise", { doorCeiling: 0, doorSpecial: 1 }).sim;
    for (const position of [2, 0, 2]) {
        raising.stepTic([6]);
        assert.equal(frameDigest(raising), expected.get(position / 2), "using a raise door reverses its active direction");
    }
}

function verifyDoorInteractions() {
    const wad = bspFixture({ doorCeiling: 0, doorSpecial: 31, nextDoorSpecial: 117, blockMap: true });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "engine"
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
const Unit = engine.FracUnit

map "Doom door interactions" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    tick {
        level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        blocks := wad.LoadBlockMap(level)
        player := play.ActorPhysics{Body: play.MapActor{X: 8 * Unit, Radius: 16 * Unit,
            Height: 56 * Unit, Ceiling: 128 * Unit, Player: true}}
        back := player
        back.Body.X, back.Angle = 50 * Unit, 0x80000000
        backHit := play.FindUseLine(level, blocks, back.Body.X, back.Body.Y, back.Angle)
        ignored := play.UseLevelDoor(level, blocks, play.LevelDoors{}, back)
        log(backHit.Valid, backHit.Found, backHit.Back, ignored.Count)

        doors := play.UseLevelDoor(level, blocks, play.LevelDoors{}, player)
        closed := doors.ApplyTo(level)
        closedHit := play.FindUseLine(closed, blocks, player.Body.X, player.Body.Y, 0)
        log(doors.Count, closed.LineAt(0).Action, closedHit.Valid, closedHit.Found)

        handle := doors.First()
        closing := doors.EntryAt(handle).State
        closing.Ceiling, closing.Mode, closing.Direction = 56 * Unit, play.DoorNormal, -1
        doors = doors.WithState(handle, closing)
        open := doors.ApplyTo(level)
        openHit := play.FindUseLine(open, blocks, player.Body.X, player.Body.Y, 0)
        log(openHit.Valid, openHit.Found, openHit.Index)

        away := play.TickLevelDoors(level, blocks, doors, player.Body)
        touching := player.Body
        touching.X = 30 * Unit
        blocked := play.TickLevelDoors(level, blocks, doors, touching)
        awayDoor := away.Doors.EntryAt(handle).State
        blockedDoor := blocked.Doors.EntryAt(handle).State
        log(away.Valid, away.Changed, awayDoor.Ceiling >> 16, awayDoor.Direction)
        log(blocked.Valid, blocked.Changed, blockedDoor.Ceiling >> 16, blockedDoor.Direction)
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "door-interactions.json"), source);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, true, true, 0], // Front-side use only.
        [1, 0, true, false], // Consumed special, with the ordinary closed line blocking use beyond it.
        [true, true, 1], // The same ray continues through the open portal.
        [true, true, 54, -1], [true, false, 56, 1], // An overlapping player's radius blocks and reverses closure.
    ]);
}

function verifyWalkoverDispatchOrder() {
    // Substep 1 consumes the open trigger at x=8. Substep 2 still touches
    // that line while dispatching the close trigger among neighboring specials.
    const walkover = [{ x: 8, special: 2, tag: 7 }, { x: 23, special: 3, tag: 7 },
        ...Array.from({ length: 7 }, (_, i) => ({ x: 41 + i, special: 48, tag: 0 }))];
    const wad = bspFixture({ doorCeiling: 64, sectorTags: [0, 7, 0], blockMap: true, walkover });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "engine"
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
const Unit = engine.FracUnit

map "Doom movement dispatch order" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    tick {
        level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        blocks := wad.LoadBlockMap(level)
        player := play.ActorPhysics{MomentumX: 30 * Unit, Body: play.MapActor{Radius: 24 * Unit,
            Height: 56 * Unit, Ceiling: 128 * Unit, Player: true}}
        moved := play.MoveHorizontallyWithDoors(level, blocks, player, play.PlayerMoveCommand{}, play.LevelDoors{})
        log(moved.Valid, moved.Actor.Body.X >> 16, moved.CrossingCount,
            moved.Crossings.At(0).Line, moved.Crossings.At(1).Line)
        firstDoor := moved.Doors.EntryAt(moved.Doors.First())
        log(moved.Doors.Count, moved.Doors.UsedCount, firstDoor.Sector, firstDoor.State.Mode,
            moved.Level.LineAt(3).Action, moved.Level.LineAt(4).Action, moved.Level.SectorHeightsAt(1).Ceiling >> 16)
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "walkover-dispatch.json"), source);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [[true, 30, 2, 3, 4], [1, 2, 1, 3, 0, 0, 64]]);
}

function verifyTaggedAndTimedDoors() {
    function render(name, options) {
        const map = path.join(scratch, `door-event-${name}.json`);
        const sim = build(bspFixture({ wallTextures: true, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim };
    }

    const fixture = { doorCeiling: 0, blockMap: true, sectorTags: [0, 7, 0] };
    const { map, sim } = render("tagged", { ...fixture, walkover: [{ x: 16, special: 2, tag: 7 }] });
    const missing = render("missing", { ...fixture, walkover: [{ x: 16, special: 2, tag: 99 }] }).sim;
    const start = frameDigest(sim);
    sim.stepTic([6]); // The trigger responds to walking across it.
    missing.stepTic([6]);
    assert.equal(frameDigest(sim), start);
    for (let i = 0; i < 10; i++) {
        sim.stepTic([23]);
        missing.stepTic([23]);
    }
    for (let i = 0; i < 66; i++) { sim.stepTic(); missing.stepTic(); }
    const open = frameDigest(sim);
    assert.notEqual(open, frameDigest(missing), "the crossed trigger opens the tagged door");
    for (let i = 0; i < 40; i++) {
        sim.stepTic([23]);
        missing.stepTic([23]);
    }
    assert.notEqual(frameDigest(sim), open, "walking advances the camera after the door stops");
    assert.notEqual(frameDigest(sim), frameDigest(missing), "the player gets through the tagged opening");
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.taggedDoorOutput) writeFileSync(path.resolve(values.taggedDoorOutput), readFileSync(map));

    // Sector special 10 closes on the tick following the 1050-tic wait.
    const timer = render("timed-close", { doorCeiling: 64, sectorSpecials: [0, 10] }).sim;
    const nextHeight = render("timed-reference", { doorCeiling: 62 }).sim;
    const initiallyOpen = frameDigest(timer);
    const writes = timer.tileWrites;
    for (let i = 0; i < 1050; i++) timer.stepTic();
    assert.equal(frameDigest(timer), initiallyOpen);
    assert.equal(timer.tileWrites, writes);
    timer.stepTic();
    assert.equal(frameDigest(timer), frameDigest(nextHeight), "timed door advances without camera input");
    assert.notEqual(frameDigest(timer), initiallyOpen);
    assert.deepEqual(JSON.parse(JSON.stringify(timer.logs)), [
        ["Classic WAD BSP frame rendered"],
        ["Doom native player command ready"],
    ]);
}

function verifySwitchFixtures() {
    const base = {
        wallTextures: true, blockMap: true, doorX: 56, doorCeiling: 0,
        doorSwitch: "SW1BRCOM", doorLineTag: 7, sectorTags: [0, 7, 0],
    };
    function render(name, options = {}) {
        const map = path.join(scratch, `switch-${name}.json`);
        const sim = build(bspFixture({ ...base, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    const button = render("button", { doorSpecial: 61 });
    const oneShot = render("one-shot", { doorSpecial: 103 });
    const missingTag = render("missing-tag", { doorSpecial: 61, doorLineTag: 99 });
    const noTexture = render("unmarked-door", { doorSpecial: 103, doorSwitch: "" });
    const plainOpened = render("unmarked-2", { doorCeiling: 2, doorSwitch: "" });
    assert.equal(button.digest, oneShot.digest, "unpressed switches share their authored image");
    assert.equal(button.digest, missingTag.digest);
    missingTag.sim.stepTic([6]);
    assert.equal(frameDigest(missingTag.sim), missingTag.digest, "missing tag leaves the switch and door alone");
    noTexture.sim.stepTic([6]);
    assert.equal(frameDigest(noTexture.sim), plainOpened.digest, "an unmarked switch still opens its tagged door");

    const phases = new Map();
    for (const tic of [1, 34, 35]) {
        const doorCeiling = tic * 2;
        const raised = render(`raised-${tic}`, { doorCeiling }).digest;
        const pressed = render(`pressed-${tic}`, { doorCeiling, doorSwitch: "SW2BRCOM" }).digest;
        assert.notEqual(raised, pressed, `the switch texture is visible at tic ${tic}`);
        phases.set(tic, { raised, pressed });
    }
    for (let tic = 1; tic <= 35; tic++) {
        // Holding use through tic 2 leaves the original thinker and button timer running.
        button.sim.stepTic(tic <= 2 ? [6] : []);
        oneShot.sim.stepTic(tic === 1 ? [6] : []);
        const phase = phases.get(tic);
        if (phase) {
            assert.equal(frameDigest(button.sim), tic < 35 ? phase.pressed : phase.raised, `button texture at tic ${tic}`);
            assert.equal(frameDigest(oneShot.sim), phase.pressed, `one-shot switch texture at tic ${tic}`);
        }
    }
    // Closing a door already at its floor completes without a geometry change.
    const stationary = render("stationary", { doorSpecial: 42 });
    const stationaryPressed = render("stationary-pressed", { doorSwitch: "SW2BRCOM" }).digest;
    assert.notEqual(stationary.digest, stationaryPressed);
    for (let tic = 1; tic <= 35; tic++) {
        stationary.sim.stepTic(tic === 1 ? [6] : []);
        if (tic === 1 || tic === 34 || tic === 35) {
            assert.equal(frameDigest(stationary.sim), tic < 35 ? stationaryPressed : stationary.digest,
                `button redraws without a moving ceiling at tic ${tic}`);
        }
    }
    for (const { sim } of [button, oneShot, missingTag, noTexture, stationary]) {
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
    }
    if (values.switchOutput) writeFileSync(path.resolve(values.switchOutput), readFileSync(button.map));
}

function verifyTaggedLightFixtures() {
    const base = { wallTextures: true, blockMap: true, doorX: 56, doorCeiling: 50,
        sectorLevels: [96, 160, 96], sectorTags: [0, 0, 7] };
    function render(name, options) {
        const map = path.join(scratch, `tagged-light-${name}.json`);
        const sim = build(bspFixture({ ...base, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    const bright = [96, 160, 255];
    const reference = render("reference", { sectorLevels: bright });
    const tagged = render("walkover", { walkover: [{ x: 16, special: 13, tag: 7 }] });
    const missing = render("missing-tag", { walkover: [{ x: 16, special: 13, tag: 99 }] });
    assert.equal(tagged.digest, missing.digest);
    assert.notEqual(tagged.digest, reference.digest);
    let crossed = false;
    let beforeCrossing = 0;
    for (let tic = 1; tic <= 14; tic++) {
        for (const { sim } of [tagged, missing, reference]) sim.stepTic([23]); // W: walk.
        const lit = frameDigest(tagged.sim);
        const dark = frameDigest(missing.sim);
        if (lit !== dark) crossed = true;
        if (crossed) {
            assert.equal(lit, frameDigest(reference.sim), `tagged lighting at the same position on tic ${tic}`);
        } else {
            beforeCrossing++;
        }
    }
    assert.ok(beforeCrossing > 0 && crossed, "lighting changes when the player crosses the trigger");
    if (values.taggedLightOutput) writeFileSync(path.resolve(values.taggedLightOutput), readFileSync(tagged.map));

    const button = render("button", { doorSpecial: 138, doorLineTag: 7, doorSwitch: "SW1BRCOM" });
    const dimButton = render("dim-button", { doorSpecial: 139, doorLineTag: 7, doorSwitch: "SW1BRCOM" });
    const emptyButton = render("empty-button", { doorSpecial: 139, doorLineTag: 99, doorSwitch: "SW1BRCOM" });
    const brightRest = render("bright-rest", { sectorLevels: bright, doorSwitch: "SW1BRCOM" }).digest;
    const brightPressed = render("bright-pressed", { sectorLevels: bright, doorSwitch: "SW2BRCOM" }).digest;
    const emptyPressed = render("empty-pressed", { doorSwitch: "SW2BRCOM" }).digest;
    const dimPressed = render("dim-pressed", { sectorLevels: [96, 160, 35], doorSwitch: "SW2BRCOM" }).digest;
    assert.notEqual(brightPressed, brightRest, "the portal switch is visible");
    assert.notEqual(brightPressed, emptyPressed, "the switch affects both the texture and lighting");
    dimButton.sim.stepTic([6]);
    assert.notEqual(dimPressed, emptyPressed, "the dimmed sector is visible through the portal");
    assert.equal(frameDigest(dimButton.sim), dimPressed, "special 139 sets the tagged brightness to 35");
    for (let tic = 1; tic <= 35; tic++) {
        const keys = tic === 1 ? [6] : []; // F: use.
        const writes = button.sim.tileWrites;
        button.sim.stepTic(keys);
        emptyButton.sim.stepTic(keys);
        if (tic > 1 && tic < 35) assert.equal(button.sim.tileWrites, writes, "count down without repainting the held frame");
        if (tic === 1 || tic === 34 || tic === 35) {
            assert.equal(frameDigest(button.sim), tic === 35 ? brightRest : brightPressed,
                `the button resets while the new light persists at tic ${tic}`);
            assert.equal(frameDigest(emptyButton.sim), tic === 35 ? emptyButton.digest : emptyPressed,
                `a button without matching sectors still changes texture at tic ${tic}`);
        }
    }
    for (const { sim } of [tagged, missing, reference, button, dimButton, emptyButton]) {
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [["Classic WAD BSP frame rendered"]]);
    }
}

function verifyTaggedLightDispatch() {
    const actions = [12, 13, 17, 35, 79, 80, 81, 104, 13];
    const wad = bspFixture({
        doorCeiling: 50, sectorLevels: [96, 160, 128], sectorTags: [0, 7, 0],
        walkover: actions.map((special, index) => ({ x: 4 * (index + 1), special, tag: index === 8 ? 99 : 7 })),
    });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
map "Doom light trigger actions" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register index int = 3
    tick {
        level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        state := play.CrossLevelSpecial(level, play.LevelSpecials{}, index)
        used := state.Doors.ApplyTo(level)
        log(state.Lighting.Lights.LightAt(1, level.SectorLight(1)), state.Lighting.Lights.ThinkerCount,
            state.Lighting.Random.GameplayIndex, used.LineAt(index).Action)
        next index = index + 1
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "tagged-light-dispatch.json"), source);
    for (const _ of actions) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [128, 0, 0, 0], [255, 0, 0, 0], [160, 1, 1, 0], [35, 0, 0, 0],
        [35, 0, 0, 79], [128, 0, 0, 80], [255, 0, 0, 81], [96, 0, 0, 0], [160, 0, 0, 0],
    ]);
}

function verifyMovingFloor() {
    const fixture = { wallTextures: true, blockMap: true, doorX: 56, doorCeiling: 72,
        sectorFloors: [0, 0, 16], sectorTags: [0, 7, 0], doorSwitch: "SW1BRCOM" };
    function render(name, options = {}) {
        const map = path.join(scratch, `floor-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    const floor = render("switch", { doorSpecial: 18, doorLineTag: 7 });
    const missing = render("missing-tag", { doorSpecial: 18, doorLineTag: 99 });
    const frames = new Map([1, 8, 16].map(height => [
        height, render(`height-${height}`, { sectorFloors: [0, height, 16], doorSwitch: "SW2BRCOM" }),
    ]));
    assert.equal(new Set([floor.digest, ...Array.from(frames.values(), frame => frame.digest)]).size, 4,
        "raising the floor has distinct full-frame digests");
    for (let tic = 1; tic <= 18; tic++) {
        const keys = tic === 1 ? [6] : []; // F: use.
        const writes = floor.sim.tileWrites;
        floor.sim.stepTic(keys);
        if (frames.has(tic)) assert.equal(frameDigest(floor.sim), frames.get(tic).digest, `floor height at tic ${tic}`);
        if (tic > 16) assert.equal(floor.sim.tileWrites, writes, "stop repainting when the floor settles");
    }
    const settled = frames.get(16);
    for (let tic = 0; tic < 8; tic++) {
        floor.sim.stepTic([1]); // A: turn and force a fresh draw after retiring the floor.
        settled.sim.stepTic([1]);
    }
    assert.notEqual(frameDigest(floor.sim), settled.digest, "the player sees a new heading");
    assert.equal(frameDigest(floor.sim), frameDigest(settled.sim), "a fresh draw retains the retired height");
    missing.sim.stepTic([6]);
    assert.equal(frameDigest(missing.sim), missing.digest, "a missing tag leaves the floor and switch untouched");
    assert.deepEqual(JSON.parse(JSON.stringify(floor.sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.floorOutput) writeFileSync(path.resolve(values.floorOutput), readFileSync(floor.map));
}

function verifyCeilingSwitch() {
    const fixture = { wallTextures: true, blockMap: true, doorX: 56, doorBackX: 104, doorCeiling: 72,
        sectorFloors: [0, 56, 0], sectorTags: [0, 7, 0], doorSwitch: "SW1BRCOM" };
    function render(name, options = {}) {
        const map = path.join(scratch, `ceiling-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    const ceiling = render("switch", { doorSpecial: 41, doorLineTag: 7 });
    const missing = render("missing", { doorSpecial: 41, doorLineTag: 99 });
    const references = new Map([1, 8, 16].map(tic => [tic, render(`tic-${tic}`, {
        doorCeiling: 72 - tic, doorSwitch: "SW2BRCOM",
    })]));
    assert.equal(new Set([ceiling.digest, ...Array.from(references.values(), frame => frame.digest)]).size, 4,
        "the lowering ceiling is visible");
    for (let tic = 1; tic <= 18; tic++) {
        ceiling.sim.stepTic(tic === 1 ? [6] : []);
        if (references.has(tic)) assert.equal(frameDigest(ceiling.sim), references.get(tic).digest, `ceiling height at tic ${tic}`);
    }
    const settled = references.get(16);
    for (let tic = 0; tic < 8; tic++) {
        ceiling.sim.stepTic([1]); // A: turn and force a fresh draw.
        settled.sim.stepTic([1]);
    }
    assert.notEqual(frameDigest(ceiling.sim), settled.digest, "the player sees a new heading");
    assert.equal(frameDigest(ceiling.sim), frameDigest(settled.sim), "the finished ceiling keeps its height in a fresh draw");
    missing.sim.stepTic([6]);
    assert.equal(frameDigest(missing.sim), missing.digest, "the switch keeps its texture when no ceiling starts");
    assert.deepEqual(JSON.parse(JSON.stringify(ceiling.sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.ceilingOutput) writeFileSync(path.resolve(values.ceilingOutput), readFileSync(ceiling.map));
}

function verifyCeilingTransitions() {
    const wad = bspFixture({
        doorCeiling: 72, doorX: 56, doorBackX: 104, blockMap: true, sectorFloors: [0, 16, 0],
        sectorTags: [0, 7, 0], wallTextures: true, doorSwitch: "SW1BRCOM",
        walkover: [49, 25, 57, 77, 40, 58, 74, 44].map((special, i) => ({ x: i === 0 ? 16 : 72 + i * 4, special, tag: 7 })),
    });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
map "Doom ceiling triggers" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register state play.LevelSpecials = play.LevelSpecials{}
    tick {
        base := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        blocks := wad.LoadBlockMap(base)
        actor := play.ActorPhysics{Body: play.MapActor{Player: true, Height: 56 << 16, Radius: 16 << 16}}
        tic := currentTick()
        frame := state
        if tic == 0 {
            // Retire a door at a different height from the map's SECTORS record.
            // The next ceiling must begin at that retained height.
            frame.Doors.NextMover = 1
            frame.Doors = frame.Doors.Append(play.SectorDoor{Sector: 1,
                State: play.DoorState{Active: true, Direction: 1, Mode: play.DoorOpen,
                    Speed: 8 << 16, Ceiling: 72 << 16, Top: 76 << 16}})
            frame = play.TickLevelMovers(base, blocks, frame, actor.Body).State
            changed := frame.ApplyTo(base)
            log(frame.Doors.Count, changed.SectorHeightsAt(1).Ceiling >> 16)
            fresh := play.UseLevelSpecial(changed, blocks, frame, actor)
            log(fresh.Ceilings.Count, fresh.ApplyTo(base).LineAt(3).Action, fresh.Doors.Switches.Textures.Count)
            mixed := play.CrossLevelSpecial(changed, frame, 7)
            log(mixed.Ceilings.Count, mixed.Ceilings.EntryAt(1).Motion.Top >> 16, mixed.Floors.Count,
                mixed.ApplyTo(base).LineAt(7).Action)
            frame = play.CrossLevelSpecial(changed, frame, 4)
        } else if tic == 2 {
            frame = play.CrossLevelSpecial(frame.ApplyTo(base), frame, 5)
            frame = play.CrossLevelSpecial(frame.ApplyTo(base), frame, 8)
            log(frame.Floors.Count, frame.ApplyTo(base).LineAt(5).Action, frame.ApplyTo(base).LineAt(8).Action)
        } else if tic == 3 {
            frame = play.UseLevelSpecial(frame.ApplyTo(base), blocks, frame, actor)
            log(frame.Ceilings.Count, frame.ApplyTo(base).LineAt(3).Action, frame.Doors.Switches.Textures.Count)
        } else if tic == 4 {
            frame = play.CrossLevelSpecial(frame.ApplyTo(base), frame, 9)
            log(frame.ApplyTo(base).LineAt(9).Action)
            frame = play.CrossLevelSpecial(frame.ApplyTo(base), frame, 6)
        } else if tic == 5 {
            // At this position the player's head touches the original ceiling.
            room := actor.Body
            room.X, room.Z, room.Floor, room.Ceiling = 80 << 16, 16 << 16, 16 << 16, 72 << 16
            oneWay := play.CrossLevelSpecial(base, play.LevelSpecials{}, 10)
            cycle := play.CrossLevelSpecial(base, play.LevelSpecials{}, 4)
            stopped := play.TickLevelMovers(base, blocks, oneWay, room)
            crushing := play.TickLevelMovers(base, blocks, cycle, room)
            log(stopped.Valid, stopped.Changed, stopped.State.Ceilings.EntryAt(1).Motion.Height >> 16,
                stopped.State.Ceilings.EntryAt(1).Motion.Speed, stopped.Player.Ceiling >> 16)
            log(crushing.Valid, crushing.Changed, crushing.State.Ceilings.EntryAt(1).Motion.Height >> 16,
                crushing.State.Ceilings.EntryAt(1).Motion.Speed, crushing.Player.Ceiling >> 16)
        }
        moved := play.TickLevelMovers(base, blocks, frame, actor.Body)
        live := moved.State
        motion := live.Ceilings.EntryAt(1).Motion
        log(moved.Valid, motion.Height >> 16, live.ApplyTo(base).SectorHeightsAt(1).Ceiling >> 16, motion.Mode,
            motion.Speed >> 16, motion.Direction, motion.OldDirection, live.MoverOccupied(1))
        next state = live
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "ceiling-transitions.json"), source);
    for (let tic = 0; tic < 6; tic++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [0, 76], [1, 0, 1], [1, 128, 0, 0], [true, 75, 75, 4, 1, -1, 0, true],
        [true, 74, 74, 4, 1, -1, 0, true],
        [0, 0, 0], [true, 74, 74, 4, 1, 0, -1, true],
        [1, 49, 0], [true, 73, 73, 4, 1, -1, -1, true],
        [74], [true, 72, 72, 4, 1, -1, -1, true],
        [true, false, 72, 8192, 72], [true, true, 71, 8192, 71],
        [true, 71, 71, 4, 1, -1, -1, true],
    ]);
}

function verifyPlatformSwitch() {
    const fixture = { wallTextures: true, blockMap: true, doorX: 56, doorBackX: 104, doorCeiling: 72,
        sectorFloors: [0, 16, 0], sectorTags: [0, 7, 0], doorSwitch: "SW1BRCOM" };
    function render(name, options) {
        const map = path.join(scratch, `platform-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    const platform = render("switch", { doorSpecial: 21, doorLineTag: 7 });
    const references = new Map([0, 8, 12, 16].map(height => [height, render(`height-${height}`, {
        sectorFloors: [0, height, 0], doorSwitch: "SW2BRCOM",
    }).digest]));
    assert.equal(new Set(references.values()).size, 4, "each lift height produces a distinct rendered image");
    const heights = new Map([[1, 12], [2, 8], [4, 0], [5, 0], [110, 0], [112, 8], [114, 16], [116, 16]]);
    for (let tic = 1; tic <= 116; tic++) {
        const writes = platform.sim.tileWrites;
        platform.sim.stepTic(tic === 1 ? [6] : []); // F: use.
        if (heights.has(tic)) assert.equal(frameDigest(platform.sim), references.get(heights.get(tic)), `lift tic ${tic}`);
        if ((tic >= 5 && tic <= 110) || tic > 114) assert.equal(platform.sim.tileWrites, writes, `stationary lift tic ${tic}`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(platform.sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.platformOutput) writeFileSync(path.resolve(values.platformOutput), readFileSync(platform.map));
}

function verifyPlatformTriggers() {
    const wad = bspFixture({
        wallTextures: true, doorSwitch: "SW1BRCOM", blockMap: true, doorCeiling: 72, doorX: 56, doorBackX: 104,
        doorSpecial: 15, doorLineTag: 7, sectorFloors: [0, 16, 32], sectorTags: [0, 7, 0],
        sectorSpecials: [0, 5, 0], sectorFloorNames: ["TILE_B", "TILE_A", "TILE_A"],
        walkover: [53, 89, 87, 58, 47, 24, 46, 22].map((special, i) => ({ x: 120 + i * 4, special, tag: 7 })),
    });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
func sameFlat(a wad.LumpName, b wad.LumpName) bit { return a.Low == b.Low && a.High == b.High }
map "Doom platform triggers" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register state play.LevelSpecials = play.LevelSpecials{}
    tick {
        base := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        blocks := wad.LoadBlockMap(base)
        actor := play.ActorPhysics{Body: play.MapActor{Player: true, Height: 56 << 16, Radius: 16 << 16}}
        tic := currentTick()
        switch tic {
        case 0:
            fresh := play.UseLevelSpecial(base, blocks, play.LevelSpecials{}, actor)
            used := fresh.ApplyTo(base)
            log(fresh.Floors.ActivePlatforms, fresh.Floors.EntryAt(fresh.Floors.First()).Platform.High >> 16,
                sameFlat(used.FloorNameAt(1), base.FloorNameAt(0)), used.SectorSpecial(1), used.LineAt(0).Action, fresh.Doors.Switches.Textures.Count)
            near := play.CrossLevelSpecial(base, play.LevelSpecials{}, 10)
            changed := near.ApplyTo(base)
            log(near.Floors.EntryAt(near.Floors.First()).Platform.High >> 16, sameFlat(changed.FloorNameAt(1), base.FloorNameAt(0)),
                changed.SectorSpecial(1), changed.LineAt(10).Action)
            next state = fresh
        case 1:
            room := actor.Body
            room.X, room.Z, room.Floor, room.Ceiling = 80 << 16, 16 << 16, 16 << 16, 72 << 16
            obstructed := play.TickLevelMovers(base, blocks, state, room)
            lowered := play.TickLevelMovers(base, blocks, obstructed.State, obstructed.Player)
            log(obstructed.Valid, obstructed.Changed, obstructed.State.Floors.EntryAt(obstructed.State.Floors.First()).Platform.Status,
                lowered.Changed, lowered.Player.Floor, lowered.Player.Z)
        case 2:
            cycling := play.CrossLevelSpecial(base, play.LevelSpecials{}, 3)
            running := play.TickLevelMovers(base, blocks, cycling, actor.Body).State
            next state = play.CrossLevelSpecial(running.ApplyTo(base), running, 4)
        case 3:
            stopped := state
            for range 3 { stopped = play.TickLevelMovers(base, blocks, stopped, actor.Body).State }
            stopped = play.CrossLevelSpecial(stopped.ApplyTo(base), stopped, 6)
            stoppedPlatform := stopped.Floors.EntryAt(stopped.Floors.First()).Platform
            log(stopped.Floors.Count, stopped.MoverOccupied(1), stopped.Lighting.Random.GameplayIndex,
                stoppedPlatform.Height >> 16, stoppedPlatform.Status,
                stopped.ApplyTo(base).LineAt(4).Action, stopped.ApplyTo(base).LineAt(6).Action)
            next state = stopped
        case 4:
            resumed := play.CrossLevelSpecial(state.ApplyTo(base), state, 5)
            resumed = play.TickLevelMovers(base, blocks, resumed, actor.Body).State
            busy := play.UseLevelSpecial(resumed.ApplyTo(base), blocks, resumed, actor)
            busyPlatform := busy.Floors.EntryAt(busy.Floors.First()).Platform
            log(busy.Floors.ActivePlatforms, busyPlatform.Height >> 16,
                busyPlatform.Status, busy.Lighting.Random.GameplayIndex,
                busy.ApplyTo(base).LineAt(0).Action, busy.Doors.Switches.Textures.Count)
            next state = busy
        case 5:
            impacts := play.ShootLevelSpecial(state.ApplyTo(base), state, 7, false)
            log(impacts.ApplyTo(base).LineAt(7).Action)
            impacts = play.ShootLevelSpecial(impacts.ApplyTo(base), impacts, 7, true)
            impacts = play.ShootLevelSpecial(impacts.ApplyTo(base), impacts, 8, true)
            impacts = play.ShootLevelSpecial(impacts.ApplyTo(base), impacts, 9, false)
            level := impacts.ApplyTo(base)
            log(impacts.Floors.Count, impacts.Doors.Count, level.LineAt(7).Action, level.LineAt(8).Action, level.LineAt(9).Action)
        case 6:
            next state = play.CrossLevelSpecial(base, play.LevelSpecials{}, 10)
        default:
            complete := play.TickLevelMovers(base, blocks, state, actor.Body).State
            if tic == 40 {
                replaced := play.CrossLevelSpecial(complete.ApplyTo(base), complete, 5)
                log(complete.Floors.ActivePlatforms, complete.MoverOccupied(1),
                    complete.ApplyTo(base).SectorHeightsAt(1).Floor >> 16, replaced.Floors.Count,
                    replaced.Floors.ActivePlatforms, replaced.Lighting.Random.GameplayIndex)
            }
            next state = complete
        }
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "platform-triggers.json"), source);
    for (let tic = 0; tic <= 40; tic++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [1, 40, true, 5, 0, 1],
        [32, true, 0, 0],
        [true, false, 1, true, 16 * 65536 - 32768, 16 * 65536 - 32768],
        [1, true, 1, 17, 3, 89, 0],
        [1, 18, 0, 1, 15, 0],
        [47], [1, 0, 0, 0, 46],
        [0, false, 32, 1, 1, 1],
    ]);
}

function verifyStairSwitch() {
    const fixture = { wallTextures: true, blockMap: true, doorX: 56, doorBackX: 104, doorCeiling: 72,
        sectorTags: [0, 7, 0], doorSwitch: "SW1BRCOM" };
    function render(name, options = {}) {
        const map = path.join(scratch, `stairs-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    const stairs = render("active", { doorSpecial: 127, doorLineTag: 7 });
    const missing = render("missing", { doorSpecial: 127, doorLineTag: 99 });
    const references = new Map([1, 4, 8].map(tic => [tic, render(`tic-${tic}`, {
        sectorFloors: [0, Math.min(tic * 4, 16), tic * 4], doorSwitch: "SW2BRCOM",
    }).digest]));
    assert.equal(new Set([stairs.digest, ...references.values()]).size, 4, "each stair phase is visible");
    for (let tic = 1; tic <= 8; tic++) {
        stairs.sim.stepTic(tic === 1 ? [6] : []);
        if (references.has(tic)) assert.equal(frameDigest(stairs.sim), references.get(tic), `stair heights at tic ${tic}`);
    }
    missing.sim.stepTic([6]);
    assert.equal(frameDigest(missing.sim), missing.digest, "missing stair tag leaves geometry unchanged");
    assert.deepEqual(JSON.parse(JSON.stringify(stairs.sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.stairsOutput) writeFileSync(path.resolve(values.stairsOutput), readFileSync(stairs.map));
}

function verifyDonutSwitch() {
    const fixture = {
        wallTextures: true, blockMap: true, doorX: 56, doorBackX: 104, doorCeiling: 80, reverseFirstPortal: true,
        sectorFloors: [16, 0, 32], sectorFloorNames: ["TILE_B", "TILE_A", "TILE_A"], sectorTags: [0, 0, 7],
        doorSwitch: "SW1BRCOM",
    };
    function render(name, options = {}) {
        const map = path.join(scratch, `donut-${name}.json`);
        const sim = build(bspFixture({ ...fixture, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, sim, digest: frameDigest(sim) };
    }
    // Sector 2's first line leads to ring 1. The ring's first line has
    // the model sector 0 on its back side, as required by EV_DoDonut.
    const donut = render("active", { walkover: [{ x: 16, special: 9, tag: 7 }] });
    const expected = new Map([2, 16, 32, 33].map(tic => {
        const moved = Math.min(16, Math.floor(tic / 2));
        const floorNames = ["TILE_B", tic === 33 ? "TILE_B" : "TILE_A", "TILE_A"];
        return [tic, render(`tic-${tic}`, {
            sectorFloors: [16, moved, 32 - moved], sectorFloorNames: floorNames, doorSwitch: "SW2BRCOM",
        }).digest];
    }));
    assert.equal(new Set(expected.values()).size, 4, "both moving levels and the transferred flat are visible");
    for (let tic = 1; tic <= 33; tic++) {
        donut.sim.stepTic(tic === 1 ? [6] : []);
        if (expected.has(tic)) assert.equal(frameDigest(donut.sim), expected.get(tic), `donut frame at tic ${tic}`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(donut.sim.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.donutOutput) writeFileSync(path.resolve(values.donutOutput), readFileSync(donut.map));
}

function verifyDonutOccupancy() {
    const wad = bspFixture({
        doorCeiling: 80, reverseFirstPortal: true, sectorFloors: [16, 0, 32], sectorTags: [0, 8, 7],
        walkover: [{ x: 16, special: 58, tag: 8 }],
    });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
const Unit = 65536
map "Doom shared donut ring" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register state play.LevelSpecials = play.LevelSpecials{}
    tick {
        base := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        tic := currentTick()
        nextState := state
        if tic == 0 {
            // The ring already has a mover that reaches its endpoint before
            // the donut's two thinkers finish.
            nextState.Doors.NextMover = 1
            nextState.Floors = nextState.Floors.Append(play.SectorFloor{Sector: 1,
                Motion: play.FloorState{Active: true, Destination: Unit, Speed: Unit, Direction: 1, Mode: play.FloorRaise}})
            started := play.StartDonut(nextState.ApplyTo(base), nextState, 7)
            nextState = started.State
            log(started.Started, nextState.Floors.Count, nextState.MoverOccupied(1))
        } else {
            if tic == 3 {
                nextState = play.CrossLevelSpecial(nextState.ApplyTo(base), nextState, 3)
                first := nextState.Floors.First()
                third := nextState.Floors.Following(nextState.Floors.Following(first))
                log(nextState.Floors.Count, nextState.Floors.EntryAt(first).Motion.Mode, nextState.Floors.EntryAt(third).Motion.Mode)
            }
            frame := play.TickLevelMovers(base, wad.BlockMapInfo{}, nextState,
                play.MapActor{Z: 16 * Unit, Floor: 16 * Unit, Height: 56 * Unit, Player: true})
            nextState = frame.State
            view := nextState.ApplyTo(base)
            first := nextState.Floors.First()
            second := nextState.Floors.Following(first)
            log(tic, view.SectorHeightsAt(1).Floor, view.SectorHeightsAt(2).Floor, nextState.MoverOccupied(1),
                nextState.Floors.Count, nextState.Floors.EntryAt(first).Motion.Mode, nextState.Floors.EntryAt(second).Motion.Mode)
        }
        next state = nextState
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "donut-occupancy.json"), source);
    for (let tic = 0; tic < 4; tic++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, 3, true], [1, 1.5 * 65536, 31.5 * 65536, true, 3, 4, 14],
        [2, 1.5 * 65536, 31 * 65536, false, 2, 14, 1],
        [3, 14, 8], [3, 3 * 65536, 30.5 * 65536, true, 3, 14, 1],
    ]);
}

function verifyFloorSurfaces() {
    const wad = bspFixture({
        doorCeiling: 72, wallTextures: true, sectorFloors: [0, 16, 4], sectorTags: [0, 7, 0],
        sectorFloorNames: ["TILE_B", "TILE_A", "TILE_A"], sectorSpecials: [9, 0, 0], wallTextureHeights: { W_LOW: 24 },
        walkover: [37, 59, 30, 2, 17].map((special, i) => ({ x: 8 * (i + 1), special, tag: 7 })),
    });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
map "Doom moving floor surfaces" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register state play.LevelSpecials = play.LevelSpecials{}
    register playerZ int = 16 << 16
    tick {
        level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        tic := currentTick()
        frame := state
        height := playerZ
        if tic == 0 {
            frame = play.CrossLevelSpecial(level, frame, 3)
            occupied := play.CrossLevelSpecial(frame.ApplyTo(level), frame, 6)
            occupied = play.CrossLevelSpecial(occupied.ApplyTo(level), occupied, 7)
            log(occupied.Doors.Count, occupied.Lighting.Lights.ThinkerCount)
        } else if tic == 1 {
            changed := play.CrossLevelSpecial(level, play.LevelSpecials{}, 4)
            view := changed.ApplyTo(level)
            log(view.FloorNameAt(1).High, view.SectorSpecial(1), changed.Floors.EntryAt(changed.Floors.First()).Motion.Destination >> 16)
            texture := play.CrossLevelSpecial(level, play.LevelSpecials{}, 5)
            log(texture.Floors.EntryAt(texture.Floors.First()).Motion.Destination >> 16)
        } else if tic == 18 {
            frame = play.CrossLevelSpecial(frame.ApplyTo(level), frame, 7)
            view := frame.ApplyTo(level)
            log(frame.Lighting.Lights.ThinkerCount, view.FloorNameAt(1).High, view.SectorSpecial(1))
        }
        if tic > 0 {
            moved := play.TickLevelMovers(level, wad.BlockMapInfo{}, frame,
                play.MapActor{X: 52 << 16, Height: 56 << 16, Z: playerZ, Floor: playerZ, Ceiling: 72 << 16, Player: true})
            frame = moved.State
            height = moved.Player.Z
        }
        if tic == 0 || tic == 16 || tic == 17 {
            view := frame.ApplyTo(level)
            log(tic, view.SectorHeightsAt(1).Floor >> 16, view.FloorNameAt(1).High, view.SectorSpecial(1), height >> 16)
        }
        next state = frame
        next playerZ = height
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "floor-surfaces.json"), source);
    for (let tic = 0; tic <= 18; tic++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [0, 0], [0, 16, 0x415f, 0, 16], [0x425f, 9, 40], [40], [16, 0, 0x415f, 0, 0], [17, 0, 0x425f, 9, 0],
        [1, 0x425f, 0],
    ]);
}

function verifySwitchDoorDispatch() {
    // P_UseSpecialLine's once/repeat pairs and the corresponding vldoor_e values.
    const actions = [[29, 63, 0], [50, 42, 2], [103, 61, 3], [111, 114, 5], [112, 115, 6], [113, 116, 7]];
    const specials = actions.flatMap(([once, repeat]) => [once, repeat]);
    const cases = [...specials, 103, 61];
    const wad = bspFixture({
        doorCeiling: 0, doorX: 60, blockMap: true, sectorTags: [0, 7, 0],
        walkover: cases.map((special, index) => ({
            x: 4 * (index + 1), special, tag: index === specials.length ? 99 : 7, twoSided: false,
        })),
    });
    const source = path.join(scratch, "raster-check.flt");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
map "Doom switch door activation" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register index int = 0
    tick {
        level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8) + ${(padding.length + 1) * 16})
        blocks := wad.LoadBlockMap(level)
        player := play.ActorPhysics{Body: play.MapActor{X: (index * 4 + 2) << 16, Player: index < ${cases.length - 1}}}
        doors := play.UseLevelDoor(level, blocks, play.LevelDoors{}, player)
        used := doors.ApplyTo(level)
        firstDoor := doors.EntryAt(doors.First())
        log(doors.Count, firstDoor.Sector, firstDoor.State.Mode, used.LineAt(index + 3).Action, doors.Switches.ButtonCount)
        next index = index + 1
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "door-switch-actions.json"), source);
    for (const _ of cases) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        ...actions.flatMap(([, repeat, mode]) => [[1, 1, mode, 0, 0], [1, 1, mode, repeat, 0]]),
        [0, 0, 0, 103, 0], [0, 0, 0, 61, 0],
    ], "all unlocked switch door actions use the matching tag, even from a one-sided linedef with no switch texture");
}

function verifyActorSprites() {
    function actorFrame(name, options, hostLimit) {
        const simulation = build(bspFixture({ spriteView: "open", drawSprite: true, sectorLevels: [160, 32], ...options }),
            path.join(scratch, `actor-${name}.json`), "wad-bsp");
        waitForBsp(simulation, hostLimit);
        return framePixels(simulation);
    }

    const reference = actorFrame("light-neutral", {});
    const shaded = actorFrame("shaded", { shadeSprites: true });
    const bright = actorFrame("fullbright", { spriteKind: 2013, spriteLump: "SOULA0", shadeSprites: true });
    assert.notDeepEqual(shaded, reference, "a normally lit sprite uses the shaded COLORMAP rows");
    assert.deepEqual(bright, reference, "the actor's fullbright spawn state resolves SOULA0 and uses COLORMAP row zero");

    const decorations = Array.from({ length: 1024 }, () => ({ x: -64, y: 96, kind: 49 }));
    const highHandle = actorFrame("high-handle", {
        drawSprite: false, spriteThings: [...decorations, { x: 48, y: 0, kind: 2035 }],
    }, 160);
    assert.deepEqual(highHandle, reference, "a visible sector headed by actor 1026 retains the same barrel pixels");
}

function verifySpriteCapacity() {
    const target = { x: 48, y: 20, kind: 2035 };
    const crowd = { x: 52, y: -21, kind: 2035 };
    function render(name, spriteThings) {
        const simulation = build(bspFixture({ spriteView: "open", blockMap: true, spriteThings }),
            path.join(scratch, `sprite-capacity-${name}.json`), "wad-bsp");
        waitForBsp(simulation, 480);
        return simulation;
    }

    const background = render("background", [crowd]);
    const reference = render("reference", [target, crowd]);
    // Sector links prepend actors, so the distinct barrel is projected last.
    const expanded = render("expanded", [target, ...Array(256).fill(crowd)]);
    const initial = framePixels(reference);
    assert.ok(!initial.equals(framePixels(background)), "the last projected barrel contributes distinct pixels");
    assert.ok(framePixels(expanded).equals(initial), "the last of 257 projected sprites still paints its pixels");

    for (const simulation of [reference, expanded]) simulation.stepTic([23], 480);
    const moved = framePixels(reference);
    assert.ok(!moved.equals(initial), "the reference moves on W");
    assert.ok(framePixels(expanded).equals(moved), "the crowded scene matches the reference after movement");
}

function verifyPassiveActorAnimation() {
    // P_SpawnMobj consumes gameplay random values for the player and the
    // bonus's lastlook before its randomized spawn tics. P_Random[3] is 220,
    // so S_BON1's six tics become 1 + 220 % 6 == 5. The BON1 cycle is
    // action-free, and its six states use sprite frames A, B, C, D, C, B
    // before repeating. The four synthetic patch colors make that mirror
    // sequence observable without shipping any Doom art.
    const frames = "ABCD".split("").map((letter, index) => [`BON1${letter}0`, () => index + 1]);
    const sim = build(bspFixture({ spriteView: "open", drawSprite: true, spriteKind: 2014, spriteLumps: frames }),
        path.join(scratch, "passive-bonus-animation.json"), "wad-bsp");
    waitForBsp(sim);

    const first = frameDigest(sim);
    const transitionFrame = new Map([[5, "B"], [11, "C"], [17, "D"], [23, "C"], [29, "B"], [35, "A"], [41, "B"]]);
    const frameDigestByName = new Map([["A", first]]);
    let previous = first;
    for (let tic = 1; tic <= 41; tic++) {
        const writes = sim.tileWrites;
        sim.stepTic();
        const frame = frameDigest(sim);
        if (transitionFrame.has(tic)) {
            const name = transitionFrame.get(tic);
            const prior = frameDigestByName.get(name);
            if (prior) assert.equal(frame, prior, `BON1's repeated ${name} frame remains the same patch at ${tic}`);
            else frameDigestByName.set(name, frame);
            assert.notEqual(frame, previous, `BON1 changes visible frame after its pinned tic countdown at ${tic}`);
            assert.ok(sim.tileWrites > writes, `the stationary BON1 transition at ${tic} repaints the held frame`);
        } else {
            assert.equal(frame, previous, `BON1 holds its current frame before the next state tic at ${tic}`);
            assert.equal(sim.tileWrites, writes, `the stationary held BON1 frame at ${tic} avoids a repaint`);
        }
        previous = frame;
    }
}

function verifyPlayerPickup() {
    const common = { spriteView: "open", blockMap: true, spriteLumps: [
        ["BON1A0", () => 1], ["BON1B0", () => 2], ["BON1C0", () => 3], ["BON1D0", () => 4],
    ] };
    const empty = build(bspFixture(common), path.join(scratch, "pickup-empty.json"), "wad-bsp");
    const bonus = build(bspFixture({ ...common, spriteThings: [{ x: 30, y: 0, kind: 2014 }] }),
        path.join(scratch, "pickup-bonus.json"), "wad-bsp");
    for (const simulation of [empty, bonus]) {
        waitForBsp(simulation);
    }
    assert.notDeepEqual(framePixels(bonus), framePixels(empty), "health bonus is visible before collection");
    for (let i = 0; i < 3; i++) {
        empty.stepTic([23]);
        bonus.stepTic([23]);
    }
    assert.deepEqual(framePixels(bonus), framePixels(empty), "walking touches the bonus and removes its sprite");
}

function verifySectorLinkedSprites() {
    // The open portal fixture has two visible subsectors. Put a closer barrel
    // and a farther health bonus on opposite sides of that BSP split, offset
    // across the view so both remain observable.
    const spriteThings = [{ x: 32, y: -24, kind: 2035 }, { x: 48, y: 16, kind: 2014 }];
    const spriteLumps = [
        ["BAR1A0", () => 1], ["BAR1B0", () => 1],
        ["BON1A0", () => 2], ["BON1B0", () => 3], ["BON1C0", () => 4], ["BON1D0", () => 5],
    ];
    function render(name, actors, options = {}) {
        const sim = build(bspFixture({ spriteView: "open", spriteThings: actors, spriteLumps, sectorLevels: [160, 160],
            ...options }), path.join(scratch, `sector-linked-${name}.json`), "wad-bsp");
        waitForBsp(sim);
        return framePixels(sim);
    }

    const background = render("background", []);
    const close = render("close", [spriteThings[0]]);
    const far = render("far", [spriteThings[1]]);
    const forward = render("forward", spriteThings);
    const reverse = render("reverse", spriteThings, { reverseFirstPortal: true });
    const clipped = { clipFarSpriteSector: true };
    const clippedBackground = render("culled-background", [], clipped);
    const clippedSprite = render("culled-sprite", [spriteThings[1]], clipped);
    assert.notDeepEqual(close, background, "the close sector's barrel is visible through the portal");
    assert.notDeepEqual(far, background, "the far sector's bonus is visible through the portal");
    assert.notDeepEqual(forward, background, "sector-linked sprites paint over the portal scene");
    assert.notDeepEqual(forward, close, "the farther sector's sprite contributes alongside the close sprite");
    assert.notDeepEqual(forward, far, "the close sector's sprite contributes alongside the farther sprite");
    assert.deepEqual(reverse, forward, "reversing the portal linedef preserves the composed sprites");
    assert.deepEqual(clippedSprite, clippedBackground, "the far sector's sprite is skipped when its BSP branch is culled");
}

function verifySharedSectorSprites() {
    const wad = bspFixture({ spriteView: "open", drawSprite: true });
    const directory = wad.readUInt32LE(8);
    const count = wad.readUInt32LE(4);
    let marker = -1, sides = -1;
    for (let index = 0; index < count; index++) {
        const entry = directory + index * 16;
        const name = wad.toString("latin1", entry + 8, entry + 16).replace(/\0.*$/s, "");
        if (name === "MAP01") marker = entry;
        if (name === "SIDEDEFS") sides = wad.readUInt32LE(entry);
    }
    assert.ok(marker >= 0 && sides >= 0);
    wad.writeUInt16LE(0, sides + 60 + 28); // Both subsectors' front sides now share sector zero.

    const sample = path.join(port, "wad-bsp");
    const probe = mkdtempSync(path.join(scratch, "shared-sprite-sector-"));
    for (const file of readdirSync(sample).filter(file => file.endsWith(".flt") && file !== "main.flt")) {
        copyFileSync(path.join(sample, file), path.join(probe, file));
    }
    const main = readFileSync(path.join(sample, "main.flt"), "utf8");
    const entry = main.indexOf('map "Original WAD BSP View"');
    assert.ok(entry > 0);
    const source = path.join(probe, "main.flt");
    writeFileSync(source, main.slice(0, entry) + `map "Shared sprite sector" {
    screen at (-64, -48) size (Width, Height) with { style = "solid", hold = true, slice = true }
    tick {
        level := wad.LoadBspLevel(Archive, ${marker})
        actors := play.SpawnMapActors(level, wad.ThingRules{Skill: 2, Commercial: true}, NewPlayerHealth, play.ClearRandom())
        mounts := wad.OpenArchive(Archive)
        actorSprites, _ := cachePreviewSprites(mounts, actors, PreviewSprites{})
        scene := Scene{Level: level, Actors: actors, ActorLinks: play.BuildActorLinks(actors, wad.BlockMapInfo{}),
            ActorSprites: actorSprites, ViewHeight: Height,
            Camera: engine.Camera{Z: 41 * engine.FracUnit, View: engine.NewViewProjection(Width)}}
        near := scene.DrawBspSubsector(0, engine.BspFrame<SpritePass>{})
        far := scene.DrawBspSubsector(1, near)
        log(near.Data.Sprites.Visible.Count, far.Data.Sprites.Visible.Count, far.Coverage.Failed)
    }
}
`);
    const sim = buildSource(wad, path.join(scratch, "shared-sprite-sector.json"), source);
    for (let tick = 0; tick < 8 && sim.logs.length === 0; tick++) sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [[1, 1, false]],
        "two subsectors of the same sector submit its visible actor only once");
}

function verifyViews() {
    verifyActorSprites();
    verifyPassiveActorAnimation();
    verifyPlayerPickup();
    verifySectorLinkedSprites();
    verifySharedSectorSprites();
    verifyLargeBsp();
    verifyAnimatedPegging();
    verifyAnimatedMaterials();
    verifyLineScrolling();
    verifySectorLighting();
    verifyDoorInteractions();
    verifyDoorPreview();
    verifyWalkoverDispatchOrder();
    verifyTaggedAndTimedDoors();
    verifySwitchFixtures();
    verifyTaggedLightFixtures();
    verifyTaggedLightDispatch();
    verifyMovingFloor();
    verifyCeilingSwitch();
    verifyCeilingTransitions();
    verifyPlatformSwitch();
    verifyPlatformTriggers();
    verifyStairSwitch();
    verifyDonutSwitch();
    verifyDonutOccupancy();
    verifyFloorSurfaces();
    verifySwitchDoorDispatch();

    const preview = build(fixture(), path.join(scratch, "preview.json"));
    preview.step();
    assert.equal(preview.tileWrites, 0, "search first directory batch");
    preview.step();
    assert.equal(preview.tileWrites, 0, "find the marker in the second directory batch");
    preview.step();
    assert.deepEqual(JSON.parse(JSON.stringify(preview.logs)), [["Classic WAD wireframe rendered"]]);
    for (const [x, y, color] of [[4, 18, 0], [155, 93, 0], [4, 93, 2], [155, 18, 2], [79, 56, 2], [79, 50, 7]]) {
        assert.equal(preview.tileAt({ x: x - 80, y: y - 56 }).extra, color, `pixel ${x},${y}`);
    }
    const painted = preview.tileWrites;
    preview.step();
    assert.equal(preview.tileWrites, painted);

    const invalid = build(fixture(true), path.join(scratch, "invalid.json"));
    for (let i = 0; i < 4; i++) invalid.step();
    assert.deepEqual(JSON.parse(JSON.stringify(invalid.logs)), [["Invalid LINEDEFS or VERTEXES data"]]);
    assert.equal(invalid.tileWrites, 0, "invalid geometry should leave the frame clear");

    const bspMap = path.join(scratch, "bsp.json");
    const bsp = build(bspFixture(), bspMap, "wad-bsp");
    waitForBsp(bsp);
    for (const [x, y, color] of [[64, 48, 5], [8, 48, 6], [116, 48, 6]]) {
        assert.equal(bsp.tileAt({ x: x - 64, y: y - 48 }).extra, color, `BSP pixel ${x},${y}`);
    }
    assert.equal(frameDigest(bsp), "4426b787e47771ac357734914afd53a2300fe5dbfc12f639d9bb5858bf0b2a4a",
        "the angled wall and clipped plane spans match the pinned C");
    const chunks = decode(JSON.parse(readFileSync(bspMap, "utf8")).data)
        .filter(tile => tile.payload?.toString().startsWith('onStart(() => { globalState["__fletcherFile'));
    assert.equal(chunks.length, 2, "the scene loads binary data across script tile boundaries");

    const walkingMap = path.join(scratch, "walking.json");
    const walk = build(bspFixture({ blockMap: true }), walkingMap, "wad-bsp");
    waitForBsp(walk);
    const walkStart = frameDigest(walk);
    assert.equal(walkStart, frameDigest(bsp), "enabling collision preserves the initial camera");
    walk.stepTic([1]); // A: rotate left one command tic.
    const turned = frameDigest(walk);
    assert.notEqual(turned, walkStart, "keyboard turning repaints the camera");
    const turnWrites = walk.tileWrites;
    walk.stepTic();
    assert.equal(walk.tileWrites, turnWrites, "a stationary camera keeps its frame");
    for (let i = 0; i < 10; i++) walk.stepTic([23]); // W: forward.
    const advanced = frameDigest(walk);
    assert.notEqual(advanced, turned, "the player moves into the original test map");
    walk.stepTic();
    assert.notEqual(frameDigest(walk), advanced, "momentum changes the view after releasing the key");
    assert.deepEqual(JSON.parse(JSON.stringify(walk.logs)), [["Classic WAD BSP frame rendered"]]);
    if (values.walkingOutput) writeFileSync(path.resolve(values.walkingOutput), readFileSync(walkingMap));

    const invalidBsp = build(bspFixture({ invalidIndex: true }), path.join(scratch, "invalid-bsp.json"), "wad-bsp");
    for (let i = 0; i < 3; i++) invalidBsp.step();
    assert.deepEqual(JSON.parse(JSON.stringify(invalidBsp.logs)), [["Invalid classic BSP records"]]);
    assert.equal(invalidBsp.tileWrites, 0);

    const portalMap = path.join(scratch, "portals.json");
    build(bspFixture({ portals: true }), portalMap, "wad-bsp");
    const portalTiles = decode(JSON.parse(readFileSync(portalMap, "utf8")).data);
    const tables = portalTiles.filter(tile => tile.payload?.toString().startsWith('onStart(() => { globalState["__fletcherTable'));
    assert.ok(tables.length >= 3, "the compiler automatically moves renderer tables into generated data tiles");
    assert.ok(portalTiles.some(tile => tile.payload?.toString().startsWith('onStart(() => { globalState["__fletcherCode')),
        "the larger renderer uses automatic code splitting");
    assert.ok(portalTiles.every(tile => !tile.payload || tile.payload.length <= 65_535));
    function verifyPortal(portal) {
        assert.deepEqual(JSON.parse(JSON.stringify(portal.logs)), [["Classic WAD BSP frame rendered"]]);
        // R_RenderSegLoop, R_MakeSpans, and R_MapPlane emit wall tiers and
        // plane samples to a synthetic palette-index framebuffer sink.
        assert.equal(frameDigest(portal), "4994125d82a08e076ab47aed0df3d0604e59f428096b95847fe98132dc620ce7",
            "all 12,288 portal pixels match the pinned C");
    }
    for (const order of [portalTiles, [...portalTiles].reverse()]) {
        const portal = simulator(order);
        waitForBsp(portal);
        verifyPortal(portal);
    }
    const delayed = tables[0];
    const late = simulator([...portalTiles.filter(tile => tile !== delayed), {
        ...delayed,
        payload: Buffer.from(delayed.payload.toString().replace("onStart(() => { ", "always(() => { if (world.getTick() === 2) ")),
    }]);
    for (let i = 0; i < 3; i++) late.step();
    assert.equal(late.tileWrites, 0);
    assert.deepEqual(late.logs, []);
    waitForBsp(late);
    verifyPortal(late);

    const mergedMap = path.join(scratch, "merged.json");
    const merged = build(bspFixture({ merged: true }), mergedMap, "wad-bsp");
    waitForBsp(merged);
    // The pinned R_FindPlane/R_CheckPlane coalesce both adjacent wall
    // segments. Keeping each segment's spans separate changes the samples.
    assert.equal(frameDigest(merged), "75884ae1fe5db706c525aeccdc2393eb89ca25a2896cea264a08912e4fa548d6",
        "adjacent segments preserve the shared plane's texture coordinates");

    const texturedMap = path.join(scratch, "textured.json");
    const textured = build(bspFixture({ merged: true, textured: true }), texturedMap, "wad-bsp");
    waitForBsp(textured);
    // Both frames use R_InitLightTables, R_MapPlane and R_DrawSpan from
    // the pinned C, followed by the same eight-color preview projection.
    assert.equal(frameDigest(textured), "77553d1c22fc4659df93995d0a17a41a1444736fe236965fd4ca492c35254bc4");

    const rotated = build(bspFixture({ merged: true, textured: true, heading: 45, lightLevel: 96 }),
        path.join(scratch, "textured-rotated.json"), "wad-bsp");
    waitForBsp(rotated);
    assert.equal(frameDigest(rotated), "b0076fd85af9dc04622c2edccfccc3fc5c6db4f166771c6e9e2b6e8dae38a01e");

    const wallMap = path.join(scratch, "textured-wall.json");
    const wallFrame = build(bspFixture({ merged: true, wallTextures: true }), wallMap, "wad-bsp");
    waitForBsp(wallFrame);
    const portalFrame = build(bspFixture({ portals: true, wallTextures: true }), path.join(scratch, "textured-portal.json"), "wad-bsp");
    waitForBsp(portalFrame);
    // Full frames from the pinned R_RenderSegLoop and R_DrawColumn,
    // including upper and lower portal tiers, offsets, and pegging.
    assert.equal(frameDigest(wallFrame), "e6e8307308b02d23ef779344977c480488be4ea6132555b3d9a0e58409e96ddc");
    assert.equal(frameDigest(portalFrame), "c975f20659536d4b8b474ca21cb3b508a42c96347a7182a6a5d4cd43c907f90d");
    const rotatedWall = build(bspFixture({ merged: true, wallTextures: true, heading: 45, lightLevel: 96 }),
        path.join(scratch, "rotated-wall.json"), "wad-bsp");
    waitForBsp(rotatedWall);
    assert.equal(frameDigest(rotatedWall), "f1ff6f7b40b3ce0611a9ae2f9f134166454c878f12fc42c4047f37254f9f73ac");

    const skyMap = path.join(scratch, "sky-portal.json");
    const sky = build(bspFixture({ portals: true, wallTextures: true, sky: true }), skyMap, "wad-bsp");
    waitForBsp(sky);
    // MAP12 selects SKY2. Both near sectors face the same sky even though
    // ceiling heights and light levels differ. The sky uses COLORMAP row 0.
    assert.equal(frameDigest(sky), "29a2a5ca54e7798a5e2ca8b81f57a2a59b3a2f2bb8ee97f32426c66632e5bc63");
    const rotatedSky = build(bspFixture({ portals: true, wallTextures: true, sky: true, heading: 45 }),
        path.join(scratch, "rotated-sky.json"), "wad-bsp");
    waitForBsp(rotatedSky);
    assert.equal(frameDigest(rotatedSky), "67b2ba010c944d42a1dc23c8e888b4069b3610c724ca1067d1e9296c282e6903");

    const skyWalk = build(bspFixture({ portals: true, wallTextures: true, sky: true, blockMap: true }),
        path.join(scratch, "sky-walking.json"), "wad-bsp");
    waitForBsp(skyWalk);
    const skyWalkStart = frameDigest(skyWalk);
    assert.equal(skyWalkStart, frameDigest(sky));
    for (let i = 0; i < 3; i++) skyWalk.stepTic([4, 23]); // D and W together.
    assert.notEqual(frameDigest(skyWalk), skyWalkStart, "movement and sky textures fit the regular tick budget");
    assert.deepEqual(JSON.parse(JSON.stringify(skyWalk.logs)), [["Classic WAD BSP frame rendered"]]);

    const spriteFrames = {
        open: "1bbf26dd4a690670fb83701ee1c12ca61635b57ab586bf069fab4727e12230e4",
        portal: "f050329d76ecf02d6a60d54ce16f4be9347d3bb7c059c4d5eb9e21b5f022756a",
    };
    const spriteMaps = new Map();
    for (const spriteView of ["open", "portal", "solid"]) {
        const base = build(bspFixture({ spriteView }), path.join(scratch, `sprite-${spriteView}-background.json`), "wad-bsp");
        const map = path.join(scratch, `sprite-${spriteView}.json`);
        const foreground = build(bspFixture({ spriteView, drawSprite: true }), map, "wad-bsp");
        spriteMaps.set(spriteView, map);
        waitForBsp(base);
        waitForBsp(foreground);
        const expected = framePixels(base);
        if (spriteView === "solid") {
            assert.deepEqual(framePixels(foreground), expected, "an opaque nearer wall hides the sprite");
        } else {
            assert.equal(frameDigest(foreground), spriteFrames[spriteView], `pinned Doom sprite frame through ${spriteView}`);
            if (values.spriteOracle) {
                const oracle = readFileSync(path.resolve(values.spriteOracle, `${spriteView}.bin`));
                assert.equal(oracle.length, expected.length);
                const swatches = [7, 0, 1, 5, 3, 4, 2, 6];
                for (let i = 0; i < oracle.length; i++) if (oracle[i] !== 255) expected[i] = swatches[oracle[i] & 7];
                assert.deepEqual(framePixels(foreground), expected, `pinned Doom sprite pixels through ${spriteView}`);
            }
        }
    }
    if (values.spriteOutput) writeFileSync(path.resolve(values.spriteOutput), readFileSync(spriteMaps.get("portal")));

    function maskedFrame(name, options = {}) {
        const map = path.join(scratch, `masked-${name}.json`);
        const sim = build(bspFixture({ maskedView: true, ...options }), map, "wad-bsp");
        waitForBsp(sim);
        return { map, pixels: framePixels(sim) };
    }

    const background = maskedFrame("background").pixels;
    const fence = maskedFrame("fence", { withMask: true }).pixels;
    const firstFenceRow = Array(128).fill(96);
    const lastFenceRow = Array(128).fill(-1);
    for (let i = 0; i < fence.length; i++) {
        if (fence[i] === background[i]) continue;
        const x = i % 128, y = i >> 7;
        firstFenceRow[x] = Math.min(firstFenceRow[x], y);
        lastFenceRow[x] = y;
    }
    for (const [name, spriteX] of [["near", 16], ["far", 48]]) {
        const sprite = maskedFrame(`${name}-sprite`, { drawSprite: true, spriteX }).pixels;
        const both = maskedFrame(`${name}-both`, { withMask: true, drawSprite: true, spriteX });
        const expected = Buffer.from(background);
        let sharedPixels = 0;
        let spriteThroughFenceGap = 0;
        for (let i = 0; i < expected.length; i++) {
            const fenceVisible = fence[i] !== background[i];
            const spriteVisible = sprite[i] !== background[i];
            if (fenceVisible && spriteVisible) sharedPixels++;
            const x = i % 128, y = i >> 7;
            if (spriteVisible && !fenceVisible && y > firstFenceRow[x] && y < lastFenceRow[x]) spriteThroughFenceGap++;
            if (fenceVisible) expected[i] = fence[i];
            if (spriteVisible && (!fenceVisible || name === "near")) expected[i] = sprite[i];
        }
        assert.ok(sharedPixels > 0, `the ${name} sprite overlaps opaque fence posts`);
        assert.deepEqual(both.pixels, expected, `the ${name} sprite composites at the correct depth`);
        if (name === "far") {
            assert.ok(spriteThroughFenceGap > 0, "the farther sprite is visible between fence posts");
            if (values.maskedOutput) writeFileSync(path.resolve(values.maskedOutput), readFileSync(both.map));
        }
    }

    if (values.output) writeFileSync(path.resolve(values.output), readFileSync(path.join(scratch, "preview.json")));
    if (values.bspOutput) writeFileSync(path.resolve(values.bspOutput), readFileSync(bspMap));
    if (values.portalOutput) writeFileSync(path.resolve(values.portalOutput), readFileSync(portalMap));
    if (values.mergedOutput) writeFileSync(path.resolve(values.mergedOutput), readFileSync(mergedMap));
    if (values.texturedOutput) writeFileSync(path.resolve(values.texturedOutput), readFileSync(texturedMap));
    if (values.wallOutput) writeFileSync(path.resolve(values.wallOutput), readFileSync(wallMap));
    if (values.skyOutput) writeFileSync(path.resolve(values.skyOutput), readFileSync(skyMap));
    console.log("WAD views passed compressed imports, wall, flat, sky and sprite rendering, animations, line scrolling, sector lighting and its triggers, manual, tagged and timed doors, moving floors, ceilings and platforms, switches, masked wall depth, keyboard movement, script splitting, and invalid geometry checks.");
}

try {
    const resourceIndex = values.resourceIndex || values.resourceIndexOutput;
    const focused = values.drawSegmentCapacity || values.bspDepth || values.spriteCapacity || values.visplaneCapacity ||
        values.bspBoundary || values.maskedRaster || resourceIndex || values.animatedMaterials;
    if (!focused || values.maskedRaster) {
        verifyMaskRaster();
        verifyWideMaskRaster();
    }
    if (!focused || values.drawSegmentCapacity) {
        verifyDrawSegmentCapacity();
        console.log("WAD view passed 1,056 masked ranges, disjoint-page pruning, continued movement, solid clipping beyond the inline pages, and reverse mask order across pages.");
    }
    if (!focused || values.bspDepth) verifyDeepBsp(values.bspDepth);
    if (values.bspBoundary) verifyClassicSegBoundary();
    if (resourceIndex) verifyLargeResourceIndex();
    if (values.animatedMaterials) {
        verifyAnimatedPegging();
        verifyAnimatedMaterials();
        console.log("WAD view passed animated wall and flat pixels, idle hold, movement, and masked and opaque pegging.");
    }
    if (!focused || values.visplaneCapacity) {
        verifyVisplaneCapacity();
        console.log("WAD view passed 280 floor and ceiling planes with exact opening and movement frames.");
    }
    if (!focused || values.spriteCapacity) {
        verifySpriteCapacity();
        console.log("WAD view passed 257 visible sprites with exact opening and movement frames.");
    }
    if (!focused) verifyViews();
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-wad-view-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
