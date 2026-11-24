import assert from "node:assert/strict";
import vm from "node:vm";
import { inflateSync } from "node:zlib";

export function decode(encoded) {
    const bytes = Buffer.from(encoded, "base64");
    assert.deepEqual([...bytes.subarray(0, 2)], [5, 0]);
    assert.ok(bytes[2] === 0 || bytes[2] === 1);
    const body = bytes[2] === 1 ? inflateSync(bytes.subarray(3)) : bytes.subarray(3);
    let offset = 0;
    const byte = () => body.readUInt8(offset++);
    const word = () => { const value = body.readUInt16LE(offset); offset += 2; return value; };
    const coordinate = () => { const value = word(); return (value & 0x7fff) * ((value & 0x8000) ? -1 : 1); };
    const tiles = [];
    const occupied = new Set();
    const chunks = word();
    for (let chunk = 0; chunk < chunks; chunk++) {
        const chunkX = coordinate();
        const chunkY = coordinate();
        const groups = byte() + 1;
        for (let group = 0; group < groups; group++) {
            const type = byte();
            const count = byte() + 1;
            for (let i = 0; i < count; i++) {
                const local = byte();
                const x = chunkX * 16 + (local & 15);
                const y = chunkY * 16 + (local >>> 4);
                const flags = byte();
                let extra = flags >>> 4;
                let payload;
                if (flags & 8) {
                    if (flags & 16) {
                        const length = word();
                        payload = body.subarray(offset, offset + length);
                        assert.equal(payload.length, length);
                        offset += length;
                        extra = 0;
                    } else extra = word();
                }
                const key = x + "," + y;
                assert.ok(!occupied.has(key), "tiles overlap at " + key);
                occupied.add(key);
                tiles.push({ x, y, type, rotation: flags & 3, flip: Boolean(flags & 4), extra, payload });
            }
        }
    }
    assert.equal(offset, body.length, "v5 payload must be consumed in full");
    return tiles;
}

const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const keyOf = ({ x, y }) => x + "," + y;

// Derive behavior from tile IDs and directions in the published layout rather than
// reading optimizer data or timing annotations from the compiler.
export function destinations(tile) {
    const { type, rotation, x, y, flip } = tile;
    const [dx, dy] = directions[rotation];
    const [rx, ry] = directions[(rotation + (flip ? 3 : 1)) % 4];
    const point = (a, b) => (x + a) + "," + (y + b);
    if ([1, 15, 16, 17, 19, 21, 22, 24, 28].includes(type)) return [point(dx, dy)];
    if (type === 2) return directions.map(([a, b]) => point(a, b));
    if (type === 6) return [point(dx, dy), point(-dx, -dy)];
    if (type === 7) return [point(dx, dy), point(rx, ry)];
    if (type === 8) return [point(dx, dy), point(rx, ry), point(-rx, -ry)];
    if (type === 10) return [point(dx * 2, dy * 2)];
    if (type === 11) return [point(dx + rx, dy + ry)];
    if (type === 12) return [point(dx, dy), point(dx * 2, dy * 2)];
    if (type === 13) return [point(dx * 2, dy * 2), point(rx, ry)];
    if (type === 14) return [point(dx, dy), point(dx + rx, dy + ry)];
    return [];
}

export function simulator(tiles, controllerLast = false, onSharedRead, hostMillis = tick => Math.ceil(tick * 1000 / 35)) {
    const tilesByPosition = new Map(tiles.map(tile => [keyOf(tile), tile]));
    let signals = new Map(tiles.map(tile => [keyOf(tile), 0]));
    let tick = 0;
    let tileWrites = 0;
    const callbacks = [];
    const startup = [];
    const mouse = [];
    const cameraFrames = [];
    const scriptStates = [];
    const shared = onSharedRead ? new Proxy({}, {
        get(target, key) {
            onSharedRead(key);
            return Reflect.get(target, key);
        },
    }) : {};
    const logs = [];
    class HostDate extends Date {
        static now() { return hostMillis(tick); }
    }
    const ordered = [...tiles];
    if (controllerLast) ordered.sort((a, b) => (a.type === 33) - (b.type === 33));
    else ordered.sort((a, b) => (b.type === 33) - (a.type === 33));
    const routes = new Map(tiles.map(tile => [keyOf(tile), destinations(tile).filter(key => signals.has(key))]));
    for (const tile of ordered.filter(tile => tile.payload && [22, 23, 33].includes(tile.type))) {
        const state = {};
        scriptStates.push(state);
        vm.runInNewContext(tile.payload.toString("utf8"), {
            Date: HostDate,
            globalState: shared,
            state,
            world: {
                getTick: () => tick,
                getSignal: (x, y) => signals.get(x + "," + y) ?? null,
                setSignal: (x, y, value) => signals.set(x + "," + y, value),
                setArrow(x, y, type, rotation, flip, extra) {
                    const key = keyOf({ x, y });
                    assert.ok(type === 25 || type === 29, "the model supports repainting walls and configuring music");
                    const original = tilesByPosition.get(key);
                    assert.equal(original?.type, type, "rewriting must stay on the reserved tile");
                    if (type === 29) assert.equal(original.rotation, rotation, "music voice direction stays fixed");
                    tilesByPosition.set(key, { x, y, type, rotation, flip, extra });
                    tileWrites++;
                },
            },
            getPosition: () => ({ x: tile.x, y: tile.y }),
            game: { focusCamera: (...bounds) => cameraFrames.push(bounds) },
            onStart: callback => startup.push(callback),
            onPlayerMouseMove: callback => mouse.push(callback),
            always: callback => callbacks.push(callback),
            log: (...args) => logs.push(args),
        }, { timeout: 1000 });
    }
    for (const start of startup) start();
    return {
        logs,
        cameraFrames,
        value: tile => signals.get(keyOf(tile)),
        tileAt: position => tilesByPosition.get(keyOf(position)),
        moveMouse(x, y) {
            for (const callback of mouse) callback(x, y);
        },
        setTick(value) { tick = value; },
        roundTripScriptState() {
            for (const state of scriptStates) {
                const restored = JSON.parse(JSON.stringify(state));
                for (const key of Object.keys(state)) delete state[key];
                Object.assign(state, restored);
            }
        },
        get tileWrites() { return tileWrites; },
        drive(tile, value) {
            const key = keyOf(tile);
            assert.ok(signals.has(key), "test drive requires a tile at " + key);
            signals.set(key, value);
        },
        step(clicked = [], forced = new Map(), keys = []) {
            const arrivals = new Map();
            for (const [key, value] of signals) {
                if (value <= 0) continue;
                for (const target of routes.get(key) ?? [])
                    arrivals.set(target, (arrivals.get(target) ?? 0) + 1);
            }
            if (keys.length > 0) {
                for (const tile of tiles) {
                    if (tile.type !== 21 || !keys.includes(tile.extra)) continue;
                    for (const target of routes.get(keyOf(tile)))
                        arrivals.set(target, (arrivals.get(target) ?? 0) + 1);
                }
            }
            const next = new Map();
            for (const tile of tiles) {
                const key = keyOf(tile);
                const count = arrivals.get(key) ?? 0;
                let value = count > 0;
                switch (tile.type) {
                    case 2: value = true; break;
                    case 15: value = count === 0; break;
                    case 16: value = count >= 2; break;
                    case 17: value = count % 2 !== 0; break;
                    case 19: value = Boolean(signals.get(key)) !== (count > 0); break;
                    case 21: case 22: case 25: case 33: value = false; break;
                    case 24: value = clicked.includes(key) || value; break;
                }
                next.set(key, forced.get(key) ?? Number(value));
            }
            signals = next;
            for (const callback of callbacks) callback();
            tick++;
        },
    };
}
