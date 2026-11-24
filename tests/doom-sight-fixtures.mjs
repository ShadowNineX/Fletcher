// Synthetic, asset-free P_CheckSight fixtures for Linux Doom 1.10 p_sight.c.
// Coordinates and sector heights are signed 16.16 fixed point values.

const U = 65536;
const TwoSided = 4;
const Leaf = 0x8000;
const open = [0, 128 * U];
const viewer = [0, 0, 0, 56 * U, 0];
const target = [64 * U, 0, 0, 56 * U, 1];
const diagonalWindow = {
    vertices: [[-16 * U, 16 * U], [32 * U, -8 * U]],
    lines: [[0, 1, TwoSided]], segs: [[0, 0, 1]], leaves: [[1, 0]], nodes: [], reject: [0],
    viewer: [3 * U / 8, -U / 2, 0, 56 * U, 0], target: [509 * U / 8, 129 * U / 4, 0, 56 * U, 1],
};

function deepTree(wallLeaf = -1) {
    const depth = 260;
    return {
        sectors: [open], vertices: [[(wallLeaf + 1) * U, -16 * U], [(wallLeaf + 1) * U, 16 * U]],
        lines: [[0, 1, 0]], segs: [[0, 0, -1]],
        leaves: Array.from({ length: depth + 1 }, (_, index) => [Number(index === wallLeaf), 0]),
        nodes: Array.from({ length: depth }, (_, index) => [
            (index + 1) * U, 0, 0, U, Leaf | (index + 1), index === 0 ? Leaf : index - 1,
        ]),
        reject: [0], viewer, target: [(depth + 4) * U, 0, 0, 56 * U, 0],
    };
}

const cyclicDeepTree = deepTree();
cyclicDeepTree.nodes[0][5] = cyclicDeepTree.nodes.length - 1;

// The runner encodes these as classic lumps. The final viewer/target
// element is the declared sector used by the REJECT lookup; the fixture map's
// BSP still drives line traversal.
export const visibleSightFixtures = [
    {
        name: "zero-node same-sector face is visible",
        sectors: [open], vertices: [], lines: [], segs: [], leaves: [[0, 0]], nodes: [], reject: [0],
        viewer: [0, 0, 0, 56 * U, 0], target: [64 * U, 0, 0, 56 * U, 0],
    },
    {
        name: "reject is directional when only target-to-viewer bit is clear",
        sectors: [open, open], vertices: [], lines: [], segs: [], leaves: [[0, 0]], nodes: [], reject: [0x02],
        viewer: [64 * U, 0, 0, 56 * U, 1], target: [0, 0, 0, 56 * U, 0],
    },
    {
        name: "one-sided finite segment whose extension misses trace cannot block",
        sectors: [open, open],
        vertices: [[32 * U, 32 * U], [32 * U, 48 * U]],
        lines: [[0, 1, 0]], segs: [[0, 0, -1]], leaves: [[1, 0]], nodes: [], reject: [0], viewer, target,
    },
    {
        name: "two-sided equal-height blocking portal remains sight-transparent",
        sectors: [open, open],
        vertices: [[32 * U, -16 * U], [32 * U, 16 * U]],
        lines: [[0, 1, TwoSided | 1]], segs: [[0, 0, 1]], leaves: [[1, 0]], nodes: [], reject: [0], viewer, target,
    },
    {
        name: "multiple windows contract but retain a target-height slope interval",
        sectors: [open, [16 * U, 112 * U], [24 * U, 96 * U]],
        vertices: [[16 * U, -16 * U], [16 * U, 16 * U], [32 * U, -16 * U], [32 * U, 16 * U]],
        lines: [[0, 1, TwoSided], [2, 3, TwoSided]], segs: [[0, 0, 1], [1, 1, 2]],
        leaves: [[2, 0]], nodes: [], reject: [0, 0], viewer, target,
    },
    {
        name: "floating target is visible through a raised window",
        sectors: [open, [32 * U, 96 * U]],
        vertices: [[32 * U, -16 * U], [32 * U, 16 * U]], lines: [[0, 1, TwoSided]], segs: [[0, 0, 1]],
        leaves: [[1, 0]], nodes: [], reject: [0], viewer, target: [64 * U, 0, 64 * U, 16 * U, 1],
    },
    {
        name: "duplicate seg entries only test a linedef once",
        sectors: [open, open],
        vertices: [[32 * U, -16 * U], [32 * U, 16 * U]], lines: [[0, 1, TwoSided]],
        segs: [[0, 0, 1], [0, 1, 0]], leaves: [[2, 0]], nodes: [], reject: [0], viewer, target,
    },
    {
        name: "BSP visits near then far subsectors across a vertical partition",
        sectors: [open, open],
        vertices: [[16 * U, -16 * U], [16 * U, 16 * U], [48 * U, -16 * U], [48 * U, 16 * U]],
        lines: [[0, 1, TwoSided], [2, 3, TwoSided]], segs: [[0, 0, 1], [1, 1, 0]],
        leaves: [[1, 0], [1, 1]], nodes: [[32 * U, 0, 0, 64 * U, Leaf, Leaf | 1]], reject: [0], viewer, target,
    },
    {
        name: "viewer on BSP partition crosses both children",
        sectors: [open, open],
        vertices: [[48 * U, -16 * U], [48 * U, 16 * U]], lines: [[0, 1, TwoSided]], segs: [[0, 0, 1]],
        leaves: [[1, 0], [0, 1]], nodes: [[32 * U, 0, 0, 64 * U, Leaf, Leaf | 1]], reject: [0],
        viewer: [32 * U, 0, 0, 56 * U, 0], target: [-64 * U, 0, 0, 56 * U, 1],
    },
    {
        name: "horizontal partition preserves original x-equals-node-y quirk",
        sectors: [open, open], vertices: [], lines: [], segs: [], leaves: [[0, 0], [0, 0]],
        nodes: [[0, 0, 64 * U, 0, Leaf, Leaf | 1]], reject: [0],
        viewer: [0, 16 * U, 0, 56 * U, 0], target: [64 * U, 16 * U, 0, 56 * U, 1],
    },
    {
        ...diagonalWindow, name: "oblique opening clips a fractional trace without closing it",
        sectors: [open, [40 * U, 128 * U]],
    },
    {
        name: "diagonal partition crosses both children in distance order",
        sectors: [open, open], vertices: [], lines: [], segs: [], leaves: [[0, 0], [0, 0]],
        nodes: [[0, 0, 64 * U, 64 * U, Leaf, Leaf | 1]], reject: [0],
        viewer: [0, 8 * U, 0, 56 * U, 0], target: [64 * U, 0, 0, 56 * U, 1],
    },
    { ...deepTree(), name: "sight resumes all 260 pending BSP branches" },
];

export const blockedSightFixtures = [
    {
        name: "reject blocks only viewer-sector to target-sector direction",
        sectors: [open, open], vertices: [], lines: [], segs: [], leaves: [[0, 0]], nodes: [], reject: [0x02], viewer, target,
    },
    {
        name: "one-sided crossed finite wall blocks sight",
        sectors: [open, open],
        vertices: [[32 * U, -16 * U], [32 * U, 16 * U]], lines: [[0, 1, 0]], segs: [[0, 0, -1]],
        leaves: [[1, 0]], nodes: [], reject: [0], viewer, target,
    },
    {
        name: "two-sided closed door blocks sight",
        sectors: [open, [64 * U, 64 * U]],
        vertices: [[32 * U, -16 * U], [32 * U, 16 * U]], lines: [[0, 1, TwoSided]], segs: [[0, 0, 1]],
        leaves: [[1, 0]], nodes: [], reject: [0], viewer, target,
    },
    {
        name: "successive windows collapse target slopes",
        sectors: [open, [32 * U, 96 * U], [50 * U, 56 * U]],
        vertices: [[16 * U, -16 * U], [16 * U, 16 * U], [32 * U, -16 * U], [32 * U, 16 * U]],
        lines: [[0, 1, TwoSided], [2, 3, TwoSided]], segs: [[0, 0, 1], [1, 1, 2]],
        leaves: [[2, 0]], nodes: [], reject: [0, 0], viewer, target,
    },
    {
        name: "low floating target is occluded by a raised window sill",
        sectors: [open, [32 * U, 96 * U]],
        vertices: [[32 * U, -16 * U], [32 * U, 16 * U]], lines: [[0, 1, TwoSided]], segs: [[0, 0, 1]],
        leaves: [[1, 0]], nodes: [], reject: [0], viewer, target: [64 * U, 0, 0, 16 * U, 1],
    },
    {
        ...diagonalWindow, name: "oblique opening can close the same fractional trace",
        sectors: [open, [46 * U, 128 * U]],
    },
    {
        name: "REJECT reads directional bits past the first byte",
        sectors: [open, open, open, open], vertices: [], lines: [], segs: [], leaves: [[0, 0]], nodes: [], reject: [0, 0x40],
        viewer: [0, 0, 0, 56 * U, 3], target: [64 * U, 0, 0, 56 * U, 2],
    },
    { ...deepTree(130), name: "a deferred leaf blocks sight after unwinding across stack pages" },
];

export const malformedSightFixtures = [
    { ...cyclicDeepTree, name: "a cycle after 260 BSP branches is rejected within the visit budget" },
    {
        name: "bad BSP child cycle is rejected before traversal loops",
        sectors: [open], vertices: [], lines: [], segs: [], leaves: [[0, 0]],
        nodes: [[0, 0, 64 * U, 0, 0, Leaf]], reject: [0],
        viewer: [0, 0, 0, 56 * U, 0], target: [64 * U, 0, 0, 56 * U, 0],
    },
    {
        name: "out-of-range seg linedef is rejected",
        sectors: [open], vertices: [], lines: [], segs: [[3, 0, -1]], leaves: [[1, 0]], nodes: [], reject: [0],
        viewer: [0, 0, 0, 56 * U, 0], target: [64 * U, 0, 0, 56 * U, 0],
    },
];
