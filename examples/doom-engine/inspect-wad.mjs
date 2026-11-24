// SPDX-License-Identifier: GPL-2.0-only
// Copyright (C) 1993-1996 id Software, Inc.
// Adapted on 2026-11-21 from the header, directory, and lookup rules in w_wad.c.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";

const headerBytes = 12;
const entryBytes = 16;

export function inspectWad(file, names = []) {
    const wanted = new Map(names.map(name => [name, queryName(name)]));
    const matches = new Map();
    const handle = openSync(file, "r");
    try {
        const stat = fstatSync(handle);
        if (!stat.isFile() || stat.size < headerBytes) throw new Error("Expected a WAD file with a 12-byte header.");

        const header = Buffer.alloc(headerBytes);
        readExactly(handle, header, header.length, 0);
        const kind = header.toString("latin1", 0, 4);
        if (kind !== "IWAD" && kind !== "PWAD") throw new Error("Expected an IWAD or PWAD signature.");

        const count = header.readInt32LE(4);
        const directoryOffset = header.readInt32LE(8);
        if (count < 0 || directoryOffset < 0 || directoryOffset > stat.size ||
            (count > 0 && directoryOffset < headerBytes) || count > Math.floor((stat.size - directoryOffset) / entryBytes)) {
            throw new Error("WAD directory lies outside the file.");
        }

        const batch = Buffer.alloc(entryBytes * 256);
        for (let first = 0; first < count; first += 256) {
            const entries = Math.min(256, count - first);
            readExactly(handle, batch, entries * entryBytes, directoryOffset + first * entryBytes);
            for (let i = 0; i < entries; i++) {
                const start = i * entryBytes;
                const offset = batch.readInt32LE(start);
                const size = batch.readInt32LE(start + 4);
                const index = first + i;
                if (size < 0 || (size > 0 && (offset < 0 || offset > stat.size - size))) {
                    throw new Error(`WAD lump ${index} lies outside the file.`);
                }
                const rawName = batch.subarray(start + 8, start + 16);
                for (const [query, bytes] of wanted) {
                    // Replacing earlier matches implements Doom's reverse lookup order.
                    if (rawName.equals(bytes)) matches.set(query, { index, offset, size });
                }
            }
        }
        return { kind, count, directoryOffset, matches: Object.fromEntries(names.map(name => [name, matches.get(name) ?? null])) };
    } finally {
        closeSync(handle);
    }
}

function queryName(name) {
    if (!/^[ -~]{1,8}$/.test(name)) throw new Error("Lump names must contain 1–8 printable ASCII characters.");
    const result = Buffer.alloc(8);
    result.write(name.toUpperCase(), "ascii");
    return result;
}

function readExactly(handle, buffer, length, offset) {
    let total = 0;
    while (total < length) {
        const read = readSync(handle, buffer, total, length - total, offset + total);
        if (read === 0) throw new Error("WAD ended while reading the directory or header.");
        total += read;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [file, ...names] = process.argv.slice(2);
    try {
        if (!file) throw new Error("Usage: node inspect-wad.mjs <file.wad> [lump-name ...]");
        console.log(JSON.stringify(inspectWad(file, names), null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
