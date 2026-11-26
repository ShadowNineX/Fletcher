// Attach a read-only column of prelit palette indices to the phase circuit.
// A null entry is an uncovered row. The last output bit is a sample strobe.
export function attachWallTexelRom(place, rowPins, clockPin, tapY, baseY, texels) {
    const bitPitch = rowPins[1].x - rowPins[0].x;
    const bitDelay = bitPitch / 2 + 1;
    const firstX = rowPins[0].x;
    const strobeX = firstX - 2;
    const firstBitDelay = rowPins[0].y - baseY;
    const tapLead = tapY - clockPin.y;
    const horizontalHops = tapLead + firstBitDelay - 1 - (tapY - baseY);
    const fastHops = strobeX - clockPin.x - horizontalHops;

    // The tap reaches the first gate alongside the first address bit.
    // The untouched part of the vertical clock route still drives its lamp.
    place("lSplitter", clockPin.x, tapY, "up");
    let wire = clockPin.x + 1;
    for (let hop = 0; hop < fastHops; hop++, wire += 2)
        place("blueArrow", wire, tapY, "right");
    for (; wire < strobeX; wire++)
        place("arrow", wire, tapY, "right");
    for (let y = tapY; y > baseY; y--)
        place("arrow", strobeX, y, "up");

    for (const { x, y: pinY } of rowPins)
        for (let y = pinY - 1; y > baseY; y--)
            place("arrow", x, y, "up");

    const dataBits = 8;
    const coverageBit = dataBits;
    const readyBit = dataBits + 1;
    const dataX = rowPins.at(-1).x + 3;
    for (const [row, value] of texels.entries()) {
        const addressY = baseY - 2 * row;
        const gateY = addressY - 1;
        place("blueLSplitter", strobeX, addressY, "up");
        place("arrow", strobeX + 1, addressY, "up");
        place("blueArrow", strobeX + 1, gateY, "right");
        place("arrow", firstX + 1, gateY, "right");
        for (const [bit, { x }] of rowPins.entries()) {
            place("blueLSplitter", x, addressY, "up");
            place((row >>> bit) & 1 ? "arrow" : "not", x + 1, addressY, "right");
            place("arrow", x + 2, addressY, "up");
            place("and", x + 2, gateY, "right");
            if (bit === rowPins.length - 1) break;
            // Three two-cell hops cross the next address wire. One short hop
            // brings the preceding match into the next AND in five ticks.
            for (let offset = 3; offset < bitPitch + 1; offset += 2)
                place("blueArrow", x + offset, gateY, "right");
            place("arrow", x + bitPitch + 1, gateY, "right");
        }
        for (let bit = 0; bit <= readyBit; bit++) {
            const x = dataX + 2 * bit;
            const one = bit === readyBit || (value !== null &&
                (bit === coverageBit || ((value >>> bit) & 1) !== 0));
            place(one ? "blueLSplitter" : "blueArrow", x, gateY, one ? "right flipped" : "right");
            // The return rails travel in the same direction as the address
            // wires. Crossing more address rows leaves fewer return hops.
            place("blueArrow", x, gateY - 1, "up");
        }
    }
    const endY = baseY - 2 * texels.length;
    const pins = Array.from({ length: readyBit + 1 }, (_, bit) => {
        const x = dataX + 2 * bit;
        const y = endY - 2 * (readyBit - bit);
        for (let wireY = endY - 2; wireY >= y; wireY -= 2)
            place("blueArrow", x, wireY, "up");
        place("lamp", x, y - 2);
        return { x, y };
    });
    const delay = firstBitDelay + 3 + bitDelay * (rowPins.length - 1) + 2 + (texels.length - 1) + readyBit;
    return { data: pins.slice(0, dataBits), covered: pins[coverageBit], ready: pins[readyBit],
        tap: { x: clockPin.x, y: tapY }, tapLead, delay };
}
