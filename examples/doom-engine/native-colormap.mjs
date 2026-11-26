import assert from "node:assert/strict";

function findColormap(wad) {
    assert.ok(wad.length >= 12 && ["IWAD", "PWAD"].includes(wad.toString("ascii", 0, 4)), "Expected a Doom WAD");
    const count = wad.readUInt32LE(4);
    const directory = wad.readUInt32LE(8);
    assert.ok(directory <= wad.length && count <= (wad.length - directory) / 16, "Invalid WAD directory");
    for (let index = count - 1; index >= 0; index--) {
        const entry = directory + index * 16;
        if (wad.toString("ascii", entry + 8, entry + 16).toUpperCase() !== "COLORMAP") continue;
        const offset = wad.readUInt32LE(entry);
        const size = wad.readUInt32LE(entry + 4);
        assert.ok(size >= 32 * 256 && size % 256 === 0 && size <= wad.length - offset, "Invalid COLORMAP lump");
        return { offset, data: wad.subarray(offset, offset + size) };
    }
    throw new Error("The supplied WAD has no COLORMAP lump");
}

export function nativeColormap(wad) {
    const { offset, data } = findColormap(wad);
    const banks = 64;
    const rows = Math.ceil(data.length / banks);
    const dataBits = 8;
    const columns = dataBits + 1;
    const left = -2100;
    const top = -350;
    const bankStride = 2 * columns + 4;
    const firstRead = columns + 2;
    const layout = [];
    function place(type, x, y, facing) {
        layout.push(`    place ${type} at (${x}, ${y}) facing ${facing}`);
    }
    for (let bank = 0; bank < banks; bank++) {
        const bankX = left + bank * bankStride;
        place("arrow", bankX - 2, top, "right");
        for (let row = 0; row < rows; row++) {
            const y = top + 2 * row;
            const value = data[bank * rows + row] ?? 0;
            // The moving clock launches a pulse along each row. A splitter
            // stores one and sends a second pulse into the upward data lane.
            place("blueLSplitter", bankX - 1, y, "down flipped");
            for (let bit = 0; bit < columns; bit++) {
                const x = bankX + 2 * bit;
                const set = bit === dataBits || ((value >>> bit) & 1) !== 0;
                place(set ? "blueLSplitter" : "blueArrow", x, y, set ? "right flipped" : "right");
                if (row > 0) place("blueArrow", x, y - 1, "up");
            }
        }
        for (let bit = 0; bit < columns; bit++) {
            const x = bankX + 2 * bit;
            // Equalize the horizontal launch and vertical return latency.
            const pinY = top - 1 - 2 * (dataBits - bit);
            for (let y = top - 1; y > pinY; y -= 2) place("blueArrow", x, y, "up");
            place("arrow", x, pinY, "up");
        }
    }
    for (const x of [left, left + (banks - 1) * bankStride]) {
        for (const [index, letter] of [..."COLORMAP"].entries()) {
            layout.push(`    expand DoomSignLetter(${x + index}, ${top - 22}, ${JSON.stringify(letter)})`);
        }
    }

    // Read the valid lane before accepting the eight data bits. The bridge
    // hands the renderer one immutable table after the physical scan ends.
    const bridge = `
const bytes = Array(${data.length}).fill(0);
let start, previous, row = 0, done = false;
always(() => {
    if (done) return;
    const tick = world.getTick();
    if (start === undefined) start = tick;
    else if (tick !== previous + 1) {
        start = tick + ${firstRead + 2 * rows};
        row = 0;
    }
    previous = tick;
    if (tick === start) {
        for (let bank = 0; bank < ${banks}; bank++) world.setSignal(${left - 2} + bank * ${bankStride}, ${top}, 1);
    }
    const elapsed = tick - start - ${firstRead};
    if (elapsed < 0 || (elapsed & 1) !== 0) return;
    for (let bank = 0; bank < ${banks}; bank++) {
        const index = bank * ${rows} + row;
        if (index >= bytes.length) break;
        const x = ${left} + bank * ${bankStride};
        if (world.getSignal(x + ${2 * dataBits}, ${top - 1}) <= 0) {
            log("Doom native COLORMAP valid pulse missing", bank, row);
            done = true;
            return;
        }
        let byte = 0;
        for (let bit = 0; bit < ${dataBits}; bit++) {
            if (world.getSignal(x + 2 * bit, ${top - 1 - 2 * dataBits} + 2 * bit) > 0) byte |= 1 << bit;
        }
        bytes[index] = byte;
    }
    if (++row !== ${rows}) return;
    globalState.doomNativeColorMaps = bytes;
    log("Doom native COLORMAP ready", tick, bytes.length);
    done = true;
});`;
    layout.push(`    place scriptBlock at (${left - 5}, ${top}) with { code = ${JSON.stringify(bridge)} }`);
    return { layout: layout.join("\n"), offset, size: data.length };
}
