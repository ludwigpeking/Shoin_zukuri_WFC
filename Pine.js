// Purpose: Generates a Japanese black pine (kuromatsu) in the garden style (niwaki): a leaning,
// curving trunk with near-horizontal limbs and side branches, each ending in flat, smooth pads
// of needles, with clear gaps between the pads. Small trees stay simple (a few limbs, one pad
// each); big trees get more limbs, side branches and small clusters of stepped pads on twigs,
// so a full-grown pine reads as many layered clouds.
//
// The whole tree is two meshes, one for the wood and one for the needles, so a scene with many
// trees stays cheap to draw. The look comes from geometry, vertex colours and plain
// MeshStandardMaterial properties only, so the path tracer shows the same tree as the normal view.
//
// The shapes are kept clean on purpose: every pad is one smooth surface whose outline varies only
// gently, pads are never placed where they would run into another pad, and every limb, branch and
// twig starts thinner than what it grows from and tapers evenly, so nothing reads as a swelling.
import * as THREE from 'three';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';

// A rough surface for the needle pads, in the normal view: a pad is not a smooth cushion but a
// mass of needle tufts. Noise in the position of the scene, at the size of a tuft and of a needle,
// darkens the hollows between the tufts and lightens their tips, and tilts the shading normal by
// the slope of the same noise, so the light breaks up over the pad. The shape stays as it is, so
// nothing bulges; the path tracer, which does not run this shader, sees the smooth pad.
const tuftSize = 0.24;            // metres
const needleSize = 0.07;          // metres
const needleBumpStrength = 1.2;
function roughenNeedles(material) {
    material.onBeforeCompile = function (shader) {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
                varying vec3 vNeedleWorldPosition;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                vNeedleWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                varying vec3 vNeedleWorldPosition;
                float needleHash(vec3 position) {
                    position = fract(position * 0.3183099 + 0.1);
                    position *= 17.0;
                    return fract(position.x * position.y * position.z * (position.x + position.y + position.z));
                }
                float needleNoise(vec3 position) {
                    vec3 cell = floor(position);
                    vec3 fraction = fract(position);
                    vec3 blend = fraction * fraction * (3.0 - 2.0 * fraction);
                    return mix(mix(mix(needleHash(cell), needleHash(cell + vec3(1.0, 0.0, 0.0)), blend.x),
                                   mix(needleHash(cell + vec3(0.0, 1.0, 0.0)), needleHash(cell + vec3(1.0, 1.0, 0.0)), blend.x), blend.y),
                               mix(mix(needleHash(cell + vec3(0.0, 0.0, 1.0)), needleHash(cell + vec3(1.0, 0.0, 1.0)), blend.x),
                                   mix(needleHash(cell + vec3(0.0, 1.0, 1.0)), needleHash(cell + vec3(1.0, 1.0, 1.0)), blend.x), blend.y), blend.z);
                }
                // tufts, with needles over them; 0 in the hollows, 1 at the tips
                float needleSurface(vec3 position) {
                    return 0.7 * needleNoise(position / ${tuftSize.toFixed(3)}) + 0.3 * needleNoise(position / ${needleSize.toFixed(3)} + 31.7);
                }`)
            .replace('#include <color_fragment>', `#include <color_fragment>
                float needleHeight = needleSurface(vNeedleWorldPosition);
                diffuseColor.rgb *= 0.5 + 0.75 * needleHeight;
                diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.1, 0.85), smoothstep(0.6, 0.9, needleHeight));`)
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                {
                    float sampleDistance = ${(needleSize * 0.35).toFixed(4)};
                    vec3 slope = vec3(
                        needleSurface(vNeedleWorldPosition + vec3(sampleDistance, 0.0, 0.0)) - needleHeight,
                        needleSurface(vNeedleWorldPosition + vec3(0.0, sampleDistance, 0.0)) - needleHeight,
                        needleSurface(vNeedleWorldPosition + vec3(0.0, 0.0, sampleDistance)) - needleHeight) / sampleDistance;
                    vec3 viewSlope = (viewMatrix * vec4(slope, 0.0)).xyz;
                    viewSlope -= normal * dot(viewSlope, normal); // only the part along the surface tilts it
                    normal = normalize(normal - ${needleBumpStrength.toFixed(2)} * ${needleSize.toFixed(3)} * viewSlope);
                }`);
    };
    material.customProgramCacheKey = function () {
        return 'roughNeedles';
    };
}

class PineTree {
    constructor(height, x, z, expansion = 1, slenderness = 28, trunkRatio = 0.35, curve = true, leafColor = 0x4b5c33, castShadow = true) {
        this.height = height; // nominal size of the tree from the map, 0 to 24
        this.x = x;
        this.z = z;
        this.expansion = expansion; // how far the limbs reach out, 1 is normal
        this.slenderness = slenderness; // tree height divided by trunk diameter, 30-50 is normal
        this.trunkRatio = trunkRatio; // share of the height that is bare trunk below the first limb, 0.3-0.4 is normal
        this.curve = curve; // leaning, winding trunk (true) or a nearly straight one
        this.leafColor = leafColor; // the middle colour of the needles
        this.castShadow = castShadow; // cast shadow or not
        // The same map position and size always give the same tree, so a replanted or
        // regenerated garden does not change its trees' shapes.
        this.random = createSeededRandom(hashNumbers(Math.round(x * 100), Math.round(z * 100), Math.round(height * 10)));
        this.noiseSeed = Math.floor(this.random() * 100000);
        // envMapIntensity follows the time of day of the scene (PineTree.environmentIntensity).
        // The colour comes from the vertex colours; the material colour stays white so it does not tint them.
        this.woodMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: PineTree.environmentIntensity });
        // Needles are opaque and matte: a pad of needles scatters light softly and hides what is behind it
        this.leafMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: PineTree.environmentIntensity });
        roughenNeedles(this.leafMaterial);
        this.leafs = 0; // number of needle pads
        this.placedPads = []; // centre, outer radius and vertical extent of every pad, to keep the next ones clear of them
        this.generateTree(); // must be the last called
    }

    generateTree() {
        this.treeGroup = new THREE.Group();
        this.treeGroup.position.set(this.x, 0, this.z);
        this.treeGroup.userData.pineSize = this.height;
        const random = this.random;
        const woodSurface = new SurfaceBuilder();
        const needleSurface = new SurfaceBuilder();

        // The map's sizes run to 24; the trees are kept at the scale of the buildings,
        // so the tallest is about 16 m and the smallest a 1.2 m shrub-like pine.
        const treeHeight = 1.2 + 0.63 * Math.max(this.height, 0);
        // How much structure the tree gets: 0 keeps a small tree simple, 1 is a full-grown pine
        // with many limbs, side branches and clusters of small pads
        const detailShare = THREE.MathUtils.clamp((treeHeight - 4) / 10, 0, 1);
        this.detailShare = detailShare;
        const trunkTopHeight = treeHeight * 0.86; // the crown pads rise above the trunk's end
        const trunkBaseRadius = (0.04 + treeHeight / this.slenderness) / 2 * (0.85 + 0.3 * random());
        const firstLimbShare = this.trunkRatio * (0.8 + 0.5 * Math.min(1, treeHeight / 16));
        const lastLimbShare = 0.84;

        // The trunk leans to one side and winds a little on its way up, as old garden pines do.
        // Taller trunks get more control points, each nudged a little aside, so the trunk changes
        // direction slightly from tier to tier like a pine that has been pruned for decades.
        const leanAngle = random() * Math.PI * 2;
        const leanDirection = new THREE.Vector3(Math.cos(leanAngle), 0, Math.sin(leanAngle));
        const windDirection = new THREE.Vector3(-leanDirection.z, 0, leanDirection.x);
        const leanDistance = treeHeight * (this.curve ? 0.06 + 0.14 * random() : 0.02);
        const windDistance = treeHeight * (this.curve ? 0.03 + 0.04 * random() : 0.01);
        const windPhase = random() * Math.PI * 2;
        const kinkDistance = treeHeight * 0.012 * detailShare;
        const trunkControlPoints = [];
        const trunkControlPointCount = 5 + Math.round(3 * detailShare);
        for (let pointIndex = 0; pointIndex < trunkControlPointCount; pointIndex++) {
            const heightShare = pointIndex / (trunkControlPointCount - 1);
            const point = new THREE.Vector3(0, heightShare * trunkTopHeight, 0);
            point.addScaledVector(leanDirection, leanDistance * Math.pow(heightShare, 1.4));
            point.addScaledVector(windDirection, windDistance * heightShare * Math.sin(heightShare * Math.PI * 1.4 + windPhase));
            if (pointIndex > 0) {
                const kinkAngle = random() * Math.PI * 2;
                point.x += Math.cos(kinkAngle) * kinkDistance;
                point.z += Math.sin(kinkAngle) * kinkDistance;
            }
            trunkControlPoints.push(point);
        }
        const trunkCurve = new THREE.CatmullRomCurve3(trunkControlPoints, false, 'centripetal');
        const trunkRadiusAt = function (lengthShare) {
            // thins evenly, and faster in the crown where the limbs have taken their share;
            // spreads a little where it meets the ground
            const crownThinning = 0.2 * smoothStep(THREE.MathUtils.clamp((lengthShare - firstLimbShare) / (1 - firstLimbShare), 0, 1));
            const groundFlare = 1 + 0.35 * Math.pow(Math.max(0, 1 - lengthShare / 0.08), 2);
            return trunkBaseRadius * (1 - 0.55 * lengthShare - crownThinning) * groundFlare;
        };
        this.addBark(woodSurface, trunkCurve, trunkRadiusAt, 12 + Math.round(14 * detailShare), 6 + Math.round(4 * detailShare), true);

        // the crown: rounder pads over the end of the trunk, placed first so the limbs keep clear of them
        const trunkTop = trunkCurve.getPoint(1);
        const crownPadRadius = (0.25 + treeHeight * 0.115) * (1 - 0.3 * detailShare);
        this.addPadCluster(woodSurface, needleSurface, trunkTop, leanDirection, crownPadRadius, trunkRadiusAt(1), 0.58, Math.round(2 * detailShare));

        // The main limbs leave the trunk in tiers, turning around it by about the golden angle
        // so that the pads spread around the tree instead of stacking on top of one another
        const limbCount = Math.max(2, Math.min(10, Math.round(1.2 + treeHeight / 1.7)));
        const crownReach = treeHeight * 0.38 * this.expansion;
        let limbAzimuth = random() * Math.PI * 2;
        for (let limbIndex = 0; limbIndex < limbCount; limbIndex++) {
            const tierShare = limbCount > 1 ? limbIndex / (limbCount - 1) : 0; // 0 at the lowest limb, 1 at the highest
            const attachShare = firstLimbShare + (lastLimbShare - firstLimbShare) * tierShare + (random() - 0.5) * 0.03;
            limbAzimuth += 2.4 + (random() - 0.5) * 0.5;
            const limbDirection = new THREE.Vector3(Math.cos(limbAzimuth), 0, Math.sin(limbAzimuth));
            const limbLength = crownReach * (1 - 0.5 * tierShare) * (0.8 + 0.35 * random());
            // in a big tree the foliage is split into many smaller clouds rather than a few large discs
            const limbPadRadius = (0.22 + treeHeight * (0.1 + 0.05 * (1 - tierShare)) * (0.9 + 0.2 * random())) * (1 - 0.25 * detailShare);
            const attachPoint = trunkCurve.getPointAt(attachShare);
            const limbCurve = this.makeLimbCurve(attachPoint, limbDirection, limbLength);
            // a limb starts at half the trunk's thickness there, so the joint shows no swelling
            const limbBaseRadius = Math.max(0.01, trunkRadiusAt(attachShare) * 0.5);
            const limbRadiusAt = makeTaper(limbBaseRadius, 0.35);
            const subPadCount = Math.round(detailShare * (1.4 + random()));
            const endPadPlaced = this.addPadCluster(woodSurface, needleSurface, limbCurve.getPoint(1), limbDirection, limbPadRadius, limbRadiusAt(1), 0.46, subPadCount);

            // Side branches leave the limb on alternating sides, each carrying its own smaller
            // cloud; there are more of them on the long lower limbs of a big tree
            const sideBranchCount = Math.round(detailShare * (1.9 - 1.1 * tierShare) + random() * 0.5);
            let sideBranchPlaced = false;
            let turnSide = random() < 0.5 ? 1 : -1;
            for (let sideIndex = 0; sideIndex < sideBranchCount; sideIndex++) {
                const forkShare = 0.3 + 0.5 * (sideIndex + 0.5) / sideBranchCount + (random() - 0.5) * 0.08;
                turnSide = -turnSide;
                const sideAzimuth = limbAzimuth + turnSide * (0.8 + 0.5 * random());
                const sideDirection = new THREE.Vector3(Math.cos(sideAzimuth), 0, Math.sin(sideAzimuth));
                const sideLength = limbLength * (0.3 + 0.15 * random()) * (1.1 - 0.4 * forkShare);
                const sideCurve = this.makeLimbCurve(limbCurve.getPoint(forkShare), sideDirection, sideLength);
                // thinner than the limb where it leaves it
                const sideBaseRadius = limbRadiusAt(forkShare) * 0.6;
                const sidePadRadius = limbPadRadius * (0.68 + 0.14 * random());
                const sidePadPlaced = this.addPadCluster(woodSurface, needleSurface, sideCurve.getPoint(1), sideDirection, sidePadRadius, sideBaseRadius * 0.4, 0.48, Math.round(detailShare * random()));
                if (sidePadPlaced) {
                    this.addBark(woodSurface, sideCurve, makeTaper(sideBaseRadius, 0.4), 6, detailShare > 0.5 ? 5 : 4, false);
                    sideBranchPlaced = true;
                }
            }
            // a limb with no foliage at all would be a bare stick: it is left out
            if (endPadPlaced || sideBranchPlaced) {
                this.addBark(woodSurface, limbCurve, limbRadiusAt, 6 + Math.round(2 * detailShare), 5, false);
            }
        }

        const woodMesh = new THREE.Mesh(woodSurface.toGeometry(), this.woodMaterial);
        const needleMesh = new THREE.Mesh(needleSurface.toGeometry(), this.leafMaterial);
        this.treeGroup.add(woodMesh);
        this.treeGroup.add(needleMesh);
    }

    // A limb goes out almost level, sags a little and turns up at its tip, where the pad sits.
    // Returns the limb's centre line.
    makeLimbCurve(startPoint, direction, length) {
        const random = this.random;
        const upward = new THREE.Vector3(0, 1, 0);
        const sideways = new THREE.Vector3(-direction.z, 0, direction.x);
        const sideDrift = (random() - 0.5) * 0.16;
        const firstPoint = startPoint.clone().addScaledVector(direction, length * 0.35).addScaledVector(upward, length * (0.05 + 0.05 * random()));
        const secondPoint = startPoint.clone().addScaledVector(direction, length * 0.7).addScaledVector(sideways, length * sideDrift).addScaledVector(upward, length * 0.03);
        const tipPoint = startPoint.clone().addScaledVector(direction, length).addScaledVector(sideways, length * sideDrift * 1.2).addScaledVector(upward, length * 0.08);
        return new THREE.CatmullRomCurve3([startPoint.clone(), firstPoint, secondPoint, tipPoint], false, 'centripetal');
    }

    // The foliage at the end of a branch: one pad over the tip, and in a bigger tree up to a few
    // smaller pads around it, stepped up or down, each held by a short twig from the tip.
    // Every pad keeps the gap to the others. Returns whether any pad was placed.
    addPadCluster(woodSurface, needleSurface, branchTip, outwardDirection, padRadius, tipRadius, thicknessShare, extraPadCount) {
        const random = this.random;
        const mainPadRadius = extraPadCount > 0 ? padRadius * 0.8 : padRadius;
        const mainPad = this.fitNeedlePad(branchTip, mainPadRadius, thicknessShare);
        this.addNeedlePad(needleSurface, mainPad);
        let anyPadPlaced = Boolean(mainPad);
        const twigBaseRadius = Math.max(0.006, tipRadius * 0.75);
        const outwardAzimuth = Math.atan2(outwardDirection.z, outwardDirection.x);
        let turnSide = random() < 0.5 ? 1 : -1;
        for (let extraIndex = 0; extraIndex < extraPadCount; extraIndex++) {
            turnSide = -turnSide;
            const extraRadius = padRadius * (0.56 + 0.12 * random());
            const extraAzimuth = outwardAzimuth + turnSide * (0.5 + 0.8 * random()) + (extraIndex >= 2 ? Math.PI * 0.5 * turnSide : 0);
            const extraDistance = (mainPadRadius + extraRadius) * (0.8 + 0.15 * random());
            // alternately a step down and a step up, so the clouds layer instead of merging
            const stepHeight = mainPadRadius * thicknessShare * (extraIndex % 2 === 0 ? -1.1 : 0.9) * (0.8 + 0.4 * random());
            const twigEnd = branchTip.clone().add(new THREE.Vector3(Math.cos(extraAzimuth) * extraDistance, stepHeight, Math.sin(extraAzimuth) * extraDistance));
            const extraPad = this.fitNeedlePad(twigEnd, extraRadius, thicknessShare + 0.04);
            if (!extraPad) {
                continue;
            }
            this.addNeedlePad(needleSurface, extraPad);
            anyPadPlaced = true;
            // the twig rises from the branch tip in a gentle arc and ends inside the pad's underside
            const twigMiddle = branchTip.clone().lerp(twigEnd, 0.5);
            twigMiddle.y += extraDistance * 0.08;
            const twigCurve = new THREE.CatmullRomCurve3([branchTip.clone(), twigMiddle, twigEnd], false, 'centripetal');
            this.addBark(woodSurface, twigCurve, makeTaper(twigBaseRadius, 0.5), 4, 4, false);
        }
        return anyPadPlaced;
    }

    // Decides where a pad can go: it is shrunk until it keeps a clear gap to every pad already
    // placed at a similar height, and refused (null) if it would have to shrink too much.
    // The pad's thickness is given as a share of its radius.
    fitNeedlePad(branchTip, desiredRadius, thicknessShare) {
        const random = this.random;
        const outlineWobble = 0.06; // the most the outline strays from an ellipse, as a share of the radius
        let radius = desiredRadius;
        const topHeight = desiredRadius * thicknessShare;
        const undersideDepth = topHeight * 0.4;
        // the pad sits a little above the branch tip, so the branch enters it from below
        const centre = branchTip.clone();
        centre.y += undersideDepth * 0.6;
        const gapShare = 1.08;
        for (let padIndex = 0; padIndex < this.placedPads.length; padIndex++) {
            const otherPad = this.placedPads[padIndex];
            const verticalDistance = centre.y - otherPad.centre.y;
            // above the other pad: this pad's underside against the other's top, and the reverse below it
            const verticalClearance = verticalDistance > 0
                ? verticalDistance - undersideDepth - otherPad.topHeight
                : -verticalDistance - topHeight - otherPad.undersideDepth;
            if (verticalClearance > Math.max(0.3, 0.5 * radius)) {
                continue; // clearly above or below: no conflict
            }
            const horizontalDistance = Math.hypot(centre.x - otherPad.centre.x, centre.z - otherPad.centre.z);
            const allowedRadius = horizontalDistance / gapShare - otherPad.outerRadius;
            radius = Math.min(radius, allowedRadius / (1 + outlineWobble));
        }
        if (radius < desiredRadius * 0.55) {
            return null;
        }
        const shrinkShare = radius / desiredRadius;
        const pad = {
            centre: centre,
            radius: radius,
            outerRadius: radius * (1 + outlineWobble),
            topHeight: topHeight * shrinkShare * (0.9 + 0.2 * random()),
            undersideDepth: undersideDepth * shrinkShare,
            // a roughly elliptical outline turned to a random direction, with a gentle, slow wobble
            widthShare: 0.75 + 0.2 * random(),
            turnAngle: random() * Math.PI,
            ovalWobble: outlineWobble * 0.6 * random(),
            ovalWobblePhase: random() * Math.PI * 2,
            threeLobeWobble: outlineWobble * 0.4 * random(),
            threeLobeWobblePhase: random() * Math.PI * 2,
            domeTilt: 0.1 * random(),
            domeTiltPhase: random() * Math.PI * 2,
        };
        this.placedPads.push(pad);
        return pad;
    }

    // A pad of needles: one smooth surface, domed on top and nearly flat underneath with a
    // rounded rim, as the pads of a pruned pine are. The underside and the rim's lower half are
    // darker, as the needles shade them; the top facing the sky is lighter and a little yellower.
    addNeedlePad(needleSurface, pad) {
        if (!pad) {
            return;
        }
        const random = this.random;
        this.leafs += 1;
        const roundSegments = pad.radius > 1.2 ? 20 : (pad.radius > 0.6 ? 16 : 12);
        const latitudeSegments = pad.radius > 0.6 ? 8 : 7;
        const padColour = new THREE.Color(this.leafColor).offsetHSL((random() - 0.5) * 0.03, (random() - 0.5) * 0.1, (random() - 0.5) * 0.05);
        const sunlitTint = new THREE.Color(0x9ea25a); // warm, pale yellow-green of the sunlit needle tips
        const turnCosine = Math.cos(pad.turnAngle);
        const turnSine = Math.sin(pad.turnAngle);

        // The vertices: the top point, rings from top to bottom, and the bottom point.
        // Each ring is closed without a repeated seam vertex, so the shading has no seam.
        const positions = [];
        function addSurfacePoint(polarAngle, roundAngle) {
            const polarCosine = Math.cos(polarAngle);
            const polarSine = Math.max(0, Math.sin(polarAngle));
            let horizontalShare;
            let height;
            if (polarCosine >= 0) {
                // the top: a soft dome, a little higher on one side
                horizontalShare = Math.pow(polarSine, 0.8);
                height = pad.topHeight * polarCosine * (1 + pad.domeTilt * Math.cos(roundAngle + pad.domeTiltPhase));
            } else {
                // the underside: a full, rounded rim turning into an almost flat bottom
                horizontalShare = Math.pow(polarSine, 0.45);
                height = -pad.undersideDepth * Math.pow(-polarCosine, 0.4);
            }
            const outlineRadius = pad.radius * (1
                + pad.ovalWobble * Math.cos(2 * roundAngle + pad.ovalWobblePhase)
                + pad.threeLobeWobble * Math.cos(3 * roundAngle + pad.threeLobeWobblePhase));
            const alongX = outlineRadius * horizontalShare * Math.cos(roundAngle);
            const alongZ = outlineRadius * horizontalShare * Math.sin(roundAngle) * pad.widthShare;
            positions.push(
                pad.centre.x + alongX * turnCosine - alongZ * turnSine,
                pad.centre.y + height,
                pad.centre.z + alongX * turnSine + alongZ * turnCosine);
        }
        addSurfacePoint(0, 0);
        for (let ringIndex = 1; ringIndex < latitudeSegments; ringIndex++) {
            const polarAngle = ringIndex / latitudeSegments * Math.PI;
            for (let roundIndex = 0; roundIndex < roundSegments; roundIndex++) {
                addSurfacePoint(polarAngle, roundIndex / roundSegments * Math.PI * 2);
            }
        }
        addSurfacePoint(Math.PI, 0);
        const bottomPointIndex = positions.length / 3 - 1;

        const indices = [];
        function ringVertex(ringIndex, roundIndex) {
            return 1 + (ringIndex - 1) * roundSegments + (roundIndex % roundSegments);
        }
        for (let roundIndex = 0; roundIndex < roundSegments; roundIndex++) {
            indices.push(0, ringVertex(1, roundIndex + 1), ringVertex(1, roundIndex));
            indices.push(bottomPointIndex, ringVertex(latitudeSegments - 1, roundIndex), ringVertex(latitudeSegments - 1, roundIndex + 1));
        }
        for (let ringIndex = 1; ringIndex < latitudeSegments - 1; ringIndex++) {
            for (let roundIndex = 0; roundIndex < roundSegments; roundIndex++) {
                const upperVertex = ringVertex(ringIndex, roundIndex);
                const upperNextVertex = ringVertex(ringIndex, roundIndex + 1);
                const lowerVertex = ringVertex(ringIndex + 1, roundIndex);
                const lowerNextVertex = ringVertex(ringIndex + 1, roundIndex + 1);
                indices.push(upperVertex, upperNextVertex, lowerVertex);
                indices.push(upperNextVertex, lowerNextVertex, lowerVertex);
            }
        }
        const padGeometry = new THREE.BufferGeometry();
        padGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        padGeometry.setIndex(indices);
        padGeometry.computeVertexNormals();
        const padNormals = padGeometry.attributes.normal;

        const firstVertexIndex = needleSurface.vertexCount();
        const surfacePoint = new THREE.Vector3();
        const surfaceNormal = new THREE.Vector3();
        const vertexColour = new THREE.Color();
        const colourFrequency = 0.6 / pad.radius; // about one slow change of shade across a pad
        for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex++) {
            surfacePoint.fromArray(positions, vertexIndex * 3);
            surfaceNormal.fromBufferAttribute(padNormals, vertexIndex);
            const skyFacing = surfaceNormal.y * 0.5 + 0.5;
            const heightShare = THREE.MathUtils.clamp((surfacePoint.y - pad.centre.y + pad.undersideDepth) / (pad.topHeight + pad.undersideDepth), 0, 1);
            const shadeVariation = valueNoise(surfacePoint.x * colourFrequency, surfacePoint.y * colourFrequency, surfacePoint.z * colourFrequency, this.noiseSeed);
            // the underside stays well above black: light bounces up into it from the ground
            const brightness = (0.76 + 0.22 * skyFacing * skyFacing + 0.1 * heightShare) * (0.9 + 0.2 * shadeVariation);
            vertexColour.copy(padColour).lerp(sunlitTint, 0.25 * Math.max(0, surfaceNormal.y) * heightShare).multiplyScalar(brightness);
            needleSurface.addVertex(surfacePoint, surfaceNormal, 0, 0, vertexColour);
        }
        for (let corner = 0; corner < indices.length; corner += 3) {
            needleSurface.addTriangle(firstVertexIndex + indices[corner], firstVertexIndex + indices[corner + 1], firstVertexIndex + indices[corner + 2]);
        }
        padGeometry.dispose();
    }

    // A tube along a curve whose radius changes along its length, coloured like pine bark:
    // grey-brown plates of slightly different shades, darker and greyer low on the trunk, warmer
    // and lighter higher up and on the branches, with a little moss near the ground.
    // The bark pattern is in the colour only; the surface itself stays smooth.
    addBark(woodSurface, centreCurve, radiusAt, lengthSegments, roundSegments, isTrunk) {
        const frames = centreCurve.computeFrenetFrames(lengthSegments, false);
        const barkColour = new THREE.Color();
        const lowerBark = new THREE.Color(0x675a50);
        const upperBark = new THREE.Color(0x8a7462);
        const mossyBark = new THREE.Color(0x56603c);
        const surfacePoint = new THREE.Vector3();
        const surfaceNormal = new THREE.Vector3();
        const firstVertexIndex = woodSurface.vertexCount();
        const curveLength = centreCurve.getLength();
        const treeHeight = 1.2 + 0.63 * Math.max(this.height, 0);
        for (let ringIndex = 0; ringIndex <= lengthSegments; ringIndex++) {
            const lengthShare = ringIndex / lengthSegments;
            const centrePoint = centreCurve.getPointAt(lengthShare);
            const radius = radiusAt(lengthShare);
            // plates a little taller than wide, sized to the stem they cover
            const plateFrequency = 1 / Math.max(radius * 0.9, 0.03);
            for (let roundIndex = 0; roundIndex <= roundSegments; roundIndex++) {
                const roundAngle = roundIndex / roundSegments * Math.PI * 2;
                // the ring runs from the frame's normal to its binormal, which turns
                // anticlockwise around the direction of growth
                surfaceNormal.set(0, 0, 0)
                    .addScaledVector(frames.normals[ringIndex], Math.cos(roundAngle))
                    .addScaledVector(frames.binormals[ringIndex], Math.sin(roundAngle))
                    .normalize();
                surfacePoint.copy(centrePoint).addScaledVector(surfaceNormal, radius);
                const heightShare = THREE.MathUtils.clamp(surfacePoint.y / treeHeight, 0, 1);
                const plateNoise = valueNoise(surfacePoint.x * plateFrequency, surfacePoint.y * plateFrequency * 0.45, surfacePoint.z * plateFrequency, this.noiseSeed);
                const patchNoise = valueNoise(surfacePoint.x * 0.6, surfacePoint.y * 0.6, surfacePoint.z * 0.6, this.noiseSeed + 3);
                const mossShare = isTrunk ? Math.max(0, 1 - surfacePoint.y / 1.2) * 0.55 : 0;
                barkColour.copy(lowerBark).lerp(upperBark, isTrunk ? smoothStep(heightShare) : 0.8)
                    .lerp(mossyBark, mossShare)
                    .multiplyScalar((0.78 + 0.4 * plateNoise) * (0.92 + 0.16 * patchNoise));
                woodSurface.addVertex(surfacePoint, surfaceNormal, roundIndex / roundSegments, lengthShare * curveLength, barkColour);
            }
        }
        // Triangles wound anticlockwise when seen from outside, so their front faces point
        // outwards like the normals (the reverse order showed the inside of the tube, lit wrongly)
        for (let ringIndex = 0; ringIndex < lengthSegments; ringIndex++) {
            for (let roundIndex = 0; roundIndex < roundSegments; roundIndex++) {
                const lowerVertex = firstVertexIndex + ringIndex * (roundSegments + 1) + roundIndex;
                const upperVertex = lowerVertex + roundSegments + 1;
                woodSurface.addTriangle(lowerVertex, lowerVertex + 1, upperVertex);
                woodSurface.addTriangle(upperVertex, lowerVertex + 1, upperVertex + 1);
            }
        }
    }

    addToScene(scene) {
        scene.add(this.treeGroup);
        this.treeGroup.generated = true;
        // shadows are cast and received per mesh, so the setting goes to both the wood and the needles
        const castsShadow = this.castShadow;
        this.treeGroup.traverse(function (child) {
            if (child.isMesh) {
                child.castShadow = castsShadow;
                child.receiveShadow = true;
            }
        });
    }

    exportToOBJ() {
        const exporter = new OBJExporter();
        const result = exporter.parse(this.treeGroup);

        const blob = new Blob([result], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = 'pine_tree.obj';

        document.body.appendChild(a);
        a.click();

        setTimeout(function () {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 0);
    }
}

// The radius along a limb: it narrows evenly from its base to the given share at its tip
function makeTaper(baseRadius, tipShare) {
    return function (lengthShare) {
        return baseRadius * (1 - (1 - tipShare) * lengthShare);
    };
}

// Collects vertices and triangles for one mesh. Colours have four components because the path
// tracer gives every mesh a four-component colour when it merges them.
class SurfaceBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.textureCoordinates = [];
        this.colours = [];
        this.indices = [];
    }

    vertexCount() {
        return this.positions.length / 3;
    }

    addVertex(position, normal, textureU, textureV, colour) {
        this.positions.push(position.x, position.y, position.z);
        this.normals.push(normal.x, normal.y, normal.z);
        this.textureCoordinates.push(textureU, textureV);
        this.colours.push(colour.r, colour.g, colour.b, 1);
    }

    addTriangle(firstIndex, secondIndex, thirdIndex) {
        this.indices.push(firstIndex, secondIndex, thirdIndex);
    }

    toGeometry() {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.textureCoordinates, 2));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 4));
        geometry.setIndex(this.indices);
        geometry.computeBoundingSphere();
        return geometry;
    }
}

// Smooth noise between 0 and 1, from random values at the corners of a unit grid.
// Used for colour only, never to move the surface.
function valueNoise(x, y, z, seed) {
    const cornerX = Math.floor(x);
    const cornerY = Math.floor(y);
    const cornerZ = Math.floor(z);
    const shareX = smoothStep(x - cornerX);
    const shareY = smoothStep(y - cornerY);
    const shareZ = smoothStep(z - cornerZ);
    function corner(offsetX, offsetY, offsetZ) {
        return hashNumbers(cornerX + offsetX, cornerY + offsetY, cornerZ + offsetZ + seed * 131) / 4294967296;
    }
    const bottomFront = corner(0, 0, 0) + (corner(1, 0, 0) - corner(0, 0, 0)) * shareX;
    const bottomBack = corner(0, 0, 1) + (corner(1, 0, 1) - corner(0, 0, 1)) * shareX;
    const topFront = corner(0, 1, 0) + (corner(1, 1, 0) - corner(0, 1, 0)) * shareX;
    const topBack = corner(0, 1, 1) + (corner(1, 1, 1) - corner(0, 1, 1)) * shareX;
    const bottom = bottomFront + (bottomBack - bottomFront) * shareZ;
    const top = topFront + (topBack - topFront) * shareZ;
    return bottom + (top - bottom) * shareY;
}

function smoothStep(share) {
    return share * share * (3 - 2 * share);
}

// Mixes three whole numbers into one unsigned 32-bit number
function hashNumbers(first, second, third) {
    let hash = Math.imul(first | 0, 374761393) ^ Math.imul(second | 0, 668265263) ^ Math.imul(third | 0, 1274126177);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    hash = hash ^ (hash >>> 16);
    return hash >>> 0;
}

// A small random number generator (mulberry32) that gives the same numbers for the same seed
function createSeededRandom(seed) {
    let state = seed >>> 0;
    return function () {
        state = (state + 0x6D2B79F5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

// The strength of the sky light on the trees, set by the time of day
PineTree.environmentIntensity = 1;

export default PineTree;
