// Renders the documentary film: node make_film.js
//   --language en         the English film: English narration (voice_en/), English labels and subtitles,
//                         its own shots (shots_en.json, footage_en/); default zh
//   --shots               write shots.json: the footage shots and their lengths, for capture_footage.js
//   --cover               write the cover pictures (Chinese and English)
//   --preview 3.5,12,40   write single frames (JPEG) at these times instead of the film
//   --output name.mp4     output file name (default: Shoin_Zukuri_WFC.mp4)
// Needs ffmpeg on the PATH, the narration clips in voice/ (made from narration.json), the footage
// in footage/ (node capture_footage.js) and the two sketches in photos/.
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const FRAMES_PER_SECOND = 30;
const LINE_GAP_SECONDS = 0.5;
const SCENE_LEAD_SECONDS = 0.9;
const SCENE_TAIL_SECONDS = 1.0;

const COLOUR = {
    background: "#14181d", panel: "#1e252e", line: "#34404e", text: "#e9ecef", muted: "#9aa6b4",
    accent: "#d9a441", blue: "#8ec5ff", bad: "#f87171", good: "#7bd389", paper: "#f4f1ea",
    water: "#4f7a96", ground: "#8a9a52", roof: "#7d8a8c", ridge: "#b9c4c6"
};

// The fonts are Windows fonts; a copy in fonts/ beside this file is used first, so that the film
// can also be rendered on the Mac (see render_on_mac.sh)
function fontPath(fileName) {
    const localCopy = path.join(__dirname, "fonts", fileName);
    return fs.existsSync(localCopy) ? localCopy : "C:/Windows/Fonts/" + fileName;
}
GlobalFonts.registerFromPath(fontPath("msyh.ttc"), "YaHei");
GlobalFonts.registerFromPath(fontPath("msyhbd.ttc"), "YaHeiBold");
GlobalFonts.registerFromPath(fontPath("consola.ttf"), "Consolas");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The language of the film: "zh" (Chinese narration, Chinese and English subtitles and labels) or
// "en" (English narration, English only). Set from --language in main.
let LANGUAGE = "zh";
function byLanguage(chinese, english) {
    return LANGUAGE === "en" ? english : chinese;
}
// What is left of a label in the English film: its Chinese taken out. Empty when nothing with
// letters is left.
const CHINESE_CHARACTERS = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef《》]/;
function englishOnly(text) {
    const stripped = text.replace(new RegExp(CHINESE_CHARACTERS.source, "g"), " ").replace(/\s+/g, " ").replace(/^[\s·:,→]+|[\s·:,→]+$/g, "").trim();
    return /[A-Za-z]/.test(stripped) ? stripped : "";
}
// In the English film a Chinese headline is not drawn; the English line that follows it (the
// small line under or beside it) takes its place, a little smaller than the headline was.
let skippedHeadline = null;
const PROMOTED_SIZE_SHARE = 0.72;
const HEADLINE_REACH = 110; // pixels: how far below the headline its English line may stand

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function ramp(time, startTime, durationSeconds) { return clamp01((time - startTime) / durationSeconds); }
function ease(value) { const x = clamp01(value); return x * x * (3 - 2 * x); }
function mix(from, to, amount) { return from + (to - from) * amount; }

// When, within its scene, the narration reaches a keyword (estimated from its place in the line)
const missingKeywords = new Set();
function cueTime(scene, lineIndex, keyword) {
    const line = scene.lines[lineIndex];
    const foundPosition = line.zh.indexOf(keyword);
    if (foundPosition < 0 && !missingKeywords.has(keyword)) {
        missingKeywords.add(keyword);
        console.warn("cue keyword not in narration line " + line.name + ": " + keyword);
    }
    return scene.lineStart[lineIndex] + line.durationSeconds * Math.max(0, foundPosition) / line.zh.length;
}

function drawText(context, text, x, y, size, colour, options) {
    if (LANGUAGE === "en") {
        if (CHINESE_CHARACTERS.test(text)) {
            const english = englishOnly(text);
            if (!english) {
                skippedHeadline = { x: x, y: y, size: size, colour: colour, options: options };
                return;
            }
            text = english;
            skippedHeadline = null;
        } else if (skippedHeadline) {
            const headline = skippedHeadline;
            skippedHeadline = null;
            if (Math.abs(y - headline.y) <= HEADLINE_REACH && size < headline.size) {
                x = headline.x;
                y = headline.y;
                size = Math.round(headline.size * PROMOTED_SIZE_SHARE);
                colour = headline.colour;
                options = Object.assign({}, options, { family: (headline.options || {}).family, align: (headline.options || {}).align });
            }
        }
    }
    const settings = options || {};
    const alpha = settings.alpha === undefined ? 1 : settings.alpha;
    if (alpha <= 0) { return; }
    context.save();
    context.globalAlpha *= alpha;
    context.font = size + "px " + (settings.family || "YaHei");
    context.textAlign = settings.align || "left";
    context.textBaseline = settings.baseline || "alphabetic";
    context.fillStyle = colour;
    if (settings.shadow) {
        // the canvas does not fade shadows with globalAlpha, so the shadow carries the fade itself
        context.shadowColor = "rgba(0,0,0," + (0.85 * context.globalAlpha).toFixed(3) + ")";
        context.shadowBlur = 14;
    }
    context.fillText(text, x, y);
    context.restore();
}

function strokeLine(context, x1, y1, x2, y2, colour, lineWidth) {
    context.strokeStyle = colour;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
}

function roundedRectangle(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
}

// A footage frame or a still, filling the frame (or a rectangle) and cropped to fit
function drawCover(context, image, alpha, zoom, rectangle) {
    if (!image || alpha <= 0) { return; }
    const area = rectangle || { x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT };
    const scale = Math.max(area.width / image.width, area.height / image.height) * (zoom || 1);
    const width = image.width * scale, height = image.height * scale;
    context.save();
    context.globalAlpha *= alpha;
    context.beginPath();
    context.rect(area.x, area.y, area.width, area.height);
    context.clip();
    context.drawImage(image, area.x + (area.width - width) / 2, area.y + (area.height - height) / 2, width, height);
    context.restore();
}

// A photograph on a paper mount, fitted inside a box, with a part of it chosen and a slow zoom
function drawPhotoCard(context, image, centreX, centreY, maximumWidth, maximumHeight, alpha, crop, zoom) {
    if (!image || alpha <= 0) { return; }
    const source = crop || { x: 0, y: 0, width: image.width, height: image.height };
    const scale = Math.min(maximumWidth / source.width, maximumHeight / source.height);
    const width = source.width * scale, height = source.height * scale;
    context.save();
    context.globalAlpha *= alpha;
    context.shadowColor = "rgba(0,0,0,0.6)";
    context.shadowBlur = 36;
    context.fillStyle = COLOUR.paper;
    context.fillRect(centreX - width / 2 - 10, centreY - height / 2 - 10, width + 20, height + 20);
    context.shadowBlur = 0;
    context.beginPath();
    context.rect(centreX - width / 2, centreY - height / 2, width, height);
    context.clip();
    const zoomFactor = zoom || 1;
    const zoomedWidth = source.width / zoomFactor, zoomedHeight = source.height / zoomFactor;
    context.drawImage(image, source.x + (source.width - zoomedWidth) / 2, source.y + (source.height - zoomedHeight) / 2, zoomedWidth, zoomedHeight,
        centreX - width / 2, centreY - height / 2, width, height);
    context.restore();
}

function darkenLeft(context, strength) {
    const gradient = context.createLinearGradient(0, 0, FRAME_WIDTH * 0.62, 0);
    gradient.addColorStop(0, "rgba(14,17,21," + strength + ")");
    gradient.addColorStop(0.55, "rgba(14,17,21," + (strength * 0.7).toFixed(3) + ")");
    gradient.addColorStop(1, "rgba(14,17,21,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
}

function drawBullet(context, x, y, chinese, english, alpha) {
    if (alpha <= 0) { return; }
    context.save();
    context.globalAlpha *= alpha;
    const offset = 18 * (1 - alpha);
    context.fillStyle = COLOUR.accent;
    context.fillRect(x, y - 44 + offset, 6, 62);
    drawText(context, chinese, x + 28, y - 8 + offset, 44, COLOUR.text, { family: "YaHeiBold", shadow: true });
    drawText(context, english, x + 28, y + 28 + offset, 25, COLOUR.muted, { shadow: true });
    context.restore();
}

// ---------------------------------------------------------------------------
// Footage: numbered frames of a shot, played over a stretch of a scene
// ---------------------------------------------------------------------------

// The stills (diagrams) are the same for both languages; the shots are cut to the narration, so
// the English film has its own, in footage_en/
const FOOTAGE_DIRECTORY = path.join(__dirname, "footage");
function shotsDirectory() {
    return path.join(__dirname, LANGUAGE === "en" ? "footage_en" : "footage");
}
const footageFrameCounts = {};
function footageFrameCount(shotName) {
    if (footageFrameCounts[shotName] === undefined) {
        const directory = path.join(shotsDirectory(), shotName);
        footageFrameCounts[shotName] = fs.existsSync(directory) ? fs.readdirSync(directory).filter(function (name) { return name.endsWith(".jpg"); }).length : 0;
    }
    return footageFrameCounts[shotName];
}

// The frame of a shot for a share (0..1) of its playing time
function footageFrame(shotName, share) {
    const count = footageFrameCount(shotName);
    return { shot: shotName, frame: Math.max(0, Math.min(count - 1, Math.floor(clamp01(share) * count))) };
}

const loadedImages = new Map();
async function loadFootageImages(requests) {
    for (const request of requests) {
        const key = request.shot + "/" + request.frame;
        if (loadedImages.has(key)) { continue; }
        loadedImages.set(key, await loadImage(path.join(shotsDirectory(), request.shot, String(request.frame).padStart(4, "0") + ".jpg")));
    }
    // keep only what was asked for this frame, and a few around it
    if (loadedImages.size > 24) {
        const wanted = new Set(requests.map(function (request) { return request.shot + "/" + request.frame; }));
        for (const key of Array.from(loadedImages.keys())) {
            if (!wanted.has(key)) { loadedImages.delete(key); }
            if (loadedImages.size <= 12) { break; }
        }
    }
}
function footageImage(request) {
    return request ? loadedImages.get(request.shot + "/" + request.frame) : null;
}

// ---------------------------------------------------------------------------
// Scenes. Each scene has draw(context, time, scene, assets), with the time in seconds from the
// start of the scene, and, when it shows footage, shots(scene) (see Shots below).
// ---------------------------------------------------------------------------

// The film's titles and names, in one place (the cover uses them too)
const FILM = {
    titleChinese: "中国古建筑波函数坍缩算法生成",
    titleEnglish: "Generating Chinese Historical Architecture with Wave Function Collapse",
    // the English film does not name a country: architecture in the title, Asian classical in the film
    titleEnglishFilm: "Generating Architecture with Wave Function Collapse",
    authorChinese: "Richard Qian Li 陈腐粉碎机",
    authorEnglish: "Richard Qian Li, ITP, NYU",
    repository: "github.com/ludwigpeking/Shoin_zukuri_WFC"
};

// Scenes on white (the sketches and drawings are on white paper) use ink colours; scenes of
// footage stay as they were. light is true, false, or a function of the scene's time.
const INK = { text: "#15191e", muted: "#5d6875", accent: "#b9801a", line: "#d9dde2", panel: "#f3f4f6", code: "#22303c", codeHighlight: "rgba(217,164,65,0.28)", bad: "#d64545" };

const SCENES = [
    { name: "title", chapter: "", tailSeconds: 0.6, light: false, draw: drawTitleScene },
    { name: "motive", chapter: "A · 为什么是古建筑  Why classical architecture", tailSeconds: 0.8, light: motiveIsLight, draw: drawMotiveScene },
    { name: "origin", chapter: "B · 源起  Origins", tailSeconds: 0.5, light: true, draw: drawOriginScene },
    { name: "grammar", chapter: "C · 构造的语法  A tectonic grammar", tailSeconds: 0.6, light: true, draw: drawGrammarScene },
    { name: "edge", chapter: "D · 边缘匹配  Edge matching", tailSeconds: 0.8, light: true, draw: drawEdgeScene },
    { name: "sketch", chapter: "E · 草图  Sketches", tailSeconds: 0.8, light: true, draw: drawSketchScene },
    { name: "model", chapter: "F · 构件建模  Modelling the blocks", tailSeconds: 1.0, light: false, shots: modelShots, draw: drawModelScene },
    { name: "collapse", chapter: "G · 坍缩  Collapse", tailSeconds: 1.6, light: false, shots: collapseShots, draw: drawCollapseScene },
    { name: "play", chapter: "H · 手动增减体量  Shaping by hand", tailSeconds: 1.4, light: false, shots: playShots, draw: drawPlayScene },
    { name: "grid", chapter: "I · 换一种网格  Other grids", tailSeconds: 10.5, light: gridIsLight, shots: gridShots, draw: drawGridScene },
    { name: "ending", chapter: "", tailSeconds: 9.0, light: true, shots: null, draw: drawEndingScene }
];

function sceneIsLight(scene, time) {
    return typeof scene.light === "function" ? scene.light(time, scene) : scene.light;
}

// ---------------------------------------------------------------------------
// Shots. A scene with footage lists its shots: { shot, start, end } in the scene's own seconds.
// A shot plays through once from a little before its start to a little after its end (it fades
// over the cut), so capture_footage.js shoots exactly the frames that are shown: shots.json,
// written with --shots, tells it how many, and from which kept view (kept_views.json) each comes.
// ---------------------------------------------------------------------------

const SHOT_FADE_SECONDS = 0.35;

let keptViewsCache = null;
function keptViews() {
    if (keptViewsCache === null) {
        const keptViewsPath = path.join(__dirname, "kept_views.json");
        keptViewsCache = fs.existsSync(keptViewsPath) ? JSON.parse(fs.readFileSync(keptViewsPath, "utf8")) : [];
    }
    return keptViewsCache;
}
// A hexagonal map of more than the usual 3 rings is the large scene, designed by hand; it is not
// one of the ordinary hexagonal views.
function isLargeSceneView(keptView) {
    return keptView.mapKind === "hexagonal" && keptView.hexRingCount > 3;
}
function keptViewsOfKind(mapKind) {
    return keptViews().filter(function (keptView) { return keptView.mapKind === mapKind && !isLargeSceneView(keptView); });
}
// the last large scene kept, or null: then capture_footage.js builds a stand-in
function largeSceneViewNumber() {
    const largeViews = keptViews().filter(isLargeSceneView);
    return largeViews.length > 0 ? largeViews[largeViews.length - 1].number : null;
}

// Where each shot comes from. The square views: the first is collapsed cell by cell, all of them
// are shown as results. The larger scene (built in capture_footage.js) is seen by day, then into
// the evening, and last as one path traced picture at night.
function shotSources() {
    const sources = {
        catalogue: { kind: "catalogue" }, play: { kind: "play" },
        large_day: { kind: "large_orbit", keptViewNumber: largeSceneViewNumber() },
        large_dusk: { kind: "large_dusk", keptViewNumber: largeSceneViewNumber() },
        large_night: { kind: "large_night", keptViewNumber: largeSceneViewNumber() }
    };
    const squareViews = keptViewsOfKind("square");
    sources.collapse = { kind: "collapse", keptViewNumber: squareViews.length > 0 ? squareViews[0].number : null };
    resultShotNames().forEach(function (shotName, index) {
        sources[shotName] = { kind: "orbit", keptViewNumber: squareViews.length > 0 ? squareViews[index].number : null };
    });
    [["bent", "bent"], ["hex", "hexagonal"]].forEach(function (pair) {
        const views = keptViewsOfKind(pair[1]);
        quadShotNames(pair[0], pair[1]).forEach(function (shotName, index) {
            sources[shotName] = { kind: "orbit", mapKind: pair[1], keptViewNumber: views.length > 0 ? views[index].number : null };
        });
    });
    return sources;
}
function resultShotNames() {
    const names = [];
    for (let index = 0; index < Math.max(1, keptViewsOfKind("square").length); index++) { names.push("result_" + (index + 1)); }
    return names;
}
function quadShotNames(prefix, mapKind) {
    const names = [];
    for (let index = 0; index < Math.max(1, keptViewsOfKind(mapKind).length); index++) { names.push(prefix + "_" + (index + 1)); }
    return names;
}

// Shots one after the other over a stretch of a scene, each the same length
function shotsInTurn(shotNames, start, end) {
    const each = (end - start) / shotNames.length;
    return shotNames.map(function (shotName, index) {
        return { shot: shotName, start: start + index * each, end: start + (index + 1) * each };
    });
}

function sceneShots(scene) {
    return scene.shots ? scene.shots(scene) : [];
}
function shotFrameRequest(part, time) {
    return footageFrame(part.shot, (time - (part.start - SHOT_FADE_SECONDS)) / (part.end - part.start + 2 * SHOT_FADE_SECONDS));
}
function activeShots(time, scene) {
    return sceneShots(scene).filter(function (part) {
        return time >= part.start - SHOT_FADE_SECONDS && time < part.end + SHOT_FADE_SECONDS && footageFrameCount(part.shot) > 0;
    });
}
function drawShots(context, time, scene) {
    activeShots(time, scene).forEach(function (part) {
        const alpha = ease(ramp(time, part.start - SHOT_FADE_SECONDS, 2 * SHOT_FADE_SECONDS)) * (1 - ease(ramp(time, part.end - SHOT_FADE_SECONDS, 2 * SHOT_FADE_SECONDS)));
        // a still (one frame) is pushed in slowly, so that it does not stand dead
        const zoom = footageFrameCount(part.shot) === 1 ? 1 + 0.05 * clamp01((time - part.start) / (part.end - part.start)) : 1;
        drawCover(context, footageImage(shotFrameRequest(part, time)), alpha, zoom);
    });
}
function shotList() {
    const sources = shotSources();
    const list = [];
    SCENES.forEach(function (scene) {
        sceneShots(scene).forEach(function (part) {
            const source = sources[part.shot];
            const frameCount = source.kind === "large_night" ? 1 : Math.ceil((part.end - part.start + 2 * SHOT_FADE_SECONDS) * FRAMES_PER_SECOND);
            list.push(Object.assign({ shot: part.shot, frameCount: frameCount }, source));
        });
    });
    return list;
}

// ---------------------------------------------------------------------------
// Pictures. No borders and no mounts: a picture is shown as it is. Pictures that stand together
// are given the same height and stand on one line.
// ---------------------------------------------------------------------------

// A picture (or a part of it: crop) as large as fits in a box, in the middle of the box.
// whitePatches: rectangles of the source ([x, y, width, height]) left white, for the other
// drawings that share a sheet of sketches with the one that is shown.
function drawPicture(context, image, box, alpha, crop, whitePatches) {
    if (!image || alpha <= 0) { return null; }
    const source = crop || { x: 0, y: 0, width: image.width, height: image.height };
    const scale = Math.min(box.width / source.width, box.height / source.height);
    const width = source.width * scale, height = source.height * scale;
    const left = box.x + (box.width - width) / 2, top = box.y + (box.height - height) / 2;
    context.save();
    context.globalAlpha *= alpha;
    context.drawImage(image, source.x, source.y, source.width, source.height, left, top, width, height);
    context.restore();
    if (whitePatches) {
        context.save();
        context.beginPath();
        // two pixels over the picture's edge: the edge pixels are blended with what lies outside the crop
        context.rect(left - 2, top - 2, width + 4, height + 4);
        context.clip();
        context.fillStyle = "#ffffff";
        whitePatches.forEach(function (patch) {
            context.fillRect(left + (patch[0] - source.x) * scale - 2, top + (patch[1] - source.y) * scale - 2, patch[2] * scale + 4, patch[3] * scale + 4);
        });
        context.restore();
    }
    return { x: left, y: top, width: width, height: height };
}

// Pictures side by side at one height, the row centred on centreX; each entry: { image, crop,
// alpha, caption, credit }. Captions and credits stand under the pictures, on one line each.
function drawPictureRow(context, entries, centreX, top, height, gap, inkColours) {
    const widths = entries.map(function (entry) {
        const source = entry.crop || { width: entry.image.width, height: entry.image.height };
        return height * source.width / source.height;
    });
    const totalWidth = widths.reduce(function (sum, width) { return sum + width; }, 0) + gap * (entries.length - 1);
    const rowLeft = centreX - totalWidth / 2;
    let left = rowLeft;
    entries.forEach(function (entry, index) {
        drawPicture(context, entry.image, { x: left, y: top, width: widths[index], height: height }, entry.alpha, entry.crop, entry.whitePatches);
        if (entry.caption) {
            drawText(context, entry.caption, left, top + height + 44, 30, inkColours.text, { alpha: entry.alpha, family: "YaHeiBold" });
        }
        if (entry.credit) {
            drawText(context, entry.credit, left, top + height + (entry.caption ? 76 : 30), 18, inkColours.muted, { alpha: entry.alpha });
        }
        left += widths[index] + gap;
    });
    return rowLeft;
}

function drawInkBullet(context, x, y, chinese, english, alpha) {
    if (alpha <= 0) { return; }
    context.save();
    context.globalAlpha *= alpha;
    const offset = 18 * (1 - alpha);
    context.fillStyle = INK.accent;
    context.fillRect(x, y - 44 + offset, 6, 62);
    drawText(context, chinese, x + 28, y - 8 + offset, 44, INK.text, { family: "YaHeiBold" });
    drawText(context, english, x + 28, y + 28 + offset, 25, INK.muted);
    context.restore();
}

function drawTopRightLabel(context, text, alpha, colour) {
    drawText(context, text, 1860, 92, 26, colour || COLOUR.text, { alpha: alpha, align: "right", shadow: !colour });
}

// The drawings on the sheet of 2023, each with the neighbours that reach into its rectangle left white
const SHEET = {
    blocks: { crop: { x: 30, y: 40, width: 3190, height: 2390 }, whitePatches: [[2370, 760, 910, 280], [2560, 1040, 720, 700], [2690, 1720, 600, 720]] },
    landscapeBlocks: { crop: { x: 40, y: 2430, width: 2200, height: 790 }, whitePatches: [] },
    roof: { crop: { x: 2480, y: 1150, width: 1180, height: 810 }, whitePatches: [[2480, 1700, 220, 260], [3550, 1150, 110, 245]] },
    valley: { crop: { x: 3500, y: 600, width: 1200, height: 900 }, whitePatches: [[3500, 600, 180, 160], [3500, 860, 250, 90], [3500, 1330, 140, 170]] },
    section: { crop: { x: 2930, y: 1560, width: 1600, height: 1660 }, whitePatches: [[2930, 1560, 730, 380]] }
};

// The part of a join still that holds the two blocks, apart or joined (they stand right of the middle)
function joinCrop(image) {
    return { x: image.width * 0.31, y: image.height * 0.28, width: image.width * 0.5, height: image.height * 0.64 };
}

// The middle of a diagram still (the blocks stand in the middle of a white frame)
function stillCrop(image, widthShare, heightShare) {
    const width = image.width * widthShare, height = image.height * heightShare;
    return { x: (image.width - width) / 2, y: (image.height - height) / 2, width: width, height: height };
}

// --- title: the cover ----------------------------------------------------------------------------
// One pattern only, from Maxim Gumin's picture of the algorithm: a black and white plan of rooms,
// its pixels enlarged to fill the frame. A dark field covers the left for the words and clears
// towards the right; one accent colour; nothing else.
function drawCoverArt(context, assets, language, reveal) {
    context.save();
    context.imageSmoothingEnabled = false; // pixel art: enlarged as it is
    drawCover(context, assets.external.guminRoomsTile, 1, 1, null);
    context.restore();
    const field = context.createLinearGradient(900, 0, 1700, 0);
    field.addColorStop(0, "rgba(20,24,29,0.97)");
    field.addColorStop(1, "rgba(20,24,29,0.42)");
    context.fillStyle = field;
    context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    const left = 150;
    context.fillStyle = COLOUR.accent;
    context.fillRect(left, 236, 72, 6);
    if (language === "en") {
        drawText(context, "Generating Architecture", left - 3, 400, 112, COLOUR.text, { alpha: reveal(0), family: "YaHeiBold" });
        drawText(context, "with Wave Function Collapse", left - 3, 540, 112, COLOUR.text, { alpha: reveal(0), family: "YaHeiBold" });
        drawText(context, "An experiment with Asian classical architecture", left, 640, 36, COLOUR.muted, { alpha: reveal(1) });
        drawText(context, FILM.authorEnglish, left, 790, 38, COLOUR.text, { alpha: reveal(2) });
    } else {
        drawText(context, "中国古建筑", left - 4, 400, 124, COLOUR.text, { alpha: reveal(0), family: "YaHeiBold" });
        drawText(context, "波函数坍缩算法生成", left - 4, 560, 124, COLOUR.text, { alpha: reveal(0), family: "YaHeiBold" });
        drawText(context, "Generating Chinese Historical Architecture", left, 650, 34, COLOUR.muted, { alpha: reveal(1) });
        drawText(context, "with Wave Function Collapse", left, 696, 34, COLOUR.muted, { alpha: reveal(1) });
        drawText(context, FILM.authorChinese, left, 790, 38, COLOUR.text, { alpha: reveal(2) });
    }
    drawText(context, "背景 image: Maxim Gumin, WaveFunctionCollapse (MIT)", 1870, 1050, 18, "rgba(233,236,239,0.7)", { align: "right", shadow: true });
}
// The upright cover, 3 to 4: the same pattern and colours, the pattern clear at the top, the
// words on the dark field below it
const UPRIGHT_COVER_WIDTH = 1080;
const UPRIGHT_COVER_HEIGHT = 1440;
function drawUprightCoverArt(context, assets, language) {
  context.save();
  context.imageSmoothingEnabled = false;
  drawCover(context, assets.external.guminRoomsTile, 1, 1, { x: 0, y: 0, width: UPRIGHT_COVER_WIDTH, height: UPRIGHT_COVER_HEIGHT });
  context.restore();
  const field = context.createLinearGradient(0, 380, 0, 900);
  field.addColorStop(0, "rgba(20,24,29,0.42)");
  field.addColorStop(1, "rgba(20,24,29,0.97)");
  context.fillStyle = field;
  context.fillRect(0, 0, UPRIGHT_COVER_WIDTH, UPRIGHT_COVER_HEIGHT);
  const left = 90;
  context.fillStyle = COLOUR.accent;
  context.fillRect(left, 700, 72, 6);
  if (language === "en") {
    ["Generating", "Architecture", "with Wave Function", "Collapse"].forEach(function (line, index) {
      drawText(context, line, left - 3, 850 + index * 104, 86, COLOUR.text, { family: "YaHeiBold" });
    });
    drawText(context, "An experiment with Asian classical architecture", left, 1246, 32, COLOUR.muted);
    drawText(context, FILM.authorEnglish, left, 1340, 38, COLOUR.text);
  } else {
    ["中国古建筑", "波函数坍缩", "算法生成"].forEach(function (line, index) {
      drawText(context, line, left - 5, 868 + index * 164, 148, COLOUR.text, { family: "YaHeiBold" });
    });
    drawText(context, FILM.authorChinese, left, 1340, 40, COLOUR.text);
  }
  drawText(context, "image: Maxim Gumin, WaveFunctionCollapse (MIT)", UPRIGHT_COVER_WIDTH - 40, 1410, 17, "rgba(233,236,239,0.6)", { align: "right" });
}

function drawTitleScene(context, time, scene, assets) {
    drawCoverArt(context, assets, LANGUAGE, function (step) { return ease(ramp(time, 0.6 + step * 0.6, 1.0)); });
    const thanks = ease(ramp(time, cueTime(scene, 2, "P小二") - 0.2, 0.8));
    drawText(context, byLanguage("感谢 P小二 的提示  with thanks to P小二", "with thanks to Mr. P-xiaoer"), 150, 846, 26, COLOUR.accent, { alpha: thanks });
}

// --- why historical architecture -------------------------------------------------------------------
// The levels of an architectural problem, the one WFC suits marked
function drawLevelStack(context, left, top, alpha, highlight) {
    if (alpha <= 0) { return; }
    const levels = [["总体布局", "the overall layout"], ["功能与空间", "programme and space"], ["单体形制", "the form of a building"], ["构造", "construction: how parts join"]];
    context.save();
    context.globalAlpha *= alpha;
    levels.forEach(function (level, index) {
        const isTectonicLevel = index === levels.length - 1;
        const y = top + index * 112;
        context.fillStyle = isTectonicLevel ? "rgba(217,164,65," + (0.12 + 0.2 * highlight).toFixed(3) + ")" : INK.panel;
        context.fillRect(left, y, 640, 92);
        drawText(context, level[0], left + 30, y + 44, 36, isTectonicLevel ? INK.text : INK.muted, { family: "YaHeiBold" });
        drawText(context, level[1], left + 32, y + 76, 22, INK.muted);
        if (isTectonicLevel) {
            drawText(context, "WFC", left + 610, y + 58, 40, INK.accent, { alpha: highlight, align: "right", family: "Consolas" });
        }
    });
    context.restore();
}

// white, except while the floor plans of 2022 fill the frame
function motiveIsLight(time, scene) {
    return time < scene.lineStart[3] || time > scene.lineStart[4] - 0.35;
}
function drawMotiveScene(context, time, scene, assets) {
    const lineStart = scene.lineStart;
    // lines 0 to 2: what WFC is good for
    // line 0: what WFC makes, in Gumin's own picture: patterns of one level; lines 1 and 2: the
    // level it suits in architecture, how parts join, in the Yingzao Fashi
    const openingAlpha = ease(ramp(time, 0.3, 0.8)) * (1 - ease(ramp(time, lineStart[3] - 0.5, 0.5)));
    const jointsAlpha = openingAlpha * ease(ramp(time, lineStart[1] - 0.1, 0.8));
    if (openingAlpha > 0) {
        // two groups, each a heading with its pictures under it, the pictures at one height
        const picturesTop = 236, picturesHeight = 590, jointsLeft = 900;
        const sheetPlace = drawPicture(context, assets.external.guminSheetFull, { x: 150, y: picturesTop, width: 470, height: picturesHeight }, openingAlpha);
        drawText(context, byLanguage("WFC：单一层次的图案", "WFC: patterns of a single level"), 150, byLanguage(178, 196), byLanguage(38, 30), INK.text, { alpha: openingAlpha, family: "YaHeiBold" });
        drawText(context, byLanguage("Patterns of a single level", ""), 152, 212, 22, INK.muted, { alpha: openingAlpha });
        drawText(context, "图 image: Maxim Gumin, WaveFunctionCollapse (MIT)", sheetPlace.x, picturesTop + picturesHeight + 28, 18, INK.muted, { alpha: openingAlpha });
        const joints = assets.external.yingzaoJoints, brackets = assets.external.yingzaoBrackets;
        const jointsWidth = picturesHeight * joints.width / joints.height, bracketsWidth = picturesHeight * brackets.width / brackets.height;
        drawPictureRow(context, [
            { image: joints, alpha: jointsAlpha },
            { image: brackets, alpha: jointsAlpha * ease(ramp(time, lineStart[1] + 1.2, 0.8)) }
        ], jointsLeft + (jointsWidth + 30 + bracketsWidth) / 2, picturesTop, picturesHeight, 30, INK);
        drawText(context, "构造层次：构件怎样交接", jointsLeft, 178, 38, INK.text, { alpha: jointsAlpha, family: "YaHeiBold" });
        drawText(context, "The tectonic level: how parts join", jointsLeft + 2, 212, 22, INK.muted, { alpha: jointsAlpha });
        drawText(context, byLanguage("李诫《营造法式》（公有领域 public domain）", "Li Jie, Yingzao Fashi, 1103 (public domain)"), jointsLeft, picturesTop + picturesHeight + 28, 18, INK.muted, { alpha: jointsAlpha });
    }
    // line 3: the floor plans of 2022, full frame
    const plansAlpha = ease(ramp(time, lineStart[3] - 0.35, 0.7)) * (1 - ease(ramp(time, lineStart[4] - 0.7, 0.7)));
    drawCover(context, assets.floorPlanModels, plansAlpha, 1 + 0.03 * clamp01((time - lineStart[3]) / 8));
    drawTopRightLabel(context, "2022 · 户型生成  WFC floor plans", plansAlpha);
    // line 4: the routines of historical construction, in the classical sources
    const classicalAlpha = ease(ramp(time, lineStart[4] - 0.2, 0.8)) * (1 - ease(ramp(time, lineStart[5] - 0.5, 0.5)));
    if (classicalAlpha > 0) {
        drawPictureRow(context, [
            { image: assets.external.liangPavilion, alpha: classicalAlpha, credit: byLanguage("梁思成，正定隆兴寺转轮藏殿，1933（公有领域 public domain）", "Liang Sicheng, survey drawing, 1933 (public domain)") },
            { image: assets.external.liangHall, alpha: classicalAlpha * ease(ramp(time, lineStart[4] + 1.2, 0.8)), credit: byLanguage("梁思成，正定隆兴寺摩尼殿，1933", "Liang Sicheng, survey drawing, 1933") },
            { image: assets.external.yingzaoBrackets, alpha: classicalAlpha * ease(ramp(time, lineStart[4] + 2.4, 0.8)), credit: byLanguage("李诫《营造法式》", "Li Jie, Yingzao Fashi, 1103") }
        ], 960, 170, 600, 70, INK);
        drawTopRightLabel(context, "古建筑的套路  The routines of classical construction", classicalAlpha, INK.muted);
    }
    // line 5: the same routines in my own sketch
    const sketchAlpha = ease(ramp(time, lineStart[5] - 0.2, 0.8));
    if (sketchAlpha > 0) {
        drawPictureRow(context, [
            { image: assets.sketchSheet, alpha: sketchAlpha, crop: SHEET.roof.crop, whitePatches: SHEET.roof.whitePatches },
            { image: assets.sketchSheet, alpha: sketchAlpha * ease(ramp(time, lineStart[5] + 0.8, 0.8)), crop: SHEET.valley.crop, whitePatches: SHEET.valley.whitePatches },
            { image: assets.sketchSheet, alpha: sketchAlpha * ease(ramp(time, lineStart[5] + 1.6, 0.8)), crop: SHEET.section.crop, whitePatches: SHEET.section.whitePatches }
        ], 960, 270, 420, 70, INK);
    }
    drawTopRightLabel(context, "我的草图 My sketch, 2023", sketchAlpha, INK.muted);
}

// --- origins -----------------------------------------------------------------------------------
function drawOriginScene(context, time, scene, assets) {
    const pictureWidth = 540, gap = 60, pictureHeight = pictureWidth * 9 / 16, top = 210;
    const left = (FRAME_WIDTH - 3 * pictureWidth - 2 * gap) / 2;
    const people = [
        ["Bruno Simon", "WebGL", ["网课 Three.js Journey", "三维网页技术  3D on the web"], assets.external.threeJourney, "图 image: threejs-journey.com © Bruno Simon", cueTime(scene, 0, "Bruno")],
        ["Oskar Stålberg", "2019", ["讲座 Organic Towns from Square Tiles", "IndieCade Europe 2019"], assets.external.stalbergTalk, "图 image: IndieCade Europe (YouTube)", cueTime(scene, 1, "Oskar")],
        ["Daniel Shiffman", "2022", ["编程讲座  The Coding Train", "Coding Challenge 171: WFC (JavaScript)"], assets.external.codingTrain, "图 image: The Coding Train (YouTube)", cueTime(scene, 1, "Daniel")]];
    // line 4: the earlier work of the same kind takes the place of the three sources
    const peopleLeave = 1 - ease(ramp(time, scene.lineStart[4] - 0.5, 0.5));
    people.forEach(function (person, index) {
        const alpha = ease(ramp(time, person[5] - 0.3, 0.8)) * peopleLeave;
        if (alpha <= 0) { return; }
        const x = left + index * (pictureWidth + gap);
        context.save();
        context.globalAlpha = alpha;
        drawCover(context, person[3], 1, 1, { x: x, y: top, width: pictureWidth, height: pictureHeight });
        drawText(context, person[4], x, top + pictureHeight + 28, 17, INK.muted);
        drawText(context, person[1], x, top + pictureHeight + 96, 26, INK.accent, { family: "Consolas" });
        drawText(context, person[0], x, top + pictureHeight + 150, 42, INK.text, { family: "YaHeiBold" });
        person[2].forEach(function (text, lineIndex) {
            drawText(context, text, x, top + pictureHeight + 198 + lineIndex * 36, 25, INK.muted);
        });
        context.restore();
    });
    // line 2: Shiffman's lecture, underlined
    const underline = ease(ramp(time, scene.lineStart[2], 0.5));
    context.save();
    context.globalAlpha = peopleLeave;
    context.fillStyle = INK.accent;
    context.fillRect(left + 2 * (pictureWidth + gap), top + pictureHeight + 164, 330 * underline, 5);
    context.restore();
    const eavesAlpha = ease(ramp(time, scene.lineStart[4] - 0.1, 0.8));
    if (eavesAlpha > 0) {
        const eavesLeft = drawPictureRow(context, [
            { image: assets.external.eavesTown, alpha: eavesAlpha },
            { image: assets.external.eavesStreet, alpha: eavesAlpha * ease(ramp(time, scene.lineStart[4] + 1.2, 0.8)) }
        ], 960, 200, 470, 40, INK);
        const nameAlpha = ease(ramp(time, cueTime(scene, 4, "也就是") - 0.2, 0.7));
        drawText(context, "《重檐》EAVES", eavesLeft, 750, 48, INK.text, { alpha: nameAlpha, family: "YaHeiBold" });
        drawText(context, "KakaBobi Studio · @kakabobi_33", eavesLeft + 2, 794, 28, INK.muted, { alpha: nameAlpha });
        drawText(context, byLanguage("图 images: 《重檐》EAVES © KakaBobi Studio / HeartBeat Games (Steam)", "images: EAVES © KakaBobi Studio / HeartBeat Games (Steam)"), eavesLeft + 1711, 700, 18, INK.muted, { alpha: eavesAlpha, align: "right" });
    }
}

// --- a tectonic grammar ------------------------------------------------------------------------
function drawGrammarScene(context, time, scene, assets) {
    const lineStart = scene.lineStart;
    const leaves = function (lineIndex) { return 1 - ease(ramp(time, lineStart[lineIndex] - 0.5, 0.5)); };
    // line 0: generated game levels, from Gumin's own examples: one large, two beside it, edges in line
    const levelAlpha = ease(ramp(time, 0.2, 0.8)) * leaves(1);
    if (levelAlpha > 0) {
        const top = 250, largeHeight = 470;
        const castle = assets.external.guminCastle;
        const largeWidth = largeHeight * castle.width / castle.height;
        const sideWidth = 620, groupWidth = largeWidth + 40 + sideWidth, groupLeft = 1860 - groupWidth;
        drawPicture(context, castle, { x: groupLeft, y: top, width: largeWidth, height: largeHeight }, levelAlpha);
        const strip = assets.external.guminCastles, rooms = assets.external.guminRooms;
        const stripHeight = sideWidth * strip.height / strip.width, roomsHeight = sideWidth * rooms.height / rooms.width;
        drawPicture(context, strip, { x: groupLeft + largeWidth + 40, y: top, width: sideWidth, height: stripHeight }, levelAlpha * ease(ramp(time, 0.8, 0.8)));
        drawPicture(context, rooms, { x: groupLeft + largeWidth + 40, y: top + largeHeight - roomsHeight, width: sideWidth, height: roomsHeight }, levelAlpha * ease(ramp(time, 1.2, 0.8)));
        drawText(context, "图 images: Maxim Gumin, github.com/mxgmn/WaveFunctionCollapse (MIT)", 1860, top + largeHeight + 30, 18, INK.muted, { alpha: levelAlpha, align: "right" });
    }
    drawInkBullet(context, 150, 330, "游戏关卡生成", "Game level generation", levelAlpha);
    const grammarAlpha = leaves(5) * ease(ramp(time, cueTime(scene, 1, "构造的语法") - 0.2, 0.8));
    drawInkBullet(context, 150, 330, "构造的语法", "A tectonic grammar", grammarAlpha);
    const explanationAlpha = leaves(5) * ease(ramp(time, lineStart[2], 0.8));
    drawText(context, "自下而上，", 178, 470, 40, INK.text, { alpha: explanationAlpha });
    drawText(context, "在构件与构件的交接处产生秩序", 178, 526, 40, INK.text, { alpha: explanationAlpha });
    drawText(context, "Order from the bottom up, where one part meets another", 180, 566, 24, INK.muted, { alpha: explanationAlpha });
    // lines 3 and 4: the joints, in the blocks themselves: a hall whose ridges meet and whose eaves
    // turn the corner, then the gutter that may not appear
    const gutterTime = cueTime(scene, 3, "天沟") - 0.2;
    const hallAlpha = ease(ramp(time, lineStart[1] - 0.2, 0.8)) * (1 - ease(ramp(time, gutterTime, 0.6)));
    const hallCaptionAlpha = hallAlpha * ease(ramp(time, lineStart[3] - 0.2, 0.7));
    const gutterAlpha = ease(ramp(time, gutterTime, 0.6)) * leaves(5);
    const jointBox = { x: 980, y: 200, width: 880, height: 520 };
    const jointCrop = stillCrop(assets.diagrams.joint_hall, 0.74, 0.86);
    const jointLeft = jointBox.x + (jointBox.width - Math.min(jointBox.width, jointBox.height * jointCrop.width / jointCrop.height)) / 2;
    drawPicture(context, assets.diagrams.joint_hall, jointBox, hallAlpha, jointCrop);
    drawText(context, "屋脊相接，檐口转角", jointLeft, 780, 40, INK.text, { alpha: hallCaptionAlpha, family: "YaHeiBold" });
    drawText(context, "Ridges meet, eaves turn the corner", jointLeft + 2, 818, 24, INK.muted, { alpha: hallCaptionAlpha });
    drawPicture(context, assets.diagrams.gutter, jointBox, gutterAlpha, jointCrop);
    drawText(context, "天沟：不允许出现", jointLeft, 780, 40, INK.bad, { alpha: gutterAlpha, family: "YaHeiBold" });
    drawText(context, "A gutter between two roofs: not allowed", jointLeft + 2, 818, 24, INK.muted, { alpha: gutterAlpha });
    // lines 5 and 6: the larger order, left to the next experiment: old towns seen from above
    const orderAlpha = ease(ramp(time, lineStart[5] - 0.1, 0.8));
    if (orderAlpha > 0) {
        const orderLeft = drawPictureRow(context, [
            { image: assets.external.pingyao, alpha: orderAlpha, credit: byLanguage("平遥 Pingyao · asiaodysseytravel.com", "asiaodysseytravel.com") },
            { image: assets.external.xijiang, alpha: orderAlpha * ease(ramp(time, lineStart[5] + 0.8, 0.8)), credit: byLanguage("西江 Xijiang · thebiggestcitiesinchina.com", "thebiggestcitiesinchina.com") },
            { image: assets.external.forbiddenCity, alpha: orderAlpha * ease(ramp(time, lineStart[5] + 1.6, 0.8)), credit: byLanguage("故宫 Forbidden City · Güldem Üstün, CC BY 2.0", "Güldem Üstün, CC BY 2.0") }
        ], 960, 340, 372, 30, INK);
        drawText(context, "更宏观的秩序", orderLeft, 240, 54, INK.text, { alpha: orderAlpha, family: "YaHeiBold" });
        drawText(context, "The larger order: a question for the next experiment", orderLeft + 2, 284, 28, INK.muted, { alpha: orderAlpha });
    }
}

// --- edge matching -----------------------------------------------------------------------------
// Code as it stands in main.js, on a light panel; lines with a tag can be highlighted
const TILE_CODE = [
    ["let tiles = [", ""],
    ["  new Tile(0, 0, [\"000\", \"000\", \"000\", \"000\"]),", ""],
    ["  new Tile(6, 0, [\"232\", \"DDD\", \"232\", \"DDD\"]),", "edges"],
    ["  new Tile(7, 0, [\"012\", \"UUU\", \"210\", \"000\"]),", "edges"],
    ["  new Tile(9, 0, [\"012\", \"210\", \"000\", \"000\"]),", "edges"],
    ["  new Tile(14, 0, [\"234\", \"444\", \"432\", \"DDD\"]),", ""],
    ["  new Tile(23, 0, [\"2T4\", \"4T2\", \"DDD\", \"DDD\"]),", ""],
    ["  new Tile(24, 0, [\"N00\", \"000\", \"000\", \"00N\"]),", ""],
    ["  // ...", ""],
    ["];", ""]];
const EDGE_CODE = [
    ["function compareEdge(a, b) {", ""],
    ["  if (a === \"DDD\" && b === \"DDD\") {", "gutter"],
    ["    return false;                 // a gutter", "gutter"],
    ["  }", "gutter"],
    ["  for (let position = 0; position < 3; position++) {", "pit"],
    ["    if (a[position] === \"C\" && b[2 - position] === \"C\") {", "pit"],
    ["      return false;               // a pit", "pit"],
    ["    }", "pit"],
    ["  }", "pit"],
    ["  return edgeHeights(a) === reverseString(edgeHeights(b));", "match"],
    ["}", ""]];
function drawCode(context, codeLines, left, top, width, alpha, highlightOf) {
    if (alpha <= 0) { return; }
    context.save();
    context.globalAlpha *= alpha;
    context.fillStyle = INK.panel;
    context.fillRect(left, top, width, codeLines.length * 44 + 56);
    codeLines.forEach(function (codeLine, index) {
        const highlight = codeLine[1] ? highlightOf[codeLine[1]] || 0 : 0;
        const y = top + 62 + index * 44;
        if (highlight > 0) {
            context.save();
            context.globalAlpha *= highlight;
            context.fillStyle = INK.codeHighlight;
            context.fillRect(left, y - 32, width, 44);
            context.restore();
        }
        drawText(context, codeLine[0], left + 34, y, 27, INK.code, { family: "Consolas" });
    });
    context.restore();
}

function drawEdgeScene(context, time, scene, assets) {
    const lineStart = scene.lineStart;
    const leaves = function (lineIndex) { return 1 - ease(ramp(time, lineStart[lineIndex] - 0.5, 0.5)); };
    const enters = function (lineIndex) { return ease(ramp(time, lineStart[lineIndex] - 0.1, 0.7)); };
    // line 0: the kinds of block, in my sketch of the catalogue
    const kindsAlpha = leaves(1);
    drawPicture(context, assets.sketchSheet, { x: 120, y: 140, width: 1060, height: 740 }, kindsAlpha * ease(ramp(time, 0.2, 0.8)), SHEET.blocks.crop, SHEET.blocks.whitePatches);
    const kinds = [["阴角", "inside corner"], ["阳角", "outside corner"], ["边缘", "edge"], ["中腹", "middle"]];
    kinds.forEach(function (kind, index) {
        const alpha = kindsAlpha * ease(ramp(time, cueTime(scene, 0, kind[0]) - 0.2, 0.6));
        drawText(context, kind[0], 1300, 330 + index * 120, 56, INK.text, { alpha: alpha, family: "YaHeiBold" });
        drawText(context, kind[1], 1460, 326 + index * 120, 28, INK.muted, { alpha: alpha });
    });

    // line 1: pairs of different blocks whose facing edges agree: apart, then joined, one pair after the other
    const pairAlpha = enters(1) * leaves(2);
    if (pairAlpha > 0) {
        const pairNames = [["檐廊 + 转角", "a veranda and its corner"], ["檐廊 + 主屋顶", "a veranda and the main roof"], ["主屋顶 + 山墙", "the main roof and a gable end"]];
        const pairWidth = 520, pairGap = 50, pairsLeft = (FRAME_WIDTH - 3 * pairWidth - 2 * pairGap) / 2;
        pairNames.forEach(function (pairName, index) {
            const apart = assets.diagrams["join_" + (index + 1) + "_apart"], joinedStill = assets.diagrams["join_" + (index + 1) + "_joined"];
            const crop = joinCrop(apart);
            const box = { x: pairsLeft + index * (pairWidth + pairGap), y: 230, width: pairWidth, height: 374 };
            const appears = pairAlpha * ease(ramp(time, lineStart[1] + index * 0.5, 0.6));
            const joins = ease(ramp(time, lineStart[1] + 1.6 + index * 0.9, 0.8));
            drawPicture(context, apart, box, appears * (1 - joins), crop);
            drawPicture(context, joinedStill, box, appears * joins, crop);
            drawText(context, pairName[0], box.x, 670, 34, INK.text, { alpha: appears, family: "YaHeiBold" });
            drawText(context, pairName[1], box.x + 2, 706, 22, INK.muted, { alpha: appears });
        });
    }

    // lines 2 and 3: every edge is three characters, in the code
    const tileCodeAlpha = enters(2) * leaves(4);
    drawCode(context, TILE_CODE, 120, 190, 1010, tileCodeAlpha, { edges: ease(ramp(time, cueTime(scene, 2, "每个边缘") - 0.2, 0.6)) });
    const threeAlpha = tileCodeAlpha * ease(ramp(time, cueTime(scene, 2, "每个边缘") - 0.2, 0.6));
    // blocks 6, 7 and 9 as I drew them, each with the characters of its four edges
    if (tileCodeAlpha > 0) {
        drawPictureRow(context, [
            { image: assets.sketchSheet, alpha: tileCodeAlpha, crop: { x: 100, y: 570, width: 470, height: 360 } },
            { image: assets.sketchSheet, alpha: tileCodeAlpha, crop: { x: 100, y: 940, width: 470, height: 360 } },
            { image: assets.sketchSheet, alpha: tileCodeAlpha, crop: { x: 1170, y: 940, width: 470, height: 360 } }
        ], 1525, 210, 180, 20, INK);
    }
    drawText(context, "每条边 3 个字符", 1235, 500, 46, INK.text, { alpha: threeAlpha, family: "YaHeiBold" });
    drawText(context, "Three characters to an edge", 1237, 540, 24, INK.muted, { alpha: threeAlpha });
    const profileAlpha = tileCodeAlpha * ease(ramp(time, lineStart[3], 0.6));
    drawText(context, "字符 = 高度轮廓", 1235, 630, 46, INK.text, { alpha: profileAlpha, family: "YaHeiBold" });
    drawText(context, "A character = the profile of heights", 1237, 670, 24, INK.muted, { alpha: profileAlpha });
    drawTopRightLabel(context, "main.js", tileCodeAlpha, INK.muted);

    // line 4: the heights, on the section in my sketch
    const sectionAlpha = enters(4) * leaves(5);
    drawPicture(context, assets.sketchSheet, { x: 150, y: 140, width: 900, height: 740 }, sectionAlpha, SHEET.section.crop, SHEET.section.whitePatches);
    const levels = [["0", "地面", "ground", "0 是地面"], ["-1", "水底", "water bottom", "-1 是水底"], ["1", "檐口", "eave", "1 是檐口"], ["2", "矮脊", "low ridge of the shallower part", "2 是进深"],
        ["3", "高脊", "high ridge of the deeper building", "3 是进深"], ["4", "二层檐口", "eave of the upper storey", "4，是二层"]];
    levels.forEach(function (level, index) {
        const alpha = sectionAlpha * ease(ramp(time, cueTime(scene, 4, level[3]) - 0.15, 0.5));
        const y = 250 + index * 96;
        drawText(context, level[0], 1250, y, 56, INK.accent, { alpha: alpha, align: "right", family: "Consolas" });
        drawText(context, level[1], 1290, y - 4, 44, INK.text, { alpha: alpha, family: "YaHeiBold" });
        drawText(context, level[2], 1292, y + 30, 22, INK.muted, { alpha: alpha });
    });

    // lines 5 to 7: the condition in the code; where edges cannot join, the 3D view marks it in red;
    // the two cases ruled out by hand, in the blocks themselves
    const codeAlpha = enters(5);
    const pitTime = cueTime(scene, 7, "两个凹角") - 0.2;
    drawCode(context, EDGE_CODE, 100, 200, 1000, codeAlpha, {
        match: ease(ramp(time, lineStart[5] + 0.3, 0.5)) * (1 - ease(ramp(time, lineStart[6] - 0.2, 0.5))),
        gutter: ease(ramp(time, lineStart[6], 0.5)) * (1 - ease(ramp(time, pitTime - 0.1, 0.5))),
        pit: ease(ramp(time, pitTime, 0.5))
    });
    const warningAlpha = codeAlpha * ease(ramp(time, cueTime(scene, 5, "拼合不了") - 0.2, 0.6)) * leaves(7);
    const warningBox = { x: 1160, y: 200, width: 700, height: 480 };
    const joinsAlpha = codeAlpha * (1 - ease(ramp(time, cueTime(scene, 5, "拼合不了") - 0.4, 0.5)));
    drawPicture(context, assets.diagrams.join_2_joined, warningBox, joinsAlpha, joinCrop(assets.diagrams.join_2_joined));
    drawText(context, "边缘吻合：可以拼合", 1160, 730, 32, INK.text, { alpha: joinsAlpha, family: "YaHeiBold" });
    drawText(context, "The edges agree: the blocks join", 1162, 764, 22, INK.muted, { alpha: joinsAlpha });
    // the general case: two edges of different heights (not one of the two special cases that follow)
    drawPicture(context, assets.diagrams.mismatch, warningBox, warningAlpha, stillCrop(assets.diagrams.mismatch, 0.5, 0.86));
    drawText(context, "拼合不了：三维视图里的红色警示", 1160, 730, 32, INK.bad, { alpha: warningAlpha, family: "YaHeiBold" });
    drawText(context, "Edges that cannot join: the red warning in the 3D view", 1162, 764, 22, INK.muted, { alpha: warningAlpha });
    const casesAlpha = codeAlpha * enters(7);
    const gutterCaseAlpha = casesAlpha * ease(ramp(time, cueTime(scene, 7, "两片") - 0.2, 0.6));
    const pitCaseAlpha = casesAlpha * ease(ramp(time, pitTime, 0.6));
    drawPicture(context, assets.diagrams.gutter, { x: 1160, y: 170, width: 520, height: 330 }, gutterCaseAlpha, stillCrop(assets.diagrams.gutter, 0.5, 0.74));
    drawText(context, "天沟", 1700, 330, 38, INK.text, { alpha: gutterCaseAlpha, family: "YaHeiBold" });
    drawText(context, "a gutter", 1702, 364, 24, INK.muted, { alpha: gutterCaseAlpha });
    drawPicture(context, assets.diagrams.pit, { x: 1160, y: 520, width: 520, height: 330 }, pitCaseAlpha, stillCrop(assets.diagrams.pit, 0.5, 0.96));
    drawText(context, "坑", 1700, 680, 38, INK.text, { alpha: pitCaseAlpha, family: "YaHeiBold" });
    drawText(context, "a pit", 1702, 714, 24, INK.muted, { alpha: pitCaseAlpha });
    drawTopRightLabel(context, time < lineStart[6] ? "main.js · compareEdge" : "人为排除的两种情况  Two cases ruled out by hand", codeAlpha, INK.muted);
}

// --- sketches ----------------------------------------------------------------------------------
function drawSketchScene(context, time, scene, assets) {
    const lineStart = scene.lineStart;
    const notebookAlpha = ease(ramp(time, 0.2, 0.8)) * (1 - ease(ramp(time, lineStart[1] - 0.5, 0.5)));
    drawPicture(context, assets.notebook, { x: 360, y: 130, width: 1200, height: 760 }, notebookAlpha);
    drawTopRightLabel(context, "2022.10 · 笔记本  Notebook", notebookAlpha, INK.muted);
    // lines 1 and 2: the sorted catalogue, then the landscape blocks at its foot
    const sheetAlpha = ease(ramp(time, lineStart[1] - 0.1, 0.7)) * (1 - ease(ramp(time, lineStart[2] - 0.5, 0.5)));
    drawPicture(context, assets.sketchSheet, { x: 210, y: 130, width: 1500, height: 760 }, sheetAlpha);
    drawTopRightLabel(context, "2023.08 · 32 个块 → 24 个块  32 blocks, reduced to 24", sheetAlpha, INK.muted);
    const landscapeAlpha = ease(ramp(time, lineStart[2] - 0.1, 0.7));
    drawPicture(context, assets.sketchSheet, { x: 210, y: 180, width: 1500, height: 620 }, landscapeAlpha, SHEET.landscapeBlocks.crop);
    drawTopRightLabel(context, "地面、水面、小桥  Ground, water, a bridge", landscapeAlpha, INK.muted);
}

// --- the blocks, modelled ----------------------------------------------------------------------
function modelShots(scene) {
    return [{ shot: "catalogue", start: 0, end: scene.duration }];
}
function drawModelScene(context, time, scene) {
    drawShots(context, time, scene);
    drawTopRightLabel(context, "Blender · 2023 · 24 种构件  24 kinds of block", ease(ramp(time, 0.8, 0.8)));
}

// --- collapse ----------------------------------------------------------------------------------
// lines 0 to 2: a map collapses cell by cell; lines 3 and 4: the loose results, one kept view after another
function collapseShots(scene) {
    const resultsStart = scene.lineStart[3] - 0.4;
    return [{ shot: "collapse", start: 0, end: resultsStart }].concat(shotsInTurn(resultShotNames(), resultsStart, scene.duration));
}
function drawCollapseScene(context, time, scene) {
    drawShots(context, time, scene);
    const growthAlpha = 1 - ease(ramp(time, scene.lineStart[3] - 0.6, 0.6));
    if (growthAlpha > 0) {
        context.save();
        context.globalAlpha = growthAlpha;
        darkenLeft(context, 0.5);
        context.restore();
    }
    drawBullet(context, 120, 300, "叠加态", "Superposition", growthAlpha * ease(ramp(time, cueTime(scene, 0, "叠加") - 0.2, 0.6)));
    drawBullet(context, 120, 430, "可能性最少者先坍缩", "The fewest possibilities collapse first", growthAlpha * ease(ramp(time, scene.lineStart[1], 0.6)));
    drawBullet(context, 120, 560, "传播：排除邻居的可能", "Propagation narrows the neighbours", growthAlpha * ease(ramp(time, cueTime(scene, 1, "排除") - 0.2, 0.6)));
    drawTopRightLabel(context, "书院造  Shoin-zukuri · 室町时代  Muromachi period", ease(ramp(time, cueTime(scene, 4, "书院造") - 0.3, 0.6)));
}

// --- shaping by hand ---------------------------------------------------------------------------
function playShots(scene) {
    return [{ shot: "play", start: 0, end: scene.duration }];
}
function drawPlayScene(context, time, scene, assets) {
    drawShots(context, time, scene);
    const levels = [["+1", "房屋", "a building"], ["+2", "楼阁", "a pavilion"], ["−1", "水面", "water"]];
    const levelsAlpha = ease(ramp(time, scene.lineStart[0] + 2.0, 0.8));
    if (levelsAlpha > 0) {
        context.save();
        context.globalAlpha = levelsAlpha;
        darkenLeft(context, 0.45);
        context.restore();
    }
    drawText(context, "抬高或降低格点  Raise or lower the points", 120, 250, 30, COLOUR.text, { alpha: levelsAlpha, shadow: true });
    levels.forEach(function (level, index) {
        const alpha = levelsAlpha * ease(ramp(time, scene.lineStart[0] + 2.6 + index * 0.9, 0.6));
        drawText(context, level[0], 120, 350 + index * 110, 48, COLOUR.accent, { alpha: alpha, family: "Consolas", shadow: true });
        drawText(context, level[1], 240, 350 + index * 110, 44, COLOUR.text, { alpha: alpha, family: "YaHeiBold", shadow: true });
        drawText(context, level[2], 242, 386 + index * 110, 24, COLOUR.muted, { alpha: alpha, shadow: true });
    });
    // line 1: Townscaper, for comparison
    const townscaperAlpha = ease(ramp(time, scene.lineStart[1] - 0.2, 0.7));
    drawPicture(context, assets.external.townscaper, { x: 1200, y: 150, width: 640, height: 360 }, townscaperAlpha);
    drawText(context, "图 image: Townscaper © Oskar Stålberg / Raw Fury", 1840, 540, 18, COLOUR.text, { alpha: townscaperAlpha, align: "right", shadow: true });
}

// --- other grids -------------------------------------------------------------------------------
// lines 0 and 1: the three grids seen from above, each with a scheme on it; line 2: the bent grid;
// line 3: the hexagonal grid; line 4: the larger scene by day; then, without words, the same
// scene into the evening and at night (path traced)
function gridFootageStart(scene) {
    return scene.lineStart[2] - 0.4;
}
function gridIsLight(time, scene) {
    return time < gridFootageStart(scene);
}
function gridShots(scene) {
    const bentStart = gridFootageStart(scene), hexStart = scene.lineStart[3] - 0.4, largeStart = scene.lineStart[4] - 0.4;
    const duskStart = scene.lineEnd[4] + 1.2, nightStart = duskStart + 4.5;
    return shotsInTurn(quadShotNames("bent", "bent"), bentStart, hexStart)
        .concat(shotsInTurn(quadShotNames("hex", "hexagonal"), hexStart, largeStart))
        .concat([{ shot: "large_day", start: largeStart, end: duskStart }, { shot: "large_dusk", start: duskStart, end: nightStart }, { shot: "large_night", start: nightStart, end: scene.duration }]);
}
function drawGridScene(context, time, scene, assets) {
    const lineStart = scene.lineStart;
    const plansAlpha = 1 - ease(ramp(time, gridFootageStart(scene) - 0.4, 0.5));
    const grids = [
        ["横平竖直", "straight", assets.diagrams.grid_square, 0.4, false],
        ["轻微扭曲", "gently bent", assets.diagrams.grid_bent, cueTime(scene, 0, "也能放进") - 0.2, false],
        ["自由的四边形网格", "free quads (Stålberg)", assets.diagrams.grid_hexagonal, cueTime(scene, 0, "或固定") + 0.4, true]];
    grids.forEach(function (grid, index) {
        const alpha = plansAlpha * ease(ramp(time, grid[3], 0.7));
        if (alpha <= 0) { return; }
        const left = 150 + index * 570;
        const square = { x: (grid[2].width - grid[2].height * 0.9) / 2, y: grid[2].height * 0.05, width: grid[2].height * 0.9, height: grid[2].height * 0.9 };
        drawPicture(context, grid[2], { x: left, y: 190, width: 480, height: 480 }, alpha, square);
        const isNamed = grid[4] && time > lineStart[1];
        drawText(context, grid[0], left, 740, 40, isNamed ? INK.accent : INK.text, { alpha: alpha, family: "YaHeiBold" });
        drawText(context, grid[1], left, 778, 24, INK.muted, { alpha: alpha });
    });
    drawShots(context, time, scene);
    const shotLabel = function (text, start, end) {
        drawTopRightLabel(context, text, ease(ramp(time, start, 0.6)) * (1 - ease(ramp(time, end - 0.5, 0.5))));
    };
    shotLabel("轻微扭曲的网格  A gently bent grid", lineStart[2], lineStart[3]);
    shotLabel("六边形里的自由四边形网格  Free quads in a hexagon", lineStart[3], lineStart[4]);
    shotLabel("更大的网格，手动布置的建筑群  A larger grid, a group of buildings laid out by hand", lineStart[4], scene.lineEnd[4] + 5.7);
    shotLabel("夜景：光线追踪  Night, path traced", scene.lineEnd[4] + 6.0, scene.duration + 1);
}

// --- ending ------------------------------------------------------------------------------------
// The sketches of what comes next, on white, then the credits
function drawEndingScene(context, time, scene, assets) {
    const lineStart = scene.lineStart;
    const creditsStart = scene.lineEnd[3] + 1.2;
    const firstAlpha = ease(ramp(time, 0.2, 0.8)) * (1 - ease(ramp(time, lineStart[1] - 0.5, 0.5)));
    drawPicture(context, assets.sketch2, { x: 130, y: 130, width: 1100, height: 760 }, firstAlpha);
    drawText(context, "换一套积木", 1300, 440, 54, INK.text, { alpha: firstAlpha, family: "YaHeiBold" });
    drawText(context, "另一套风格", 1300, 520, 54, INK.accent, { alpha: firstAlpha, family: "YaHeiBold" });
    drawText(context, "Another set of blocks, another style", 1302, 566, 26, INK.muted, { alpha: firstAlpha });
    const secondAlpha = ease(ramp(time, lineStart[1] - 0.1, 0.7)) * (1 - ease(ramp(time, creditsStart - 0.5, 0.5)));
    drawPicture(context, assets.sketch3, { x: 110, y: 170, width: 1040, height: 680 }, secondAlpha);
    const steps = [["多套积木拼合", "类型学混合", "Several sets joined: a mixture of typologies", lineStart[1]], ["另一套力学来支配", "更高层级的秩序", "Other forces governing: an order of a higher level", lineStart[2]]];
    steps.forEach(function (step, index) {
        const alpha = secondAlpha * ease(ramp(time, step[3] + 0.1, 0.7));
        const y = 380 + index * 230;
        drawText(context, step[0], 1230, y, 44, INK.text, { alpha: alpha, family: "YaHeiBold" });
        drawText(context, step[1], 1230, y + 62, 44, INK.accent, { alpha: alpha, family: "YaHeiBold" });
        drawText(context, step[2], 1232, y + 102, 22, INK.muted, { alpha: alpha });
    });
    const credits = ease(ramp(time, creditsStart, 1.0));
    if (credits > 0) {
        context.save();
        context.globalAlpha = credits;
        drawText(context, byLanguage(FILM.titleChinese, FILM.titleEnglishFilm), 960, byLanguage(290, 310), byLanguage(72, 60), INK.text, { align: "center", family: "YaHeiBold" });
        drawText(context, byLanguage(FILM.titleEnglish, ""), 960, 344, 28, INK.muted, { align: "center" });
        context.fillStyle = INK.accent;
        context.fillRect(900, 384, 120, 4);
        drawText(context, byLanguage(FILM.authorChinese, FILM.authorEnglish), 960, 456, 40, INK.text, { align: "center" });
        drawText(context, "2022 – 2026  ·  Three.js · Blender  ·  " + FILM.repository, 960, 506, 24, INK.muted, { align: "center" });
        drawText(context, byLanguage("致谢 With thanks to  P小二 · Bruno Simon · Oskar Stålberg · Daniel Shiffman · Maxim Gumin", "With thanks to  Mr. P-xiaoer · Bruno Simon · Oskar Stålberg · Daniel Shiffman · Maxim Gumin"), 960, 580, 26, INK.text, { align: "center" });
        drawText(context, byLanguage("先行者 Earlier WFC work on Chinese architecture: 《重檐》EAVES，KakaBobi Studio (@kakabobi_33)", "Earlier WFC work on classical architecture: EAVES, by KakaBobi Studio (@kakabobi_33)"), 960, 628, 26, INK.text, { align: "center" });
        const sources = [
            byLanguage("图片来源 Picture sources", "Picture sources"),
            "Maxim Gumin, WaveFunctionCollapse (MIT) · threejs-journey.com © Bruno Simon · IndieCade Europe · The Coding Train",
            byLanguage("Townscaper © Oskar Stålberg / Raw Fury · 《重檐》EAVES © KakaBobi Studio / HeartBeat Games · 李诫《营造法式》、梁思成测绘图（公有领域）",
                "Townscaper © Oskar Stålberg / Raw Fury · EAVES © KakaBobi Studio / HeartBeat Games · Yingzao Fashi and Liang Sicheng's surveys (public domain)"),
            byLanguage("故宫 Forbidden City: Güldem Üstün, CC BY 2.0 (Wikimedia Commons) · asiaodysseytravel.com · thebiggestcitiesinchina.com",
                "Güldem Üstün, CC BY 2.0 (Wikimedia Commons) · asiaodysseytravel.com · thebiggestcitiesinchina.com")];
        sources.forEach(function (text, index) {
            drawText(context, text, 960, 716 + index * 36, index === 0 ? 22 : 20, index === 0 ? INK.text : INK.muted, { align: "center" });
        });
        context.restore();
    }
}

// ---------------------------------------------------------------------------
// Frame, subtitles, timeline, encoding
// ---------------------------------------------------------------------------

function drawBackground(context, isLight) {
    context.fillStyle = isLight ? "#ffffff" : COLOUR.background;
    context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
}

function wrapSubtitle(context, text, maximumWidth, splitOnPunctuation) {
    if (context.measureText(text).width <= maximumWidth) { return [text]; }
    if (splitOnPunctuation) {
        let bestIndex = -1;
        for (let index = 1; index < text.length - 1; index++) {
            if ("，。：；、".indexOf(text[index]) >= 0 && (bestIndex < 0 || Math.abs(index - text.length / 2) < Math.abs(bestIndex - text.length / 2))) { bestIndex = index; }
        }
        if (bestIndex > 0) { return [text.slice(0, bestIndex + 1), text.slice(bestIndex + 1)]; }
    }
    const words = text.split(" ");
    let bestSplit = 1, bestDifference = Infinity;
    for (let index = 1; index < words.length; index++) {
        const difference = Math.abs(context.measureText(words.slice(0, index).join(" ")).width - context.measureText(words.slice(index).join(" ")).width);
        if (difference < bestDifference) { bestDifference = difference; bestSplit = index; }
    }
    return [words.slice(0, bestSplit).join(" "), words.slice(bestSplit).join(" ")];
}

function drawSubtitles(context, subtitle, alpha, isLight) {
    if (!subtitle || alpha <= 0) { return; }
    context.save();
    context.globalAlpha = alpha;
    if (!isLight) {
        context.shadowColor = "rgba(0,0,0,0.9)";
        context.shadowBlur = 12;
    }
    if (LANGUAGE === "en") {
        context.font = "40px YaHei";
        const lines = wrapSubtitle(context, subtitle.en, 1560, false);
        let lineY = 1040 - (lines.length - 1) * 50;
        for (const text of lines) { drawText(context, text, 960, lineY, 40, isLight ? INK.text : "#ffffff", { align: "center" }); lineY += 50; }
        context.restore();
        return;
    }
    context.font = "44px YaHei";
    const chineseLines = wrapSubtitle(context, subtitle.zh, 1560, true);
    context.font = "27px YaHei";
    const englishLines = wrapSubtitle(context, subtitle.en, 1500, false);
    let y = 1046 - (englishLines.length - 1) * 34 - 44 - (chineseLines.length - 1) * 56;
    for (const text of chineseLines) { drawText(context, text, 960, y, 44, isLight ? INK.text : "#ffffff", { align: "center" }); y += 56; }
    y -= 12;
    for (const text of englishLines) { drawText(context, text, 960, y, 27, isLight ? INK.muted : "#c2ccd8", { align: "center" }); y += 34; }
    context.restore();
}

function buildTimeline() {
    const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "narration.json"), "utf8"));
    for (const line of lines) {
        line.audioPath = path.join(__dirname, LANGUAGE === "en" ? "voice_en" : "voice", line.name + ".mp3");
        if (LANGUAGE === "en" && line.enFilm) {
            line.en = line.enFilm;
            delete line.parts;
        }
        if (fs.existsSync(line.audioPath)) {
            const probe = childProcess.execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", line.audioPath]);
            line.durationSeconds = parseFloat(String(probe));
        } else {
            // not synthesized yet: an estimate, good enough for previews
            line.durationSeconds = 0.24 * line.text.length;
            line.isEstimated = true;
        }
    }
    let cursor = 0;
    for (const scene of SCENES) {
        scene.start = cursor;
        scene.lines = lines.filter(function (line) { return line.scene === scene.name; });
        scene.lineStart = [];
        scene.lineEnd = [];
        let local = SCENE_LEAD_SECONDS;
        for (const line of scene.lines) {
            line.start = scene.start + local;
            line.end = line.start + line.durationSeconds;
            const lineParts = line.parts || [{ zh: line.zh, en: line.en }];
            let partStart = line.start;
            const spokenLength = function (linePart) { return LANGUAGE === "en" ? linePart.en.length : linePart.zh.length; };
            const totalLength = lineParts.reduce(function (sum, linePart) { return sum + spokenLength(linePart); }, 0);
            line.subtitles = lineParts.map(function (part) {
                const partDuration = line.durationSeconds * spokenLength(part) / totalLength;
                const subtitle = { zh: part.zh, en: part.en, start: partStart, end: partStart + partDuration };
                partStart += partDuration;
                return subtitle;
            });
            scene.lineStart.push(local);
            scene.lineEnd.push(local + line.durationSeconds);
            local += line.durationSeconds + LINE_GAP_SECONDS;
        }
        scene.duration = local - LINE_GAP_SECONDS + SCENE_TAIL_SECONDS + scene.tailSeconds;
        cursor += scene.duration;
        scene.end = cursor;
    }
    return { lines: lines, totalSeconds: cursor };
}

function sceneAt(time) {
    for (const candidate of SCENES) {
        if (time < candidate.end) { return candidate; }
    }
    return SCENES[SCENES.length - 1];
}

function footageRequestsAt(time) {
    const scene = sceneAt(time);
    return activeShots(time - scene.start, scene).map(function (part) { return shotFrameRequest(part, time - scene.start); });
}

function renderFrame(context, time, timeline, assets) {
    const scene = sceneAt(time);
    const local = time - scene.start;
    skippedHeadline = null;
    const isLight = sceneIsLight(scene, local);
    drawBackground(context, isLight);
    context.save();
    scene.draw(context, local, scene, assets);
    context.restore();
    if (scene.chapter) {
        const alpha = ease(ramp(local, 0.1, 0.6));
        context.fillStyle = COLOUR.accent;
        context.globalAlpha = alpha;
        context.fillRect(60, 64, 6, 34);
        context.globalAlpha = 1;
        drawText(context, scene.chapter, 82, 92, 28, isLight ? INK.text : COLOUR.text, { alpha: alpha, shadow: !isLight });
    }
    context.fillStyle = isLight ? INK.line : COLOUR.line;
    context.fillRect(0, 0, FRAME_WIDTH, 4);
    context.fillStyle = COLOUR.accent;
    context.fillRect(0, 0, FRAME_WIDTH * time / timeline.totalSeconds, 4);
    let currentSubtitle = null;
    for (const line of timeline.lines) {
        for (const subtitle of line.subtitles) {
            const isLast = subtitle === line.subtitles[line.subtitles.length - 1];
            if (time >= subtitle.start - (subtitle === line.subtitles[0] ? 0.1 : 0) && time <= subtitle.end + (isLast ? 0.3 : 0)) { currentSubtitle = subtitle; }
        }
    }
    if (currentSubtitle) {
        if (!isLight) {
            const gradient = context.createLinearGradient(0, 860, 0, 1080);
            gradient.addColorStop(0, "rgba(13,17,23,0)");
            gradient.addColorStop(1, "rgba(13,17,23,0.92)");
            context.fillStyle = gradient;
            context.fillRect(0, 860, FRAME_WIDTH, 220);
        }
        drawSubtitles(context, currentSubtitle, Math.min(ramp(time, currentSubtitle.start - 0.1, 0.2), 1 - ramp(time, currentSubtitle.end + 0.1, 0.2)), isLight);
    }
    // dip between scenes: to white out of a white scene, to black out of a dark one
    const edge = Math.min(local, scene.duration - local);
    const isFilmStart = scene === SCENES[0] && local < 1, isFilmEnd = scene === SCENES[SCENES.length - 1] && scene.duration - local < 1.2;
    const dip = isFilmStart || isFilmEnd ? 1 - clamp01(edge / 1.0) : 1 - clamp01(edge / 0.35);
    if (dip > 0) {
        context.fillStyle = "rgba(" + (isLight && !isFilmEnd ? "255,255,255," : "8,10,12,") + (isFilmStart || isFilmEnd ? dip : dip * 0.85).toFixed(3) + ")";
        context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    }
}

function subtitleTimestamp(seconds) {
    const milliseconds = Math.round(seconds * 1000);
    const pad = function (value, length) { return String(value).padStart(length, "0"); };
    return pad(Math.floor(milliseconds / 3600000), 2) + ":" + pad(Math.floor(milliseconds / 60000) % 60, 2) + ":" + pad(Math.floor(milliseconds / 1000) % 60, 2) + "," + pad(milliseconds % 1000, 3);
}

async function main() {
    const argumentList = process.argv.slice(2);
    const previewIndex = argumentList.indexOf("--preview");
    const outputIndex = argumentList.indexOf("--output");
    const languageIndex = argumentList.indexOf("--language");
    LANGUAGE = languageIndex >= 0 ? argumentList[languageIndex + 1] : "zh";
    const outputPath = path.join(__dirname, outputIndex >= 0 ? argumentList[outputIndex + 1] : byLanguage("Chinese_Architecture_WFC.mp4", "Architecture_WFC_EN.mp4"));

    const timeline = buildTimeline();
    console.log("film length: " + timeline.totalSeconds.toFixed(1) + " s");
    for (const scene of SCENES) { console.log("  " + scene.name.padEnd(10) + scene.start.toFixed(1).padStart(7) + " → " + scene.end.toFixed(1)); }
    const estimatedLines = timeline.lines.filter(function (line) { return line.isEstimated; });
    if (estimatedLines.length > 0) { console.log("  " + estimatedLines.length + " lines have no voice yet: their lengths are estimates"); }
    if (argumentList.includes("--shots")) {
        if (estimatedLines.length > 0) { throw new Error("the shots can only be planned once every line has its voice"); }
        const shotsPath = path.join(__dirname, byLanguage("shots.json", "shots_en.json"));
        fs.writeFileSync(shotsPath, JSON.stringify(shotList(), null, 1));
        console.log("wrote " + shotsPath);
        return;
    }

    const photo = function (name) { return loadImage(path.join(__dirname, "photos", name)); };
    const assets = {
        notebook: await photo("notebook_2022.jpg"),
        sketchSheet: await photo("sketch_2023_full.jpg"),
        sketch2: await photo("sketch2.jpg"),
        sketch3: await photo("sketch3.jpg"),
        floorPlanModels: await photo("floorplan_models_2022.png"),
        external: {
            guminRoomsTile: await photo("external/gumin_rooms_tile.png"),
            guminSheetFull: await photo("external/gumin_wfc.png"),
            liangHall: await photo("external/liang_mani_hall.png"),
            guminCastle: await photo("external/gumin_castle-3d.png"),
            guminCastles: await photo("external/gumin_castles-3d.png"),
            guminRooms: await photo("external/gumin_rooms.png"),
            townscaper: await photo("external/townscaper_3.jpg"),
            codingTrain: await photo("external/codingtrain_171.jpg"),
            threeJourney: await photo("external/threejs_journey.png"),
            stalbergTalk: await photo("external/stalberg_indiecade_2019.jpg"),
            liangPavilion: await photo("external/liang_zhuanlunzang.png"),
            yingzaoBrackets: await photo("external/yingzao_fashi_5.jpg"),
            yingzaoJoints: await photo("external/yingzao_fashi_2.jpg"),
            pingyao: await photo("external/pingyao_asiaodyssey.jpg"),
            xijiang: await photo("external/ancient_cities_10.jpg"),
            forbiddenCity: await photo("external/forbidden_city_aerial.jpg"),
            eavesTown: await photo("external/eaves_3.jpg"),
            eavesStreet: await photo("external/eaves_1.jpg")
        },
        // stills of the real blocks, made by capture_footage.js diagrams
        diagrams: {}
    };
    for (const name of ["joint_hall", "gutter", "pit", "grid_square", "grid_bent", "grid_hexagonal",
        "mismatch", "join_1_apart", "join_1_joined", "join_2_apart", "join_2_joined", "join_3_apart", "join_3_joined"]) {
        assets.diagrams[name] = await loadImage(path.join(FOOTAGE_DIRECTORY, "diagrams", name + ".jpg"));
    }

    const canvas = createCanvas(FRAME_WIDTH, FRAME_HEIGHT);
    const context = canvas.getContext("2d");

    if (argumentList.includes("--cover")) {
        // the cover pictures: the Chinese one and the English one
        for (const language of ["zh", "en"]) {
            drawBackground(context, false);
            drawCoverArt(context, assets, language, function () { return 1; });
            const coverPath = path.join(__dirname, "cover_" + language + "_1920x1080.png");
            fs.writeFileSync(coverPath, canvas.toBuffer("image/png"));
            console.log("wrote " + coverPath);
            const uprightCanvas = createCanvas(UPRIGHT_COVER_WIDTH, UPRIGHT_COVER_HEIGHT);
            drawUprightCoverArt(uprightCanvas.getContext("2d"), assets, language);
            const uprightPath = path.join(__dirname, "cover_" + language + "_" + UPRIGHT_COVER_WIDTH + "x" + UPRIGHT_COVER_HEIGHT + ".png");
            fs.writeFileSync(uprightPath, uprightCanvas.toBuffer("image/png"));
            console.log("wrote " + uprightPath);
        }
        return;
    }
    if (previewIndex >= 0) {
        const previewDirectory = path.join(__dirname, "preview");
        fs.mkdirSync(previewDirectory, { recursive: true });
        for (const timeText of argumentList[previewIndex + 1].split(",")) {
            const time = parseFloat(timeText);
            await loadFootageImages(footageRequestsAt(time));
            renderFrame(context, time, timeline, assets);
            const framePath = path.join(previewDirectory, "frame-" + time.toFixed(1).padStart(6, "0") + ".jpg");
            fs.writeFileSync(framePath, canvas.toBuffer("image/jpeg", 85));
            console.log("wrote " + framePath);
        }
        return;
    }

    const allSubtitles = [];
    for (const line of timeline.lines) { allSubtitles.push.apply(allSubtitles, line.subtitles); }
    fs.writeFileSync(outputPath.replace(/\.mp4$/, ".srt"), allSubtitles.map(function (subtitle, subtitleIndex) {
        return (subtitleIndex + 1) + "\n" + subtitleTimestamp(subtitle.start) + " --> " + subtitleTimestamp(subtitle.end) + "\n" + byLanguage(subtitle.zh + "\n", "") + subtitle.en + "\n";
    }).join("\n"), "utf8");

    const ffmpegArguments = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", FRAME_WIDTH + "x" + FRAME_HEIGHT, "-r", String(FRAMES_PER_SECOND), "-i", "pipe:0"];
    const filterParts = [];
    timeline.lines.forEach(function (line, lineIndex) {
        ffmpegArguments.push("-i", line.audioPath);
        filterParts.push("[" + (lineIndex + 1) + ":a]aresample=48000,adelay=" + Math.round(line.start * 1000) + ":all=1[a" + lineIndex + "]");
    });
    const mixInputs = timeline.lines.map(function (line, lineIndex) { return "[a" + lineIndex + "]"; }).join("");
    filterParts.push(mixInputs + "amix=inputs=" + timeline.lines.length + ":normalize=0,apad=whole_dur=" + timeline.totalSeconds.toFixed(3) + ",loudnorm=I=-16:TP=-1.5:LRA=11[narration]");
    ffmpegArguments.push("-filter_complex", filterParts.join(";"), "-map", "0:v", "-map", "[narration]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", timeline.totalSeconds.toFixed(3), "-movflags", "+faststart", outputPath);
    const ffmpeg = childProcess.spawn("ffmpeg", ffmpegArguments, { stdio: ["pipe", "ignore", "inherit"] });
    const finished = new Promise(function (resolve, reject) {
        ffmpeg.on("close", function (exitCode) { if (exitCode === 0) { resolve(); } else { reject(new Error("ffmpeg exited with code " + exitCode)); } });
    });
    const frameCount = Math.ceil(timeline.totalSeconds * FRAMES_PER_SECOND);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const time = frameIndex / FRAMES_PER_SECOND;
        await loadFootageImages(footageRequestsAt(time));
        renderFrame(context, time, timeline, assets);
        const pixels = context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data;
        const canContinue = ffmpeg.stdin.write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength));
        if (!canContinue) { await new Promise(function (resolve) { ffmpeg.stdin.once("drain", resolve); }); }
        if (frameIndex % 300 === 0) { console.log("frame " + frameIndex + " / " + frameCount); }
    }
    ffmpeg.stdin.end();
    await finished;
    console.log("wrote " + outputPath);
}

main().catch(function (error) {
    console.error(error);
    process.exit(1);
});
