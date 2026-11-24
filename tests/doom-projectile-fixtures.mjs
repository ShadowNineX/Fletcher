// Asset-free fixtures for the pinned P_SpawnMissile and P_SpawnPlayerMissile.
const unit = 65536;
const solid = 2, shootable = 4, shadow = 0x40000;
const player = 0, possessed = 1, imp = 11, baron = 15, knight = 17, cacodemon = 14;
const baronBall = 16, impBall = 31, cacoBall = 32, rocket = 33, plasma = 34, bfg = 35, spiderPlasma = 36;

function actor(kind, x, y, { z = 0, height = 56, flags = solid | shootable, slot = -1, angle = 0 } = {}) {
    return { kind, flags, health: 2000, x: x * unit, y: y * unit, z: z * unit, height: height * unit, slot, angle };
}

const source = actor(imp, 0, 4);
const shooter = actor(player, 0, 4, { slot: 0 });
function monster(name, kind, actors, extra = {}) {
    return { name, kind, source: 1, dest: 2, actors, barrier: 0, randomIndex: 0, skill: 2, ...extra };
}
function playerShot(name, kind, actors, extra = {}) {
    return monster(name, kind, actors, { dest: 0, ...extra });
}

export const projectileFixtures = [
    monster("imp fireball leads a signed diagonal", impBall,
        [source, actor(possessed, -90, 84, { z: 20 })]),
    monster("rocket climbs from the source's untranslated base Z", rocket, [source, actor(possessed, 118, 4, { z: 55 })]),
    monster("rocket falls toward a lower target and rounds negative Z half-steps", rocket,
        [source, actor(possessed, 141, 4, { z: -51 - 1 / unit })]),
    monster("cacodemon fireball uses two shadow draws after allocation", cacoBall,
        [actor(cacodemon, 0, 4), actor(player, 130, -52, { flags: solid | shootable | shadow })], { randomIndex: 77 }),
    monster("very close target clamps missile travel time to one", impBall,
        [source, actor(possessed, 6, 4, { z: 11 + 1 / unit, flags: 0 })]),
    monster("coincident target uses an eastward angle and a one-tic divisor", impBall,
        [source, actor(possessed, 0, 4, { z: 10, flags: 0 })]),
    monster("baron fireball at Nightmare difficulty", baronBall,
        [actor(baron, -12, 16), actor(player, 148, 100, { z: 92 })], { skill: 4, fast: true }),
    monster("fast imp fireball climbs at its accelerated speed", impBall,
        [source, actor(player, 116, 62, { z: 88 })], { fast: true }),
    monster("fast cacodemon fireball descends at its accelerated speed", cacoBall,
        [actor(cacodemon, 0, 4, { z: 100 }), actor(player, 124, -44, { z: 16 })], { fast: true }),
    monster("fast mode preserves arachnotron plasma speed", spiderPlasma, [source, actor(player, 125, 30)], { fast: true }),
    playerShot("rocket autoaim straight", rocket, [shooter, actor(possessed, 130, 4, { z: 28 })],
        { expectedAim: 2, expectedHeading: 0 }),
    playerShot("rocket autoaim selects the positive offset", rocket, [shooter, actor(player, 280, 31, { z: 16 })],
        { expectedAim: 2, expectedHeading: 1 << 26 }),
    playerShot("rocket autoaim selects the negative offset", rocket, [shooter, actor(player, 280, -24, { z: 16 })],
        { expectedAim: 2, expectedHeading: (-(1 << 26)) >>> 0 }),
    playerShot("rocket autoaim gives positive offset priority over negative offset", rocket,
        [shooter, actor(player, 160, -22, { z: 15 }), actor(player, 280, 31, { z: 16 })],
        { expectedAim: 3, expectedHeading: 1 << 26 }),
    playerShot("missed autoaim restores original heading and horizontal momentum plane", rocket,
        [shooter, actor(player, 280, 97)], { expectedAim: 0, expectedHeading: 0 }),
    playerShot("plasma launch has its own SeeSound and a quarter-turn heading", plasma,
        [actor(player, 4, 4, { slot: 0, angle: 0x40000000 }), actor(possessed, 4, 115)],
        { expectedAim: 2, expectedHeading: 0x40000000 }),
    playerShot("BFG projectile launches without an initial SeeSound", bfg, [shooter],
        { expectedAim: 0, expectedHeading: 0, expectedSound: 0 }),
    monster("first half-step damages the overlapping target before exploding", rocket,
        [source, actor(possessed, 15, 4)], { rollOnAction: true, expectedImpact: true }),
    monster("solid unshootable object stops the first half-step without damage", rocket,
        [source, actor(possessed, 13, 4, { flags: solid })], { expectedImpact: true }),
    monster("same-species target stops the missile without damage", impBall,
        [source, actor(imp, 16, 4)], { expectedImpact: true }),
    monster("knight and baron are treated as the same projectile species", baronBall,
        [actor(knight, 0, 4), actor(baron, 16, 4)], { expectedImpact: true }),
    monster("rocket explodes at its shifted coordinates against a one-sided wall", rocket,
        [source, actor(possessed, 154, 4)], { barrier: 1, expectedImpact: true }),
    monster("a low portal blocks an initial rocket launch", rocket, [source, actor(possessed, 154, 4)],
        { barrier: 2, expectedImpact: true }),
    monster("a sky portal on spawn explodes rather than silently removing the rocket", rocket,
        [source, actor(possessed, 154, 4)], { barrier: 3, expectedImpact: true }),
    monster("an exact-height portal accepts the half-step and updates ceiling clearance", rocket,
        [actor(imp, 0, 4, { z: -16 }), actor(possessed, 154, 4, { z: -16 })], { barrier: 2, expectedCeiling: 24 * unit }),
];
