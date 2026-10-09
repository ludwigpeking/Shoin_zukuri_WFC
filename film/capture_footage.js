// Captures the footage for the film from the running app: node capture_footage.js [shot names]
// Needs the app served (npx vite --port 5199 in the project folder) and Chrome. Each shot is a
// folder of numbered JPEG frames in footage/<shot>/, at 1920 x 1080.
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const PAGE_ADDRESS = "http://localhost:5199/?film";
const DEBUGGING_PORT = 9341;
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
// FILM_LANGUAGE=en shoots the English film's shots: planned in shots_en.json, kept in footage_en/
const FILM_LANGUAGE = process.env.FILM_LANGUAGE === "en" ? "en" : "zh";
const FOOTAGE_DIRECTORY = path.join(__dirname, FILM_LANGUAGE === "en" ? "footage_en" : "footage");
const MAP_CENTRE = [-3, 0, -3]; // the middle of the 11 x 11 square map
const LONG_LENS_DEGREES = 22;   // the camera's vertical angle of view
const LONG_LENS_DISTANCE = 150; // metres from the middle of the map
const LONG_LENS_HEIGHT = 44;    // metres: the eye about 16 degrees above the horizon
const CLOSE_LENS_DEGREES = 15;  // from the same distance, the map fills the frame

function wait(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

let socket = null;
let nextMessageId = 1;
const pendingReplies = new Map();
const consoleErrors = [];

function send(method, parameters) {
    const messageId = nextMessageId++;
    socket.send(JSON.stringify({ id: messageId, method: method, params: parameters || {} }));
    return new Promise(function (resolve, reject) { pendingReplies.set(messageId, { resolve: resolve, reject: reject }); });
}

async function evaluate(expression) {
    const reply = await send("Runtime.evaluate", { expression: expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) {
        throw new Error(expression.slice(0, 80) + ": " + (reply.exceptionDetails.exception ? reply.exceptionDetails.exception.description : reply.exceptionDetails.text));
    }
    return reply.result.value;
}

async function connect() {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const targets = await (await fetch("http://localhost:" + DEBUGGING_PORT + "/json")).json();
            const pageTarget = targets.find(function (target) { return target.type === "page"; });
            socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
            await new Promise(function (resolve, reject) { socket.onopen = resolve; socket.onerror = reject; });
            socket.onmessage = function (event) {
                const message = JSON.parse(event.data);
                if (message.id && pendingReplies.has(message.id)) {
                    const handlers = pendingReplies.get(message.id);
                    pendingReplies.delete(message.id);
                    if (message.error) { handlers.reject(new Error(message.error.message)); } else { handlers.resolve(message.result); }
                } else if (message.method === "Runtime.exceptionThrown") {
                    consoleErrors.push(message.params.exceptionDetails.exception ? message.params.exceptionDetails.exception.description : message.params.exceptionDetails.text);
                }
            };
            return;
        } catch (error) {
            await wait(250);
        }
    }
    throw new Error("could not reach Chrome");
}

async function saveFrame(shotName, frameIndex) {
    const reply = await send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    fs.writeFileSync(path.join(FOOTAGE_DIRECTORY, shotName, String(frameIndex).padStart(4, "0") + ".jpg"), Buffer.from(reply.data, "base64"));
}

function prepareShotDirectory(shotName) {
    const directory = path.join(FOOTAGE_DIRECTORY, shotName);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
}

// A camera on a circle round a target, at a height, turned by an angle in degrees
function orbitView(target, radius, height, angleDegrees) {
    const angle = angleDegrees * Math.PI / 180;
    return [target[0] + radius * Math.cos(angle), height, target[2] + radius * Math.sin(angle), target[0], target[1], target[2]];
}

// A camera at eye level outside the map, looking across it at the height of the verandas
function gardenView(radius, height, angleDegrees) {
    const camera = orbitView(MAP_CENTRE, radius, height, angleDegrees);
    return [camera[0], camera[1], camera[2], MAP_CENTRE[0], 2, MAP_CENTRE[2]];
}

async function loadPage() {
    await send("Page.navigate", { url: PAGE_ADDRESS });
    for (let attempt = 0; attempt < 80; attempt++) {
        await wait(250);
        const ready = await evaluate("Boolean(window.film) && document.getElementById('schemeInfo').textContent.length > 0").catch(function () { return false; });
        if (ready) { break; }
    }
    await wait(1500);
}

async function generate(seed, treesOn) {
    await evaluate("(function () { const trees = document.getElementById('treesCheckbox'); if (trees.checked !== " + treesOn + ") { trees.click(); } " +
        "document.getElementById('rows').value = 11; document.getElementById('cols').value = 11; document.getElementById('seedInput').value = '" + seed + "'; " +
        "document.getElementById('generateFromSettings').click(); return true; })()");
    await wait(800);
    await evaluate("film.hideInterface()");
}

async function waitForPathTracing(sampleCount, timeoutSeconds) {
    const started = Date.now();
    for (;;) {
        await wait(1000);
        const samples = await evaluate("film.pathTracedSamples()");
        if (samples >= sampleCount || Date.now() - started > timeoutSeconds * 1000) { return samples; }
    }
}

const SHOTS = {
    // the collapse of a rich map, cell by cell, the camera turning slowly
    collapse: async function () {
        await generate(280, true);
        const decidedCount = await evaluate("film.collapseLength()");
        const frameCount = 210;
        for (let frame = 0; frame < frameCount; frame++) {
            const shown = Math.round(decidedCount * Math.min(1, frame / (frameCount - 40)));
            await evaluate("film.showCollapseStep(" + shown + ")");
            await evaluate("film.view(" + orbitView(MAP_CENTRE, 66, 52, 120 + frame * 0.12).join(",") + ")");
            await wait(30);
            await saveFrame("collapse", frame);
        }
        await evaluate("film.showCollapseStep(100000)");
        return decidedCount + " decided cells";
    },
    // slow orbits round three rich maps, by day
    orbit_280: async function () { return orbitShot("orbit_280", 280, 62, 34, 200); },
    orbit_2: async function () { return orbitShot("orbit_2", 2, 58, 30, 30); },
    orbit_98: async function () { return orbitShot("orbit_98", 98, 54, 26, 300); },
    // the light from afternoon into night
    dusk: async function () {
        await generate(80, true);
        const frameCount = 210;
        for (let frame = 0; frame < frameCount; frame++) {
            await evaluate("film.setTimeOfDay(" + (15 + 7 * frame / (frameCount - 1)).toFixed(3) + ")");
            await evaluate("film.view(" + orbitView(MAP_CENTRE, 46, 20, 140 + frame * 0.06).join(",") + ")");
            await wait(30);
            await saveFrame("dusk", frame);
        }
        await evaluate("film.setTimeOfDay(12)");
        return frameCount + " frames";
    },
    // play mode on a flat field: a hall, a pavilion and a pond, one point at a time
    play: async function () {
        await generate(1, true);
        await evaluate("document.getElementById('flatField').click(); film.hideInterface()");
        const steps = [];
        for (let column = 2; column <= 7; column++) { steps.push([column, 3, 1]); }
        for (let column = 2; column <= 7; column++) { steps.push([column, 4, 1]); }
        for (const [column, row] of [[3, 7], [4, 7], [5, 7], [3, 8], [4, 8], [5, 8], [3, 9], [4, 9], [5, 9]]) { steps.push([column, row, 1]); }
        steps.push([4, 8, 2]);
        for (const [column, row] of [[8, 7], [9, 7], [8, 8], [9, 8], [8, 9], [9, 9]]) { steps.push([column, row, -1]); }
        let frame = 0;
        const refusals = [];
        const framesPerStep = 4;
        for (let stepIndex = 0; stepIndex <= steps.length; stepIndex++) {
            if (stepIndex > 0) {
                const step = steps[stepIndex - 1];
                const result = await evaluate("film.setPointLevels([" + JSON.stringify(step) + "])");
                if (result !== "ok") { refusals.push(step.join(",") + ": " + result); }
                await evaluate("film.hideInterface()");
            }
            for (let repeat = 0; repeat < framesPerStep; repeat++) {
                await evaluate("film.view(" + orbitView(MAP_CENTRE, 58, 46, 115 + frame * 0.15).join(",") + ")");
                await wait(30);
                await saveFrame("play", frame);
                frame++;
            }
        }
        for (let repeat = 0; repeat < 40; repeat++) {
            await evaluate("film.view(" + orbitView(MAP_CENTRE, 58, 46, 115 + frame * 0.15).join(",") + ")");
            await saveFrame("play", frame);
            frame++;
        }
        return frame + " frames; refused: " + (refusals.join(" | ") || "none");
    },
    // the hexagonal grid of quads: a generated map, turning
    hex: async function () {
        await evaluate("film.hideInterface(); document.getElementById('hexagonalMapButton').click(); true");
        await wait(4000);
        await evaluate("film.hideInterface()");
        for (let frame = 0; frame < 180; frame++) {
            await evaluate("film.view(" + orbitView([0, 0, 0], 66, 46, 200 + frame * 0.2).join(",") + ")");
            await wait(30);
            await saveFrame("hex", frame);
        }
        await evaluate("document.getElementById('squareMapButton').click(); true");
        await wait(2000);
        return "180 frames";
    },
    // every block of the palette on its own cell
    catalogue: async function () {
        await generate(1, false);
        await evaluate("document.getElementById('blockModeButton').click(); film.hideInterface()");
        await evaluate("film.showCatalogue([0, 1, 2, 3, 5, 6, 7, 9, 10, 14, 15, 16, 17, 18, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30])");
        await evaluate("film.hideInterface()");
        for (let frame = 0; frame < 180; frame++) {
            await evaluate("film.view(" + orbitView(MAP_CENTRE, 60, 40, 100 + frame * 0.2).join(",") + ")");
            await wait(30);
            await saveFrame("catalogue", frame);
        }
        await evaluate("document.getElementById('playModeButton').click(); true");
        return "180 frames";
    },
    // stills of many schemes to choose from by hand: the richest square maps of seeds 1 to 400 by
    // the entropy of their combinations, and hexagonal maps; variants/seeds.json lists them
    variants: async function () {
        await generate(1, true);
        const ranking = await evaluate("measureSchemeVariety(1, 400).slice(0, 60)");
        const listed = [];
        for (let rank = 0; rank < ranking.length; rank++) {
            await generate(ranking[rank].seed, true);
            await evaluate("film.view(" + orbitView(MAP_CENTRE, 60, 40, 135).join(",") + ")");
            await wait(250);
            await saveFrame("variants", rank);
            listed.push({ frame: rank, map: "square", seed: ranking[rank].seed, combinationBits: ranking[rank].combinationBits });
        }
        for (let hexSeed = 1; hexSeed <= 24; hexSeed++) {
            const information = await evaluate("film.startHexMap(" + hexSeed + ")");
            await wait(1500);
            await evaluate("film.hideInterface(); film.view(" + orbitView([0, 0, 0], 66, 46, 200).join(",") + ")");
            await wait(250);
            await saveFrame("variants", ranking.length + hexSeed - 1);
            listed.push({ frame: ranking.length + hexSeed - 1, map: "hexagonal", seed: hexSeed, information: information });
        }
        fs.writeFileSync(path.join(FOOTAGE_DIRECTORY, "variants", "seeds.json"), JSON.stringify(listed, null, 1));
        return listed.length + " schemes";
    },
    // the same schemes again from just above the roofs, from two opposite sides; the list comes
    // from variants_pick/seeds.json, kept from the variants shot
    variants_low: async function () {
        const listed = JSON.parse(fs.readFileSync(path.join(__dirname, "variants_pick", "entropy_ranked_seeds.json"), "utf8")).filter(function (item) { return item.map === "hexagonal"; });
        for (const item of listed) {
            const centre = item.map === "square" ? MAP_CENTRE : [0, 0, 0];
            if (item.map === "square") {
                await generate(item.seed, true);
            } else {
                await evaluate("film.startHexMap(" + item.seed + ")");
                await wait(1500);
                await evaluate("film.hideInterface()");
            }
            for (let side = 0; side < 2; side++) {
                const camera = orbitView(centre, LONG_LENS_DISTANCE, LONG_LENS_HEIGHT, 135 + side * 180);
                await evaluate("film.setFieldOfView(" + LONG_LENS_DEGREES + "); film.view(" + [camera[0], camera[1], camera[2], centre[0], 2, centre[2]].join(",") + ")");
                await wait(250);
                await saveFrame("variants_low", (item.seed - 1) * 2 + side);
            }
        }
        return listed.length + " schemes, two sides each";
    },
    // plain seeds, not ranked by anything, from just above the roofs and from two opposite sides:
    // frame = (seed - 1) * 2 + side
    variants_plain: async function () {
        const seedCount = 120;
        for (let seed = 1; seed <= seedCount; seed++) {
            await generate(seed, true);
            for (let side = 0; side < 2; side++) {
                // a long lens from far off: little distortion, the eye still only a little above the roofs
                const camera = orbitView(MAP_CENTRE, LONG_LENS_DISTANCE, LONG_LENS_HEIGHT, 135 + side * 180);
                await evaluate("film.setFieldOfView(" + LONG_LENS_DEGREES + "); film.view(" + [camera[0], camera[1], camera[2], MAP_CENTRE[0], 2, MAP_CENTRE[2]].join(",") + ")");
                await wait(200);
                await saveFrame("variants_plain", (seed - 1) * 2 + side);
            }
        }
        return seedCount + " seeds, two sides each";
    },
    // every view kept with "Keep view" in the app (kept_views.json), restored and shot as a still
    kept_stills: async function () {
        const keptViews = JSON.parse(fs.readFileSync(path.join(__dirname, "kept_views.json"), "utf8"));
        for (const keptView of keptViews) {
            await restoreKeptViewForFilm(keptView);
            await evaluate("film.hideInterface()");
            await wait(1200);
            await saveFrame("kept_stills", keptView.number);
        }
        return keptViews.length + " kept views";
    },
    // a check of the interface for designing a large hexagonal map by hand: the size slider, the
    // flat field and a raised point, with the interface in the picture
    interface_check: async function () {
        await evaluate("document.getElementById('hexagonalMapButton').click(); true");
        await wait(2500);
        await evaluate("(function () { const slider = document.getElementById('hexRingCountSlider'); slider.value = 6; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change')); return true; })()");
        await wait(4000);
        await evaluate("document.getElementById('flatField').click(); true");
        await wait(2000);
        const result = await evaluate("film.setHexPointLevels([[40, 1], [41, 1], [60, -1]])");
        await evaluate("film.view(-120, 110, 150, 0, 0, 0)");
        await wait(800);
        await saveFrame("interface_check", 0);
        return result + "; " + await evaluate("document.getElementById('schemeInfo').textContent");
    },
    // the pit (two valley corners facing each other) from several sides, to choose the view that shows it
    pit_views: async function () {
        await generate(1, false);
        const middle = [-3, -3];
        const leftTurn = await evaluate("film.findOrientation(22, 1, '23C')");
        const rightTurn = await evaluate("film.findOrientation(22, 3, 'C32')");
        await evaluate("film.showBlocks([[4, 5, 22, " + leftTurn[0] + ", " + leftTurn[1] + "], [5, 5, 22, " + rightTurn[0] + ", " + rightTurn[1] + "]])");
        let viewIndex = 0;
        for (const elevation of [28, 45]) {
            for (const azimuth of [62, 152, 242, 332]) {
                await evaluate("film.diagramStyle(); film.showConflictWalls(0.3); film.hideInterface(); film.parallelView(" + (middle[0] - 3) + ", 3, " + middle[1] + ", " + azimuth + ", " + elevation + ", 17)");
                await wait(500);
                await saveFrame("pit_views", viewIndex);
                viewIndex++;
            }
        }
        return viewIndex + " views";
    },
    // a look at the larger scene from two sides and from above, to judge its layout
    large_test: async function () {
        const report = await buildLargeScene();
        const views = [
            orbitView([0, 2, 0], LARGE_VIEW.distance, LARGE_VIEW.height, LARGE_VIEW.startAngleDegrees),
            orbitView([0, 2, 0], LARGE_VIEW.distance, LARGE_VIEW.height, LARGE_VIEW.startAngleDegrees + 40),
            orbitView([0, 2, 0], 1, 420, 90)];
        for (let viewIndex = 0; viewIndex < views.length; viewIndex++) {
            await evaluate("film.setFieldOfView(" + LARGE_VIEW.angleOfViewDegrees + "); film.view(" + views[viewIndex].join(",") + ")");
            await wait(600);
            await saveFrame("large_test", viewIndex);
        }
        await evaluate("film.setTimeOfDay(19.4); film.view(" + views[1].join(",") + ")");
        await wait(600);
        await saveFrame("large_test", 3);
        return report;
    },
    // Diagram stills made of the real blocks: alone on white, from far off with a very long lens
    // (parallel lines, an isometric look). footage/diagrams/<name>.jpg
    diagrams: async function () {
        const directory = path.join(FOOTAGE_DIRECTORY, "diagrams");
        const saveStill = async function (name) {
            await evaluate("film.hideInterface()");
            await wait(700);
            const reply = await send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
            fs.writeFileSync(path.join(directory, name + ".jpg"), Buffer.from(reply.data, "base64"));
        };
        const cellCentre = function (column, row) { return [column * 6 - 33, row * 6 - 33]; };
        const report = [];
        await generate(1, false);
        await evaluate("film.diagramStyle()");

        // two blocks whose facing edges agree, apart and joined
        const middle = cellCentre(5, 5);
        await evaluate("film.showBlocks([[5, 4, 6, 0, 0], [5, 6, 6, 0, 0]])");
        await evaluate("film.diagramStyle(); film.parallelView(" + middle[0] + ", 3, " + middle[1] + ", 28, 28, 19)");
        await saveStill("pair_apart");
        await evaluate("film.showBlocks([[5, 4, 6, 0, 0], [5, 5, 6, 0, 0]])");
        await evaluate("film.diagramStyle(); film.parallelView(" + middle[0] + ", 3, " + (middle[1] - 3) + ", 28, 28, 19)");
        await saveStill("pair_joined");

        // pairs of different blocks that join: apart (one cell between them) and joined, at one scale
        const JOINING_PAIRS = [[7, 9], [7, 6], [6, 18], [14, 16]];
        for (let pairIndex = 0; pairIndex < JOINING_PAIRS.length; pairIndex++) {
            const pair = JOINING_PAIRS[pairIndex];
            const turns = await evaluate("film.joinOrientations(" + pair[0] + ", " + pair[1] + ")");
            for (const arrangement of [["apart", 6], ["joined", 5]]) {
                const conflicts = await evaluate("film.showBlocks([[4, 5, " + pair[0] + ", " + turns[0] + ", " + turns[1] + "], [" + arrangement[1] + ", 5, " + pair[1] + ", " + turns[2] + ", " + turns[3] + "]])");
                await evaluate("film.diagramStyle(); film.parallelView(" + (middle[0] - 3) + ", 4, " + middle[1] + ", 62, 28, 24)");
                await saveStill("join_" + (pairIndex + 1) + "_" + arrangement[0]);
                if (conflicts > 0) { report.push("pair " + pair.join("+") + " conflicts " + conflicts); }
            }
        }

        // two roofs sloping down into each other: a gutter, marked by the red wall
        report.push("gutter conflicts " + await evaluate("film.showBlocks([[4, 5, 6, 0, 0], [5, 5, 6, 0, 0]])"));
        await evaluate("film.diagramStyle(); film.showConflictWalls(0.3); film.parallelView(" + (middle[0] - 3) + ", 3, " + middle[1] + ", 62, 28, 17)");
        await saveStill("gutter");

        // the general case of edges that do not agree: a veranda's sloping edge (0 1 2) against the
        // gable side of a main roof (2 3 2); the heights differ, so the red wall stands between them
        const verandaTurn = await evaluate("film.findOrientation(9, 1, '012') || film.findOrientation(9, 1, '210')");
        const roofTurn = await evaluate("film.findOrientation(6, 3, '232')");
        report.push("mismatch conflicts " + await evaluate("film.showBlocks([[4, 5, 9, " + verandaTurn[0] + ", " + verandaTurn[1] + "], [5, 5, 6, " + roofTurn[0] + ", " + roofTurn[1] + "]])"));
        await evaluate("film.diagramStyle(); film.showConflictWalls(0.3); film.parallelView(" + (middle[0] - 3) + ", 4, " + middle[1] + ", 62, 28, 20)");
        await saveStill("mismatch");

        // two valley corners facing each other: a pit
        const leftTurn = await evaluate("film.findOrientation(22, 1, '23C')");
        const rightTurn = await evaluate("film.findOrientation(22, 3, 'C32')");
        report.push("pit conflicts " + await evaluate("film.showBlocks([[4, 5, 22, " + leftTurn[0] + ", " + leftTurn[1] + "], [5, 5, 22, " + rightTurn[0] + ", " + rightTurn[1] + "]])"));
        // from the side the two valleys run down towards, and from higher up, so that the pit where they meet shows
        await evaluate("film.diagramStyle(); film.showConflictWalls(0.16); film.parallelView(" + (middle[0] - 3) + ", 3, " + middle[1] + ", 242, 45, 17)");
        await saveStill("pit");

        // an L-shaped hall from play mode: ridges meet, the eaves turn the corner
        await loadPage();
        await generate(1, false);
        await evaluate("document.getElementById('flatField').click(); true");
        const hallPoints = [];
        for (let column = 3; column <= 7; column++) { hallPoints.push([column, 4, 1], [column, 5, 1]); }
        for (let row = 6; row <= 8; row++) { hallPoints.push([6, row, 1], [7, row, 1]); }
        report.push("hall " + await evaluate("film.setPointLevels(" + JSON.stringify(hallPoints) + ")"));
        await evaluate("film.removeOpenGround(); film.diagramStyle(); film.parallelView(" + cellCentre(5, 6)[0] + ", 3, " + cellCentre(5, 6)[1] + ", 215, 30, 36)");
        await saveStill("joint_hall");

        // the three grids seen from straight above, each with a scheme on it (the kept views' maps)
        const keptViews = JSON.parse(fs.readFileSync(path.join(__dirname, "kept_views.json"), "utf8"));
        for (const mapKind of ["square", "bent", "hexagonal"]) {
            const keptView = keptViews.find(function (candidate) { return candidate.mapKind === mapKind; });
            await loadPage();
            await evaluate("film.restoreKeptView(" + JSON.stringify(keptView) + ")");
            const centre = mapKind === "square" ? MAP_CENTRE : [0, 0, 0];
            await evaluate("film.setTimeOfDay(12); film.diagramStyle(); film.parallelView(" + centre[0] + ", 0, " + centre[2] + ", 90, 89.6, 84)");
            await saveStill("grid_" + mapKind);
        }
        return report.join("; ");
    },
    // The film's own shots, as planned in shots.json (node make_film.js --shots): each shot gets
    // exactly the frames the film shows, from the view kept for it (kept_views.json), or from a
    // stand-in view when none was kept. FILM_SHOTS=result_1,bent_1 shoots only those again.
    film: async function () {
        const plannedShots = JSON.parse(fs.readFileSync(path.join(__dirname, FILM_LANGUAGE === "en" ? "shots_en.json" : "shots.json"), "utf8"));
        const keptViewsPath = path.join(__dirname, "kept_views.json");
        const keptViews = fs.existsSync(keptViewsPath) ? JSON.parse(fs.readFileSync(keptViewsPath, "utf8")) : [];
        const onlyShots = process.env.FILM_SHOTS ? process.env.FILM_SHOTS.split(",") : null;
        const skippedShots = process.env.FILM_SKIP ? process.env.FILM_SKIP.split(",") : [];
        const report = [];
        for (const plannedShot of plannedShots) {
            if ((onlyShots && !onlyShots.includes(plannedShot.shot)) || skippedShots.includes(plannedShot.shot)) { continue; }
            const started = Date.now();
            prepareShotDirectory(plannedShot.shot);
            await loadPage();
            await FILM_SHOT_KINDS[plannedShot.kind](plannedShot, keptViews.find(function (keptView) { return keptView.number === plannedShot.keptViewNumber; }) || null, plannedShots);
            report.push(plannedShot.shot + " " + plannedShot.frameCount + " frames, " + Math.round((Date.now() - started) / 1000) + " s");
            console.log(report[report.length - 1]);
        }
        return report.length + " shots";
    },
    // candidate camera views for the path traced stills, in the normal view, to choose from
    viewtest: async function () {
        await generate(280, true);
        let candidateIndex = 0;
        for (const ring of [[38, 5, 2], [28, 11, 1]]) {
            for (let angleDegrees = 0; angleDegrees < 360; angleDegrees += 45) {
                const camera = orbitView(MAP_CENTRE, ring[0], ring[1], angleDegrees);
                await evaluate("film.view(" + [camera[0], camera[1], camera[2], MAP_CENTRE[0], ring[2], MAP_CENTRE[2]].join(",") + ")");
                await wait(300);
                await saveFrame("viewtest", candidateIndex);
                candidateIndex++;
            }
        }
        return candidateIndex + " views";
    },
    // path traced stills: day, dusk and night over a rich map, and close views
    traced: async function () {
        await generate(280, true);
        const stills = [
            ["day_high", 12, orbitView(MAP_CENTRE, 60, 40, 135)],
            // from the garden's edge, across the pond and the bridge (chosen from the viewtest shot)
            ["day_low", 10, gardenView(38, 5, 45)],
            ["dusk_low", 18.2, gardenView(38, 5, 45)],
            ["night_high", 21.5, orbitView(MAP_CENTRE, 52, 32, 135)],
            ["night_low", 21.5, gardenView(38, 5, 0)]
        ];
        await evaluate("document.getElementById('pathTracingCheckbox').click(); true");
        const sampleCounts = [];
        for (let stillIndex = 0; stillIndex < stills.length; stillIndex++) {
            const [name, hour, view] = stills[stillIndex];
            await evaluate("film.setTimeOfDay(" + hour + "); film.view(" + view.join(",") + ")");
            const samples = await waitForPathTracing(stillIndex === 0 ? 220 : 220, stillIndex === 0 ? 240 : 120);
            sampleCounts.push(name + " " + Math.floor(samples));
            await evaluate("film.hideInterface()");
            await saveFrame("traced", stillIndex);
        }
        await evaluate("document.getElementById('pathTracingCheckbox').click(); film.setTimeOfDay(12)");
        return sampleCounts.join(", ");
    }
};

// Width divided by height of a JPEG file, from its frame header
function jpegAspect(filePath) {
    const bytes = fs.readFileSync(filePath);
    let position = 2;
    while (position < bytes.length) {
        const marker = bytes[position + 1];
        const segmentLength = bytes.readUInt16BE(position + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return bytes.readUInt16BE(position + 7) / bytes.readUInt16BE(position + 5);
        }
        position += 2 + segmentLength;
    }
    throw new Error("no size found in " + filePath);
}

// Restores a kept view with the lens opened so that the film's 16:9 frame shows the same width as
// the window the view was kept in (a wider window would otherwise lose its left and right edges)
async function restoreKeptViewForFilm(keptView) {
    await evaluate("film.restoreKeptView(" + JSON.stringify(keptView) + ")");
    const keptAspect = jpegAspect(path.join(__dirname, "kept", String(keptView.number).padStart(2, "0") + ".jpg"));
    if (keptAspect > FRAME_WIDTH / FRAME_HEIGHT) {
        const keptHalfAngle = keptView.camera.angleOfViewDegrees * Math.PI / 360;
        const filmAngleDegrees = 2 * Math.atan(Math.tan(keptHalfAngle) * keptAspect / (FRAME_WIDTH / FRAME_HEIGHT)) * 180 / Math.PI;
        await evaluate("film.setFieldOfView(" + filmAngleDegrees.toFixed(3) + ")");
    }
}

// A larger scene on a hexagonal map of more rings, laid out by hand through the points like in
// play mode, to show a group of buildings rather than a single house:
// - water: a large pond in the middle and a second one to one side
// - deep halls: compact patches of raised points, two or three points across (a high ridge)
// - shallow wings: chains of single raised points that link the halls (a low ridge, half as deep),
//   so that the deep and the shallow buildings read apart
// - the rest stays open ground, where the trees stand
const LARGE_SCENE_RING_COUNT = 6;
const LARGE_SCENE_SEED = 7;
// places as [angle in degrees, distance from the middle as a share of the map's radius, radius in metres]
const LARGE_SCENE_PONDS = [[0, 0, 15], [205, 0.6, 13], [60, 0.78, 8]];
const LARGE_SCENE_HALLS = [[95, 0.42, 14], [335, 0.44, 14], [150, 0.68, 9.5], [25, 0.64, 9.5], [275, 0.62, 14], [158, 0.27, 8]];
// which halls a shallow wing links (indices of LARGE_SCENE_HALLS)
const LARGE_SCENE_WINGS = [[0, 3], [0, 2], [1, 3], [1, 4], [2, 5], [0, 5]];
async function buildLargeScene() {
    await evaluate("film.setHexRingCount(" + LARGE_SCENE_RING_COUNT + "); film.startQuadMap('hexagonal', " + LARGE_SCENE_SEED + ")");
    await wait(3000);
    await evaluate("if (!document.getElementById('playModeButton').classList.contains('active')) { document.getElementById('playModeButton').click(); } document.getElementById('flatField').click(); true");
    await wait(1500);
    const points = (await evaluate("film.hexPoints()")).map(function (point, pointIndex) {
        return { index: pointIndex, x: point[0], z: point[1], isOnBoundary: point[2] === 1 };
    });
    const cellCorners = await evaluate("film.hexCellCorners()");
    const mapRadius = Math.max.apply(null, points.map(function (point) { return Math.hypot(point.x, point.z); }));
    const neighboursOfPoint = points.map(function () { return new Set(); });
    cellCorners.forEach(function (corners) {
        corners.forEach(function (pointIndex, cornerIndex) {
            const nextPoint = corners[(cornerIndex + 1) % 4];
            neighboursOfPoint[pointIndex].add(nextPoint);
            neighboursOfPoint[nextPoint].add(pointIndex);
        });
    });
    const placeCentre = function (place) {
        const angle = place[0] * Math.PI / 180;
        return { x: place[1] * mapRadius * Math.cos(angle), z: place[1] * mapRadius * Math.sin(angle), radius: place[2] };
    };
    const pointsOfPlace = function (place) {
        const centre = placeCentre(place);
        return points.filter(function (point) {
            return !point.isOnBoundary && Math.hypot(point.x - centre.x, point.z - centre.z) <= centre.radius;
        });
    };
    const wantedLevel = new Map(); // point index -> level
    LARGE_SCENE_PONDS.forEach(function (pond) {
        pointsOfPlace(pond).forEach(function (point) { wantedLevel.set(point.index, -1); });
    });
    // a point next to water stays ground, so that the shores stay open
    const isNearWater = function (pointIndex) {
        return wantedLevel.get(pointIndex) === -1 || Array.from(neighboursOfPoint[pointIndex]).some(function (other) { return wantedLevel.get(other) === -1; });
    };
    const hallPoints = LARGE_SCENE_HALLS.map(function (hall) {
        return pointsOfPlace(hall).filter(function (point) { return !isNearWater(point.index); });
    });
    hallPoints.forEach(function (hall) {
        hall.forEach(function (point) { wantedLevel.set(point.index, 1); });
    });
    // a wing: the shortest chain of points from one hall to another, round the water and clear of
    // the other halls and wings (two chains side by side would make a deep building of them)
    const isTaken = function (pointIndex) {
        return wantedLevel.has(pointIndex) || Array.from(neighboursOfPoint[pointIndex]).some(function (other) { return wantedLevel.get(other) === 1; });
    };
    const wingPointCounts = [];
    LARGE_SCENE_WINGS.forEach(function (wing) {
        const fromHall = new Set(hallPoints[wing[0]].map(function (point) { return point.index; }));
        const toHall = new Set(hallPoints[wing[1]].map(function (point) { return point.index; }));
        const cameFrom = new Map();
        const queue = [];
        fromHall.forEach(function (pointIndex) { cameFrom.set(pointIndex, -1); queue.push(pointIndex); });
        let reached = -1;
        while (queue.length > 0 && reached < 0) {
            const pointIndex = queue.shift();
            for (const other of neighboursOfPoint[pointIndex]) {
                if (cameFrom.has(other) || points[other].isOnBoundary || isNearWater(other)) { continue; }
                // the chain may touch only the two halls it links
                const touchesOtherBuilding = !toHall.has(other) && Array.from(neighboursOfPoint[other]).some(function (near) {
                    return wantedLevel.get(near) === 1 && !fromHall.has(near) && !toHall.has(near) && near !== pointIndex && cameFrom.get(pointIndex) !== near;
                });
                if (touchesOtherBuilding || (wantedLevel.get(other) === 1 && !toHall.has(other))) { continue; }
                cameFrom.set(other, pointIndex);
                if (toHall.has(other)) { reached = other; break; }
                queue.push(other);
            }
        }
        let chainLength = 0;
        for (let pointIndex = reached; pointIndex >= 0 && !fromHall.has(pointIndex); pointIndex = cameFrom.get(pointIndex)) {
            if (!toHall.has(pointIndex)) { wantedLevel.set(pointIndex, 1); chainLength++; }
        }
        wingPointCounts.push(reached < 0 ? "none" : chainLength);
    });
    // one point after the other, like clicks: the water first, then the buildings from the middle
    // outwards; a point that no block fits is left as it was
    const ordered = Array.from(wantedLevel.entries()).sort(function (first, second) {
        const firstRadius = Math.hypot(points[first[0]].x, points[first[0]].z), secondRadius = Math.hypot(points[second[0]].x, points[second[0]].z);
        return (first[1] - second[1]) || (firstRadius - secondRadius);
    });
    let refusedCount = 0;
    for (const entry of ordered) {
        const result = await evaluate("film.setHexPointLevels([[" + entry[0] + ", " + entry[1] + "]])");
        if (result !== "ok") { refusedCount++; }
    }
    // pavilions where a point stands in the middle of a hall, well apart from each other
    const pavilionCount = await evaluate("film.raiseSurroundedHexPoints(3, 45)");
    await evaluate("film.hideInterface()");
    return points.length + " points, " + ordered.length + " shaped, " + refusedCount + " refused, wings " + wingPointCounts.join("/") + ", " + pavilionCount + " pavilions";
}

// The view a shot starts from: the kept one, restored, or a stand-in of the same kind of map from
// far off with a long lens. Returns the view as the page describes it (its camera is used).
async function showShotView(plannedShot, keptView) {
    if (keptView) {
        await restoreKeptViewForFilm(keptView);
    } else if (plannedShot.mapKind === "bent" || plannedShot.mapKind === "hexagonal") {
        await evaluate("film.startQuadMap('" + plannedShot.mapKind + "', 7)");
        await wait(2500);
        await evaluate("film.setFieldOfView(" + LONG_LENS_DEGREES + "); film.view(" + orbitView([0, 2, 0], LONG_LENS_DISTANCE, LONG_LENS_HEIGHT, 135).join(",") + ")");
    } else {
        await generate(280, true);
        await evaluate("film.setFieldOfView(" + LONG_LENS_DEGREES + "); film.view(" + orbitView([MAP_CENTRE[0], 2, MAP_CENTRE[2]], LONG_LENS_DISTANCE, LONG_LENS_HEIGHT, 135).join(",") + ")");
    }
    await wait(1200);
    await evaluate("film.hideInterface()");
    return await evaluate("film.describeView()");
}

// The camera of a view, turned about the vertical through its target by an angle in degrees
function turnedCamera(viewCamera, angleDegrees) {
    const angle = angleDegrees * Math.PI / 180;
    const offsetX = viewCamera.position[0] - viewCamera.target[0];
    const offsetZ = viewCamera.position[2] - viewCamera.target[2];
    return [
        viewCamera.target[0] + offsetX * Math.cos(angle) - offsetZ * Math.sin(angle), viewCamera.position[1],
        viewCamera.target[2] + offsetX * Math.sin(angle) + offsetZ * Math.cos(angle),
        viewCamera.target[0], viewCamera.target[1], viewCamera.target[2]];
}

// A slow arc that passes through the kept viewpoint in the middle of the shot
const ARC_DEGREES_PER_SECOND = 1.2;
const LARGEST_ARC_DEGREES = 24;
function arcAngle(frame, frameCount) {
    const arcDegrees = Math.min(LARGEST_ARC_DEGREES, ARC_DEGREES_PER_SECOND * frameCount / 30);
    return arcDegrees * (frame / (frameCount - 1) - 0.5);
}

// The larger scene is seen in one slow turn: by day, on into the evening, and then held at night.
// The angle at each frame of the day shot and of the evening shot that follows it (they overlap
// by the length of a fade, so the evening starts where the day is at that moment).
const LARGE_VIEW = { distance: 250, height: 78, angleOfViewDegrees: 19.5, startAngleDegrees: 205, degreesPerFrame: 0.04 };
const SHOT_OVERLAP_FRAMES = 21;
function largeSceneAngle(shotName, frame, plannedShots) {
    const dayFrameCount = plannedShots.find(function (candidate) { return candidate.shot === "large_day"; }).frameCount;
    const duskFrameCount = plannedShots.find(function (candidate) { return candidate.shot === "large_dusk"; }).frameCount;
    const framesBefore = shotName === "large_day" ? 0 : dayFrameCount - SHOT_OVERLAP_FRAMES;
    const frameInTurn = shotName === "large_night" ? dayFrameCount - SHOT_OVERLAP_FRAMES + duskFrameCount - 1 : framesBefore + frame;
    return LARGE_VIEW.startAngleDegrees + LARGE_VIEW.degreesPerFrame * frameInTurn;
}
function largeSceneView(shotName, frame, plannedShots) {
    return orbitView([0, 2, 0], LARGE_VIEW.distance, LARGE_VIEW.height, largeSceneAngle(shotName, frame, plannedShots));
}
// Shows the large scene and returns the camera for a frame of one of its shots. With a kept view
// (the scene designed by hand) the turn passes through the kept viewpoint at the end of the day
// shot, with the kept lens; without one, the stand-in scene is built and seen from LARGE_VIEW.
async function showLargeScene(keptView) {
    if (!keptView) {
        await buildLargeScene();
        await evaluate("film.setFieldOfView(" + LARGE_VIEW.angleOfViewDegrees + ")");
        return null;
    }
    await restoreKeptViewForFilm(keptView);
    await wait(1500);
    await evaluate("film.hideInterface()");
    return (await evaluate("film.describeView()")).camera;
}
function largeSceneCamera(keptCamera, shotName, frame, plannedShots) {
    if (!keptCamera) {
        return largeSceneView(shotName, frame, plannedShots);
    }
    const dayFrameCount = plannedShots.find(function (candidate) { return candidate.shot === "large_day"; }).frameCount;
    const angleAtKeptView = largeSceneAngle("large_day", dayFrameCount - 1, plannedShots);
    return turnedCamera(keptCamera, largeSceneAngle(shotName, frame, plannedShots) - angleAtKeptView);
}
const DUSK_START_HOURS = 15;
const DUSK_END_HOURS = 19.6;
const NIGHT_HOURS = 21.5;
const NIGHT_SAMPLE_COUNT = 450;

const FILM_SHOT_KINDS = {
    large_orbit: async function (plannedShot, keptView, plannedShots) {
        const keptCamera = await showLargeScene(keptView);
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            await evaluate("film.view(" + largeSceneCamera(keptCamera, "large_day", frame, plannedShots).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
    },
    large_dusk: async function (plannedShot, keptView, plannedShots) {
        const keptCamera = await showLargeScene(keptView);
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            const hour = DUSK_START_HOURS + (DUSK_END_HOURS - DUSK_START_HOURS) * frame / (plannedShot.frameCount - 1);
            await evaluate("film.setTimeOfDay(" + hour.toFixed(4) + "); film.view(" + largeSceneCamera(keptCamera, "large_dusk", frame, plannedShots).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
        await evaluate("film.setTimeOfDay(12)");
    },
    // one picture of the night, path traced, from where the evening shot ends
    large_night: async function (plannedShot, keptView, plannedShots) {
        const keptCamera = await showLargeScene(keptView);
        await evaluate("film.setTimeOfDay(" + NIGHT_HOURS + "); film.view(" + largeSceneCamera(keptCamera, "large_night", 0, plannedShots).join(",") + ")");
        await evaluate("document.getElementById('pathTracingCheckbox').click(); true");
        const samples = await waitForPathTracing(NIGHT_SAMPLE_COUNT, 600);
        await evaluate("film.hideInterface()");
        await saveFrame(plannedShot.shot, 0);
        console.log("large_night: " + Math.floor(samples) + " samples");
        await evaluate("document.getElementById('pathTracingCheckbox').click(); film.setTimeOfDay(12)");
    },
    orbit: async function (plannedShot, keptView) {
        const view = await showShotView(plannedShot, keptView);
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            await evaluate("film.view(" + turnedCamera(view.camera, arcAngle(frame, plannedShot.frameCount)).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
    },
    // the map appears cell by cell in the order the collapse decided, then stands complete
    collapse: async function (plannedShot, keptView) {
        const view = await showShotView(plannedShot, keptView);
        const decidedCount = await evaluate("film.collapseLength()");
        const growingFrameCount = Math.round(plannedShot.frameCount * 0.85);
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            await evaluate("film.showCollapseStep(" + Math.round(decidedCount * Math.min(1, frame / growingFrameCount)) + ")");
            await evaluate("film.view(" + turnedCamera(view.camera, arcAngle(frame, plannedShot.frameCount)).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
        await evaluate("film.showCollapseStep(100000)");
    },
    // the light from afternoon into night
    dusk: async function (plannedShot, keptView) {
        const view = await showShotView(plannedShot, keptView);
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            await evaluate("film.setTimeOfDay(" + (15 + 6.5 * frame / (plannedShot.frameCount - 1)).toFixed(4) + ")");
            await evaluate("film.view(" + turnedCamera(view.camera, arcAngle(frame, plannedShot.frameCount)).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
        await evaluate("film.setTimeOfDay(12)");
    },
    // every kind of block on its own cell, turning
    catalogue: async function (plannedShot) {
        await generate(1, false);
        await evaluate("document.getElementById('blockModeButton').click(); film.hideInterface()");
        await evaluate("film.showCatalogue([0, 1, 2, 3, 5, 6, 7, 9, 10, 14, 15, 16, 17, 18, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30])");
        await evaluate("film.hideInterface(); film.setFieldOfView(" + (CLOSE_LENS_DEGREES + 4) + ")"); // room for the corners as the map turns
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            await evaluate("film.view(" + orbitView([MAP_CENTRE[0], 2, MAP_CENTRE[2]], LONG_LENS_DISTANCE, 60, 100 + 40 * frame / plannedShot.frameCount).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
    },
    // play mode on a flat field: a hall, a pavilion and a pond, one point at a time
    play: async function (plannedShot) {
        await generate(1, true);
        await evaluate("document.getElementById('flatField').click(); film.hideInterface(); film.setFieldOfView(" + CLOSE_LENS_DEGREES + ")");
        const steps = [];
        for (let column = 2; column <= 7; column++) { steps.push([column, 3, 1]); }
        for (let column = 2; column <= 7; column++) { steps.push([column, 4, 1]); }
        for (const [column, row] of [[3, 7], [4, 7], [5, 7], [3, 8], [4, 8], [5, 8], [3, 9], [4, 9], [5, 9]]) { steps.push([column, row, 1]); }
        steps.push([4, 8, 2]);
        for (const [column, row] of [[8, 7], [9, 7], [8, 8], [9, 8], [8, 9], [9, 9]]) { steps.push([column, row, -1]); }
        const buildingFrameCount = Math.round(plannedShot.frameCount * 0.8);
        let stepsDone = 0;
        for (let frame = 0; frame < plannedShot.frameCount; frame++) {
            const stepsDue = Math.min(steps.length, Math.floor((steps.length + 1) * frame / buildingFrameCount));
            while (stepsDone < stepsDue) {
                await evaluate("film.setPointLevels([" + JSON.stringify(steps[stepsDone]) + "])");
                await evaluate("film.hideInterface()");
                stepsDone++;
            }
            await evaluate("film.view(" + orbitView([MAP_CENTRE[0], 2, MAP_CENTRE[2]], LONG_LENS_DISTANCE, 70, 115 + 24 * frame / plannedShot.frameCount).join(",") + ")");
            await wait(25);
            await saveFrame(plannedShot.shot, frame);
        }
    }
};

async function orbitShot(shotName, seed, radius, height, startAngle) {
    await generate(seed, true);
    for (let frame = 0; frame < 180; frame++) {
        await evaluate("film.view(" + orbitView(MAP_CENTRE, radius, height, startAngle + frame * 0.15).join(",") + ")");
        await wait(30);
        await saveFrame(shotName, frame);
    }
    return "180 frames";
}

async function main() {
    const requested = process.argv.slice(2);
    const shotNames = requested.length > 0 ? requested : Object.keys(SHOTS);
    const chromePath = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe";
    const browser = childProcess.spawn(chromePath, [
        "--headless=new", "--remote-debugging-port=" + DEBUGGING_PORT, "--window-size=" + FRAME_WIDTH + "," + FRAME_HEIGHT,
        "--user-data-dir=" + path.join(require("os").tmpdir(), "shoin-zukuri-film-chrome"), "--ignore-gpu-blocklist", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
    try {
        await connect();
        await send("Page.enable");
        await send("Runtime.enable");
        await send("Emulation.setDeviceMetricsOverride", { width: FRAME_WIDTH, height: FRAME_HEIGHT, deviceScaleFactor: 1, mobile: false });
        for (const shotName of shotNames) {
            prepareShotDirectory(shotName);
            await loadPage();
            const started = Date.now();
            const report = await SHOTS[shotName]();
            console.log(shotName + ": " + report + " (" + Math.round((Date.now() - started) / 1000) + " s)");
        }
        if (consoleErrors.length > 0) { console.log("page errors:\n" + consoleErrors.slice(0, 5).join("\n")); }
    } finally {
        browser.kill();
    }
    process.exit(0);
}

main().catch(function (error) {
    console.error(error);
    process.exit(1);
});
