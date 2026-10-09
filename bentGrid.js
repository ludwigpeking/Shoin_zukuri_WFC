// Purpose: a square grid whose lines bend gently, for the same play as the hexagonal map.
//
// Every point of a straight grid is shifted in the plane by a smooth noise with a long wavelength.
// Neighbouring points move almost together, so the cells stay close to squares while the rows and
// columns wander. The result has the form of generateHexQuadMap (quadMap.js): the blocks are bent
// into its quads in the same way.

import { perlinNoise } from './terrain';
import { linkQuadCells } from './quadMap';

// shiftAmplitude: the furthest a point moves along x or z, in metres; shiftWavelength: the distance
// over which the shift changes, in metres (many cells, for a gentle bend)
export function generateBentGridQuadMap(columnCount, rowCount, cellLength, shiftAmplitude, shiftWavelength, seed) {
  // one noise field for each direction of the shift; the seed moves both to another place
  const seedOffset = (seed % 9973) * 3.17;
  function shiftAlong(noiseX, noiseZ) {
    return shiftAmplitude * Math.max(-1, Math.min(1, 1.6 * perlinNoise(noiseX, noiseZ)));
  }
  const points = [];
  for (let row = 0; row <= rowCount; row++) {
    for (let column = 0; column <= columnCount; column++) {
      const straightX = (column - columnCount / 2) * cellLength;
      const straightZ = (row - rowCount / 2) * cellLength;
      points.push({
        x: straightX + shiftAlong(straightX / shiftWavelength + seedOffset + 0.37, straightZ / shiftWavelength + 11.3),
        z: straightZ + shiftAlong(straightX / shiftWavelength + 71.9, straightZ / shiftWavelength + seedOffset + 43.1),
        isOnBoundary: column === 0 || row === 0 || column === columnCount || row === rowCount,
      });
    }
  }
  const cornerLists = [];
  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const firstPoint = row * (columnCount + 1) + column;
      cornerLists.push([firstPoint, firstPoint + 1, firstPoint + columnCount + 2, firstPoint + columnCount + 1]);
    }
  }
  return {
    points: points,
    cells: linkQuadCells(points, cornerLists),
    radius: Math.hypot(columnCount, rowCount) * cellLength / 2 + shiftAmplitude,
  };
}
