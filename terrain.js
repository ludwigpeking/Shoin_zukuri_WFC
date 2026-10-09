// Purpose: a gentle relief for the open ground.
//
// The relief is a function of the position in the scene, not of the block, so two neighbouring
// blocks agree on every shared point and the ground continues across their border.

export const reliefAmplitude = 1.2; // metres up and down; the shorelines wander by up to about 1.5 m
const longWavelength = 9;    // metres
const shortWavelength = 3.5; // metres
const shortWaveShare = 0.35;
const noiseSeed = 1903;

// A fixed shuffle of 0..255, so that the relief is the same every time
const permutation = (function () {
  const values = [];
  for (let value = 0; value < 256; value++) {
    values.push(value);
  }
  let state = noiseSeed;
  for (let position = 255; position > 0; position--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const swapPosition = state % (position + 1);
    const kept = values[position];
    values[position] = values[swapPosition];
    values[swapPosition] = kept;
  }
  return values.concat(values);
})();

function fade(fraction) {
  return fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
}

function gradientDot(hash, offsetX, offsetY) {
  // eight directions around the circle
  switch (hash & 7) {
    case 0: return offsetX + offsetY;
    case 1: return offsetX - offsetY;
    case 2: return -offsetX + offsetY;
    case 3: return -offsetX - offsetY;
    case 4: return offsetX;
    case 5: return -offsetX;
    case 6: return offsetY;
    default: return -offsetY;
  }
}

// Two-dimensional Perlin noise, roughly between -1 and 1
export function perlinNoise(x, y) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const offsetX = x - cellX;
  const offsetY = y - cellY;
  const wrappedX = cellX & 255;
  const wrappedY = cellY & 255;
  const cornerHash00 = permutation[permutation[wrappedX] + wrappedY];
  const cornerHash10 = permutation[permutation[wrappedX + 1] + wrappedY];
  const cornerHash01 = permutation[permutation[wrappedX] + wrappedY + 1];
  const cornerHash11 = permutation[permutation[wrappedX + 1] + wrappedY + 1];
  const blendX = fade(offsetX);
  const blendY = fade(offsetY);
  const bottom = gradientDot(cornerHash00, offsetX, offsetY) +
    blendX * (gradientDot(cornerHash10, offsetX - 1, offsetY) - gradientDot(cornerHash00, offsetX, offsetY));
  const top = gradientDot(cornerHash01, offsetX, offsetY - 1) +
    blendX * (gradientDot(cornerHash11, offsetX - 1, offsetY - 1) - gradientDot(cornerHash01, offsetX, offsetY - 1));
  return bottom + blendY * (top - bottom);
}

// Height of the relief at a point of the scene (x and z in metres), between -0.3 and 0.3
export function terrainRelief(x, z) {
  const longWave = perlinNoise(x / longWavelength, z / longWavelength);
  const shortWave = perlinNoise(x / shortWavelength + 31.7, z / shortWavelength + 17.3);
  const combined = (longWave + shortWaveShare * shortWave) / (1 + shortWaveShare);
  return reliefAmplitude * Math.max(-1, Math.min(1, combined * 1.6));
}

// Broad patches of the ground's colour, between -1 and 1: an independent field, about 12 m across
export function groundColourNoise(x, z) {
  return Math.max(-1, Math.min(1, 1.4 * perlinNoise(x / 12 + 57.1, z / 12 + 91.7)));
}

// A flat square of ground, one block wide, with sides down to the underside. In the coordinates
// of the model: y up. Fine enough that the relief can bend it.
export function buildFlatGroundArrays(halfBlockSize, undersideHeight, gridIntervalCount) {
  const positions = [];
  const indices = [];
  const pointsPerRow = gridIntervalCount + 1;
  const gridStep = 2 * halfBlockSize / gridIntervalCount;
  for (let row = 0; row < pointsPerRow; row++) {
    for (let column = 0; column < pointsPerRow; column++) {
      positions.push(-halfBlockSize + column * gridStep, 0, -halfBlockSize + row * gridStep);
    }
  }
  for (let row = 0; row < gridIntervalCount; row++) {
    for (let column = 0; column < gridIntervalCount; column++) {
      const corner = row * pointsPerRow + column;
      // counter-clockwise seen from above (+y), so the top faces up
      indices.push(corner, corner + pointsPerRow, corner + 1, corner + 1, corner + pointsPerRow, corner + pointsPerRow + 1);
    }
  }
  const borderWalks = [
    function (step) { return step; },
    function (step) { return step * pointsPerRow + gridIntervalCount; },
    function (step) { return gridIntervalCount * pointsPerRow + gridIntervalCount - step; },
    function (step) { return (gridIntervalCount - step) * pointsPerRow; }];
  for (const topPointAt of borderWalks) {
    const firstSidePoint = positions.length / 3;
    for (let step = 0; step <= gridIntervalCount; step++) {
      const topPoint = topPointAt(step) * 3;
      positions.push(positions[topPoint], positions[topPoint + 1], positions[topPoint + 2]);
      positions.push(positions[topPoint], undersideHeight, positions[topPoint + 2]);
    }
    for (let step = 0; step < gridIntervalCount; step++) {
      const upper = firstSidePoint + step * 2;
      indices.push(upper, upper + 1, upper + 3, upper, upper + 3, upper + 2);
    }
  }
  return { positions, indices };
}
