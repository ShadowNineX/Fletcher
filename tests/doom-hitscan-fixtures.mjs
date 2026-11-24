// Synthetic classic geometry and actors for Doom aiming and line attacks.
const unit = 65536;
const shootable = 4;
const noBlockMap = 0x10;
const noBlood = 0x80000;
const twoSided = 4;
const east = 0;
const north = 0x40000000;
const west = 0x80000000;

const room = [0, 128 * unit, 0];
const vertices = [
    [1000 * unit, 1000 * unit], [1001 * unit, 1000 * unit],
    [64 * unit, -96 * unit], [64 * unit, 96 * unit],
    [-96 * unit, 64 * unit], [96 * unit, 64 * unit],
    [-96 * unit, -64 * unit], [96 * unit, -64 * unit],
    [104 * unit, -96 * unit], [104 * unit, 96 * unit],
];
const dummy = [0, 1, 0, 0, 0, -1];
const eastWall = [2, 3, 0, 0, 0, -1];
const eastPortal = [2, 3, twoSided, 0, 0, 1];
const northWall = [4, 5, 0, 0, 0, -1];
const southWall = [6, 7, 0, 0, 0, -1];
const secondPortal = [8, 9, twoSided, 45, 1, 0];
const actor = (x = 96, y = 8, z = 0, height = 56, radius = 16, flags = shootable) =>
    [x * unit, y * unit, z * unit, height * unit, radius * unit, flags];

function fixture(name, { lines = [], actors = [], shooter = actor(8, 8), ...rest } = {}) {
    const indexes = [0, ...lines.map((_, index) => index + 1)];
    return {
        name, sectors: [room], vertices, lines: [dummy, ...lines],
        blocks: { x: -128 * unit, y: -128 * unit, width: 4, height: 4, lines: Array.from({ length: 16 }, () => indexes) },
        actors: [shooter, ...actors], shooter: 1, angle: east, range: 256 * unit,
        slope: null, amount: 20, overrides: [], ...rest,
    };
}

export const hitscanFixtures = [
    fixture("one-sided wall puff", { lines: [eastWall], expected: { aim: 0, effect: 2 } }),
    fixture("target blood and damage", { actors: [actor()], expected: { aim: 2, effect: 3, target: 2 } }),
    fixture("no-blood object substitutes a puff", {
        actors: [actor(96, 8, 0, 56, 16, shootable | noBlood)], expected: { aim: 2, effect: 2, target: 2 },
    }),
    fixture("zero damage still spawns blood without applying damage", {
        amount: 0, actors: [actor()], expected: { aim: 2, effect: 3 },
    }),
    fixture("middle damage picks the second blood state", {
        amount: 11, actors: [actor()], expected: { aim: 2, effect: 3, target: 2, state: 91 },
    }),
    fixture("short melee wall puff uses its nonsparking state", {
        range: 64 * unit, lines: [eastWall], expected: { aim: 0, effect: 2, state: 95 },
    }),
    fixture("first actor is above the autoaim cone", {
        actors: [actor(72, 8, 120, 16), actor(144)], expected: { aim: 3, effect: 3, target: 3 },
    }),
    fixture("first actor is below the autoaim cone", {
        actors: [actor(72, 8, -96, 16), actor(144)], expected: { aim: 3, effect: 3, target: 3 },
    }),
    fixture("manual slope passes beneath the target", {
        actors: [actor(96, 8, 48, 16)], slope: 0, expected: { aim: 2, effect: 0 },
    }),
    fixture("corpse and unlinked actor are skipped", {
        actors: [actor(48, 8, 0, 56, 16, 2), actor(64, 8, 0, 56, 16, shootable | noBlockMap), actor()],
        expected: { aim: 4, effect: 3, target: 4 },
    }),
    fixture("open portal clips the autoaim cone", {
        sectors: [room, [28 * unit, 44 * unit, 0]], lines: [eastPortal], actors: [actor(112, 8, 0, 80)],
        expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("closed portal blocks both aim and shot", {
        sectors: [room, [0, 0, 0]], lines: [eastPortal], actors: [actor()], expected: { aim: 0, effect: 2 },
    }),
    fixture("wall wins a line/thing intercept tie", {
        lines: [eastWall], actors: [actor(64, 8 + 1400 / unit)], expected: { aim: 0, effect: 2 }, tie: "wall",
    }),
    fixture("equal thing fractions favor the last linked actor", {
        actors: [actor(), actor()], expected: { aim: 3, effect: 3, target: 3 }, tie: "thing",
    }),
    fixture("a crowded block sorts many actors in reverse link order", {
        actors: Array.from({ length: 63 }, (_, index) => actor(20 + index * 1.5)), crowded: true,
        expected: { aim: 2, effect: 3, target: 2, pathCount: 64 },
    }),
    fixture("shot crosses 130 tied portals before triggering a farther switch and hitting an actor", {
        sectors: [room, room], lines: [...Array.from({ length: 130 }, () => eastPortal), secondPortal],
        actors: [actor(144)], expandedTrace: true,
        expected: { aim: 2, effect: 3, target: 2, specials: [131], pathCount: 133 },
    }),
    fixture("one-sided impact terminates before the next trigger", {
        lines: [eastWall, [8, 9, 0, 45, 0, -1]], actors: [actor(144)],
        expected: { aim: 0, effect: 2, specials: [] },
    }),
    fixture("wall impact above a sky ceiling suppresses the puff", {
        sectors: [[0, 24 * unit, 1]], lines: [eastWall], expected: { aim: 0, effect: 0, sky: true },
    }),
    fixture("two sky ceilings suppress the lower wall impact too", {
        sectors: [[0, 128 * unit, 1], [64 * unit, 128 * unit, 1]], lines: [eastPortal],
        expected: { aim: 0, effect: 0, sky: true },
    }),
    fixture("mixed sky portal below its front ceiling keeps the puff", {
        sectors: [[0, 128 * unit, 1], [64 * unit, 128 * unit, 0]], lines: [eastPortal],
        expected: { aim: 0, effect: 2 },
    }),
    fixture("shot delivers passing line triggers in travel order", {
        sectors: [room, room], lines: [[2, 3, twoSided, 45, 0, 1], secondPortal],
        actors: [actor(144)], expected: { aim: 2, effect: 3, target: 2, specials: [1, 2] },
    }),
    fixture("shoot special changes the opening before the same shot is clipped", {
        sectors: [room, [0, 0, 0]], lines: [[2, 3, twoSided, 45, 0, 1]],
        actors: [actor(112)], overrides: [[1, 1, 112 * unit]],
        expected: { aim: 0, effect: 3, target: 2, specials: [1] },
    }),
    fixture("the normal impact dispatcher starts a tagged door", {
        sectors: [room, [0, 0, 0, 7]], lines: [[2, 3, twoSided, 46, 0, 1, 7]],
        actors: [actor(112)], realSpecial: true, expected: { aim: 0, effect: 2, specials: [1] },
    }),
    fixture("boundary start nudges both axes before placing the impact", {
        shooter: actor(0, 0), actors: [actor(128 - 1 / unit, 0)], expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("reversed shot traces a negative world coordinate", {
        angle: west, actors: [actor(-96)], expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("diagonal shot crosses mixed BLOCKMAP cells", {
        shooter: actor(8, 2), angle: 0x20000000, actors: [actor(164, 158)], expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("exact corner stall rechecks the linked actor for each native pass", {
        shooter: actor(64, 96, 0, 56, 16, shootable | noBlockMap), angle: 604 << 19,
        actors: [actor(96, 112)], pathEnd: [256 * unit, 192 * unit],
        blocks: { x: -128 * unit, y: -128 * unit, width: 4, height: 4, lines: Array.from({ length: 16 }, () => []) },
        expected: { aim: 2, effect: 3, target: 2, pathCount: 64 },
    }),
    fixture("exact corner stall keeps three tied actors across all 64 passes", {
        shooter: actor(64, 96, 0, 56, 16, shootable | noBlockMap), angle: 604 << 19,
        actors: Array.from({ length: 3 }, () => actor(96, 112)), pathEnd: [256 * unit, 192 * unit],
        blocks: { x: -128 * unit, y: -128 * unit, width: 4, height: 4, lines: Array.from({ length: 16 }, () => []) },
        expandedTrace: true, expected: { aim: 4, effect: 3, target: 4, pathCount: 192 },
    }),
    fixture("quarter-turn shot crosses a horizontal wall", {
        angle: north, lines: [northWall], expected: { aim: 0, effect: 2 },
    }),
    fixture("cosine reaches the original table extension after 270 degrees", {
        angle: (6214 << 19) >>> 0, lines: [southWall], expected: { aim: 0, effect: 2 },
    }),
    fixture("an accurate gunshot draws damage once before its impact effect", {
        gun: true, amount: 15, actors: [actor()], expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("gun spread draws left then right after damage", {
        gun: false, amount: 15, actors: [actor()], expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("gun spread and impact effects keep their draw order across RNG wraparound", {
        gun: false, randomIndex: 255, amount: 5, actors: [actor()],
        expected: { aim: 2, effect: 3, target: 2, state: 92 },
    }),
    fixture("offset autoaim supplies vertical slope while a gunshot keeps the original heading", {
        gun: true, amount: 15, actors: [actor(320, 39, 48)], expected: { aim: 2, effect: 0 },
    }),
    fixture("an accurate gunshot starts from the actor's quarter-turn heading", {
        gun: true, amount: 15, angle: north, actors: [actor(8, 110)], expected: { aim: 2, effect: 3, target: 2 },
    }),
    fixture("shotgun fires seven ordered pellets and triggers the wall for each", {
        weaponAction: 9, nativeAction: "A_FireShotgun", shots: 7, lines: [[2, 3, 0, 49, 0, -1]],
    }),
    fixture("super shotgun uses independent vertical and horizontal draws for all 20 pellets", {
        weaponAction: 11, nativeAction: "A_FireShotgun2", shots: 20, lines: [eastWall], randomIndex: 250,
    }),
    fixture("berserk punch hits and faces the target", {
        weaponAction: 5, nativeAction: "A_Punch", shots: 1, strength: true, actors: [actor(45, 10)], amount: 180,
    }),
    fixture("punch and chainsaw use different puff states on the same wall", {
        weaponAction: 5, nativeAction: "A_Punch", shots: 1, lines: [eastWall],
    }),
    fixture("a saw miss sounds and does not turn", {
        weaponAction: 19, nativeAction: "A_Saw", shots: 1, lines: [eastWall],
    }),
    fixture("a saw pulls toward a target on the negative side of its heading", {
        weaponAction: 19, nativeAction: "A_Saw", shots: 1, actors: [actor(41, 0)], amount: 18,
    }),
    fixture("a saw also pulls toward a target on the positive side of its heading", {
        weaponAction: 19, nativeAction: "A_Saw", shots: 1, angle: 0xf8000000, actors: [actor(40, 9)], amount: 18,
    }),
    fixture("BFG spray looks from the owner across zero degrees and selects targets on both sides", {
        bfgAngle: 0, actors: [actor(150, -28), actor(164, 56, 9)], randomIndex: 248,
    }),
    fixture("BFG spray follows missile heading independently of the owner's north-facing aim", {
        bfgAngle: 0x80000000, angle: north, actors: [actor(-70, 38, 13, 48)],
    }),
    fixture("BFG spray does not penetrate a one-sided wall", {
        bfgAngle: 0, actors: [actor(145, 8)], lines: [eastWall], blockedSpray: true,
    }),
    fixture("a former human clears ambush, aims through shadow fuzz, and fires a single bullet", {
        enemyAction: 32, enemyNative: "A_PosAttack", shots: 1, angle: north, randomIndex: 76,
        shooter: actor(8, 8, 0, 56, 16, shootable | 0x20),
        actors: [actor(145, 8, 0, 56, 16, shootable | 0x40000)], lines: [eastWall],
    }),
    fixture("a shotgun sergeant fires three pellets from one aimed slope", {
        enemyAction: 34, enemyNative: "A_SPosAttack", shots: 3, actors: [actor(148, 22)], lines: [eastWall], randomIndex: 253,
    }),
    fixture("a chaingunner fires one shot in its burst action", {
        enemyAction: 51, enemyNative: "A_CPosAttack", shots: 1, actors: [actor(140, -27)], lines: [eastWall],
    }),
];
