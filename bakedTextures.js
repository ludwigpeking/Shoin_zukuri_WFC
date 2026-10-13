// Purpose: the surface patterns of the normal view, baked into textures for the path tracer. The
// roof tiles and the grass are drawn by shader code in the normal view (main.js: addRoofTiles,
// createLushGroundMaterial), which the path tracer cannot run, so under path traced light the
// roofs and the ground came out plain. These textures repeat the same patterns, computed once on
// a canvas, and the materials take them as maps only while the path tracer is on.
import * as THREE from 'three';

const roofTilesAcrossTexture = 8;   // tiles across one repeat of the texture ...
const roofCoursesInTexture = 8;     // ... and courses down it: the shade of a tile varies within
const roofTexturePixels = 512;

const groundTextureMetres = 6;      // one block: the texture repeats with the blocks
const groundTexturePixels = 512;
const groundClumpCellsInTexture = 8;   // tufts and clumps, under a metre (1.3 a metre in the shader)
const groundGrainCellsInTexture = 54;  // the grain of the grass blades (9 a metre)

function smoothstep(edge0, edge1, value) {
  const share = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return share * share * (3 - 2 * share);
}

function fraction(value) {
  return value - Math.floor(value);
}

// the shaders' hash, made periodic so that the texture repeats without a seam
function cellHash(column, row, period) {
  const wrappedColumn = ((column % period) + period) % period;
  const wrappedRow = ((row % period) + period) % period;
  return fraction(Math.sin(wrappedColumn * 127.1 + wrappedRow * 311.7) * 43758.5453);
}

function valueNoise(x, y, period) {
  const column = Math.floor(x);
  const row = Math.floor(y);
  const fractionX = x - column;
  const fractionY = y - row;
  const blendX = fractionX * fractionX * (3 - 2 * fractionX);
  const blendY = fractionY * fractionY * (3 - 2 * fractionY);
  const top = cellHash(column, row, period) + (cellHash(column + 1, row, period) - cellHash(column, row, period)) * blendX;
  const bottom = cellHash(column, row + 1, period) + (cellHash(column + 1, row + 1, period) - cellHash(column, row + 1, period)) * blendX;
  return top + (bottom - top) * blendY;
}

function canvasTexture(pixels, colorSpace, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixels;
  const brush = canvas.getContext('2d');
  const image = brush.createImageData(pixels, pixels);
  for (let row = 0; row < pixels; row++) {
    for (let column = 0; column < pixels; column++) {
      const rgb = paint(column / pixels, row / pixels);
      const at = (row * pixels + column) * 4;
      image.data[at] = Math.round(255 * Math.max(0, Math.min(1, rgb[0])));
      image.data[at + 1] = Math.round(255 * Math.max(0, Math.min(1, rgb[1])));
      image.data[at + 2] = Math.round(255 * Math.max(0, Math.min(1, rgb[2])));
      image.data[at + 3] = 255;
    }
  }
  brush.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  texture.flipY = false;
  return texture;
}

// The roof tiles: the colour (a multiplier of the tile colour: the wave of each tile, the shadow
// line below each course, a little variation from tile to tile) and the roughness (matt clay, the
// channels the dullest). No normal map: a tilted shading normal gave the path tracer bright
// specks on the roofs (2026-10-13), and the colour carries the relief well enough under sky light.
// u runs across the slope, one tile a 1 / roofTilesAcrossTexture of it; v runs down the courses.
export function makeRoofTileTextures() {
  function tileLight(u, v) {
    const acrossTiles = u * roofTilesAcrossTexture;
    const downCourses = v * roofCoursesInTexture;
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * acrossTiles);
    const course = fraction(downCourses);
    const overlapShadow = smoothstep(0, 0.12, course);
    const tileShade = 0.94 + 0.12 * cellHash(Math.floor(acrossTiles), Math.floor(downCourses), roofTilesAcrossTexture);
    return { wave: wave, course: course, light: (0.72 + 0.28 * wave) * (0.7 + 0.3 * overlapShadow) * tileShade };
  }
  const map = canvasTexture(roofTexturePixels, THREE.SRGBColorSpace, function (u, v) {
    const light = tileLight(u, v).light;
    return [light, light, light];
  });
  const roughnessMap = canvasTexture(roofTexturePixels, THREE.NoColorSpace, function (u, v) {
    const roughness = 0.88 + 0.1 * (1 - tileLight(u, v).wave);
    return [roughness, roughness, roughness]; // (the green channel is read)
  });
  return { map: map, roughnessMap: roughnessMap };
}

// The uv of a roof point: across the slope by the tile, down by the course; a point that is not
// tiled (a hip strip, a wall) lands on the back of a tile in the middle of a course, where the
// texture is plain
export function roofTileUv(acrossMetres, heightMetres, isTiled, roofTileWidth, roofCourseHeight) {
  if (!isTiled) {
    return [0, 0.5 / roofCoursesInTexture];
  }
  return [acrossMetres / roofTileWidth / roofTilesAcrossTexture, heightMetres / roofCourseHeight / roofCoursesInTexture];
}

// The grass: clumps and the grain of the blades, as the shader draws them on dry ground, a
// multiplier of the vertex colours; one repeat is one block of ground
export function makeGroundTexture() {
  return canvasTexture(groundTexturePixels, THREE.SRGBColorSpace, function (u, v) {
    const clumps = valueNoise(u * groundClumpCellsInTexture, v * groundClumpCellsInTexture, groundClumpCellsInTexture);
    const grain = valueNoise(u * groundGrainCellsInTexture + 0.37, v * groundGrainCellsInTexture + 0.71, groundGrainCellsInTexture);
    const light = (0.78 + 0.32 * clumps) * (0.86 + 0.24 * grain);
    const dryTint = smoothstep(0.65, 0.95, clumps);
    return [light * (1 + 0.08 * dryTint), light * (1 + 0.04 * dryTint), light * (1 - 0.18 * dryTint)];
  });
}

export function groundUv(xMetres, zMetres) {
  return [xMetres / groundTextureMetres, zMetres / groundTextureMetres];
}
