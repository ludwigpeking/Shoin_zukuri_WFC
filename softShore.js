// Purpose: rebuilds the ground of a water block with rounded water lines.
//
// The water line of the modelled block is traced, smoothed, and the ground is rebuilt as a
// height field whose bank follows the smoothed line. On the four borders of the block nothing
// moves: the water line still crosses each border at the same point, at a right angle, and the
// heights along the border depend only on those crossing points. Two blocks that continued into
// each other before still do.
//
// Everything here is in plan coordinates of one block: x to the right, y up the plan, z the height.

const halfBlockSize = 3;
const waterLevel = -0.4;
const landHeight = 0;
const waterBottomHeight = -1.2;
const groundUndersideHeight = -2.4;
// The bank, measured across the water line: positive distances are on the land side
const bankTopDistance = 0.5;
const bankBottomDistance = -1.0;
// Slightly above the water level, so that ground lying exactly at the water level counts as water
const tracingLevel = waterLevel + 0.001;

const pointSpacing = 0.1;
const smoothingStrength = 0.5;
const straightLeadPointCount = 4; // points at each border that stay on the perpendicular of the border
const joinTolerance = 1e-4;

function bankHeight(signedDistance) {
  const position = (signedDistance - bankBottomDistance) / (bankTopDistance - bankBottomDistance);
  const clampedPosition = Math.min(1, Math.max(0, position));
  const easedPosition = clampedPosition * clampedPosition * (3 - 2 * clampedPosition);
  return waterBottomHeight + (landHeight - waterBottomHeight) * easedPosition;
}

// The triangles of the top of the ground: not the vertical sides, not the underside
function selectTopTriangles(triangles) {
  return triangles.filter(function (triangle) {
    const [a, b, c] = triangle;
    const normalZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const meanHeight = (a[2] + b[2] + c[2]) / 3;
    return Math.abs(normalZ) > 1e-9 && meanHeight > groundUndersideHeight + 0.2;
  });
}

function modelledHeightAt(topTriangles, x, y) {
  for (const [a, b, c] of topTriangles) {
    const doubleArea = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const weightB = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / doubleArea;
    const weightC = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / doubleArea;
    const weightA = 1 - weightB - weightC;
    if (weightA >= -1e-6 && weightB >= -1e-6 && weightC >= -1e-6) {
      return weightA * a[2] + weightB * b[2] + weightC * c[2];
    }
  }
  return landHeight;
}

function isLandAt(topTriangles, x, y) {
  return modelledHeightAt(topTriangles, x, y) >= tracingLevel;
}

// The pieces of the water line, one per triangle that the water level cuts
function traceWaterLineSegments(topTriangles) {
  const segments = [];
  for (const triangle of topTriangles) {
    const cutPoints = [];
    for (let corner = 0; corner < 3; corner++) {
      const start = triangle[corner];
      const end = triangle[(corner + 1) % 3];
      const startIsLand = start[2] >= tracingLevel;
      const endIsLand = end[2] >= tracingLevel;
      if (startIsLand !== endIsLand) {
        const fraction = (tracingLevel - start[2]) / (end[2] - start[2]);
        cutPoints.push([start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction]);
      }
    }
    if (cutPoints.length === 2 && Math.hypot(cutPoints[0][0] - cutPoints[1][0], cutPoints[0][1] - cutPoints[1][1]) > joinTolerance) {
      segments.push(cutPoints);
    }
  }
  return segments;
}

function pointsCoincide(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]) < joinTolerance;
}

// Joins the pieces end to end into lines. A line either runs from border to border or closes on itself.
function chainSegments(segments) {
  const remaining = segments.slice();
  const lines = [];
  while (remaining.length > 0) {
    const points = remaining.pop().slice();
    let extended = true;
    while (extended) {
      extended = false;
      for (let index = 0; index < remaining.length; index++) {
        const [first, second] = remaining[index];
        const lastPoint = points[points.length - 1];
        const firstPoint = points[0];
        if (pointsCoincide(lastPoint, first)) {
          points.push(second);
        } else if (pointsCoincide(lastPoint, second)) {
          points.push(first);
        } else if (pointsCoincide(firstPoint, second)) {
          points.unshift(first);
        } else if (pointsCoincide(firstPoint, first)) {
          points.unshift(second);
        } else {
          continue;
        }
        remaining.splice(index, 1);
        extended = true;
        break;
      }
    }
    const isClosed = points.length > 3 && pointsCoincide(points[0], points[points.length - 1]);
    if (isClosed) {
      points.pop();
    }
    lines.push({ points, isClosed });
  }
  return lines;
}

function resampleLine(line) {
  const corners = line.isClosed ? line.points.concat([line.points[0]]) : line.points;
  let totalLength = 0;
  for (let index = 1; index < corners.length; index++) {
    totalLength += Math.hypot(corners[index][0] - corners[index - 1][0], corners[index][1] - corners[index - 1][1]);
  }
  const intervalCount = Math.max(8, Math.round(totalLength / pointSpacing));
  const points = [];
  let cornerIndex = 1;
  let lengthBeforeCorner = 0;
  const lastSampleIndex = line.isClosed ? intervalCount - 1 : intervalCount;
  for (let sampleIndex = 0; sampleIndex <= lastSampleIndex; sampleIndex++) {
    const sampleLength = totalLength * sampleIndex / intervalCount;
    let spanLength = Math.hypot(corners[cornerIndex][0] - corners[cornerIndex - 1][0], corners[cornerIndex][1] - corners[cornerIndex - 1][1]);
    while (cornerIndex < corners.length - 1 && lengthBeforeCorner + spanLength < sampleLength) {
      lengthBeforeCorner += spanLength;
      cornerIndex++;
      spanLength = Math.hypot(corners[cornerIndex][0] - corners[cornerIndex - 1][0], corners[cornerIndex][1] - corners[cornerIndex - 1][1]);
    }
    const fraction = spanLength > 0 ? Math.min(1, (sampleLength - lengthBeforeCorner) / spanLength) : 0;
    points.push([
      corners[cornerIndex - 1][0] + (corners[cornerIndex][0] - corners[cornerIndex - 1][0]) * fraction,
      corners[cornerIndex - 1][1] + (corners[cornerIndex][1] - corners[cornerIndex - 1][1]) * fraction]);
  }
  return { points, isClosed: line.isClosed };
}

function enclosedArea(points) {
  let doubleArea = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    doubleArea += points[index][0] * next[1] - next[0] * points[index][1];
  }
  return doubleArea / 2;
}

// Which coordinate runs along the border that a point sits on: 0 for x (top and bottom), 1 for y (left and right)
function borderRunningAxis(point) {
  return Math.abs(Math.abs(point[1]) - halfBlockSize) < 1e-3 ? 0 : 1;
}

function smoothLine(line, iterationCount) {
  let points = line.points.map(function (point) {
    return point.slice();
  });
  const pointCount = points.length;
  const areaBefore = line.isClosed ? enclosedArea(points) : 0;
  for (let iteration = 0; iteration < iterationCount; iteration++) {
    const moved = points.map(function (point, index) {
      if (!line.isClosed && (index === 0 || index === pointCount - 1)) {
        return point; // the crossing of a border stays where it is
      }
      const previous = points[(index - 1 + pointCount) % pointCount];
      const next = points[(index + 1) % pointCount];
      return [
        point[0] + smoothingStrength * ((previous[0] + next[0]) / 2 - point[0]),
        point[1] + smoothingStrength * ((previous[1] + next[1]) / 2 - point[1])];
    });
    if (!line.isClosed) {
      // the line leaves each border at a right angle
      const startAxis = borderRunningAxis(moved[0]);
      const endAxis = borderRunningAxis(moved[pointCount - 1]);
      for (let lead = 1; lead <= straightLeadPointCount && lead < pointCount - 1; lead++) {
        moved[lead][startAxis] = moved[0][startAxis];
        moved[pointCount - 1 - lead][endAxis] = moved[pointCount - 1][endAxis];
      }
    }
    points = moved;
  }
  if (line.isClosed) {
    // smoothing shrinks a closed line; scale it back to the area it had
    const scale = Math.sqrt(Math.abs(areaBefore / enclosedArea(points)));
    const centreX = points.reduce(function (sum, point) { return sum + point[0]; }, 0) / pointCount;
    const centreY = points.reduce(function (sum, point) { return sum + point[1]; }, 0) / pointCount;
    points = points.map(function (point) {
      return [centreX + (point[0] - centreX) * scale, centreY + (point[1] - centreY) * scale];
    });
  }
  return { points, isClosed: line.isClosed };
}

// Turns the line so that the land lies on its left
function orientLandToTheLeft(line, topTriangles) {
  const middleIndex = Math.floor(line.points.length / 2);
  const start = line.points[middleIndex - 1];
  const end = line.points[middleIndex];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const probeDistance = 0.05;
  const probeX = (start[0] + end[0]) / 2 - (end[1] - start[1]) / length * probeDistance;
  const probeY = (start[1] + end[1]) / 2 + (end[0] - start[0]) / length * probeDistance;
  if (!isLandAt(topTriangles, probeX, probeY)) {
    line.points.reverse();
  }
}

// Distance from a point to the nearest water line: positive on land, negative in the water
function signedDistanceToWaterLines(lines, x, y) {
  let nearestDistance = Infinity;
  let nearestIsLand = true;
  for (const line of lines) {
    const pointCount = line.points.length;
    const segmentCount = line.isClosed ? pointCount : pointCount - 1;
    for (let index = 0; index < segmentCount; index++) {
      const start = line.points[index];
      const end = line.points[(index + 1) % pointCount];
      const alongX = end[0] - start[0];
      const alongY = end[1] - start[1];
      const lengthSquared = alongX * alongX + alongY * alongY;
      const fraction = lengthSquared > 0 ? Math.min(1, Math.max(0, ((x - start[0]) * alongX + (y - start[1]) * alongY) / lengthSquared)) : 0;
      const offsetX = x - (start[0] + alongX * fraction);
      const offsetY = y - (start[1] + alongY * fraction);
      const distance = Math.hypot(offsetX, offsetY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIsLand = alongX * (y - start[1]) - alongY * (x - start[0]) >= 0;
      }
    }
  }
  return nearestIsLand ? nearestDistance : -nearestDistance;
}

// The height on a border depends only on where the water line crosses that same border
function borderHeight(topTriangles, crossings, x, y) {
  const runningAxis = Math.abs(Math.abs(y) - halfBlockSize) < 1e-6 ? 0 : 1;
  const fixedAxis = 1 - runningAxis;
  const position = [x, y];
  let nearestDistance = Infinity;
  for (const crossing of crossings) {
    if (Math.abs(crossing[fixedAxis] - position[fixedAxis]) < 1e-3) {
      nearestDistance = Math.min(nearestDistance, Math.abs(crossing[runningAxis] - position[runningAxis]));
    }
  }
  if (nearestDistance === Infinity) {
    nearestDistance = bankTopDistance - bankBottomDistance; // no water line on this border: fully land or fully water
  }
  return bankHeight(isLandAt(topTriangles, x, y) ? nearestDistance : -nearestDistance);
}

// triangles: [[x, y, z], [x, y, z], [x, y, z]] of the modelled ground.
// Returns null when the block has no water line, otherwise the smoothed lines and the new ground as
// { positions, topIndices, sideIndices }, with separate points for the top and for the sides.
export function buildSoftShoreGround(triangles, smoothingIterationCount = 150, gridIntervalCount = 60) {
  const topTriangles = selectTopTriangles(triangles);
  const tracedLines = chainSegments(traceWaterLineSegments(topTriangles));
  if (tracedLines.length === 0) {
    return null;
  }
  const waterLines = tracedLines.map(function (tracedLine) {
    const modelledLine = resampleLine(tracedLine);
    orientLandToTheLeft(modelledLine, topTriangles); // while the line still lies on the modelled water line
    return smoothLine(modelledLine, smoothingIterationCount);
  });
  const crossings = [];
  for (const line of waterLines) {
    if (!line.isClosed) {
      // rounded, so that two neighbouring blocks compute their shared border from the very same numbers
      for (const endPoint of [line.points[0], line.points[line.points.length - 1]]) {
        crossings.push([Math.round(endPoint[0] * 100) / 100, Math.round(endPoint[1] * 100) / 100]);
      }
    }
  }

  const positions = [];
  const pointsPerRow = gridIntervalCount + 1;
  const gridStep = 2 * halfBlockSize / gridIntervalCount;
  for (let row = 0; row < pointsPerRow; row++) {
    for (let column = 0; column < pointsPerRow; column++) {
      const x = -halfBlockSize + column * gridStep;
      const y = -halfBlockSize + row * gridStep;
      const isOnBorder = row === 0 || column === 0 || row === gridIntervalCount || column === gridIntervalCount;
      const height = isOnBorder
        ? borderHeight(topTriangles, crossings, x, y)
        : bankHeight(signedDistanceToWaterLines(waterLines, x, y));
      positions.push(x, y, height);
    }
  }
  const topIndices = [];
  for (let row = 0; row < gridIntervalCount; row++) {
    for (let column = 0; column < gridIntervalCount; column++) {
      const corner = row * pointsPerRow + column;
      topIndices.push(corner, corner + 1, corner + pointsPerRow + 1, corner, corner + pointsPerRow + 1, corner + pointsPerRow);
    }
  }

  // The four sides, from the border of the top down to the underside, facing outwards
  const sideIndices = [];
  const borderWalks = [
    function (step) { return step; },                                                   // bottom border, left to right
    function (step) { return step * pointsPerRow + gridIntervalCount; },                // right border, upwards
    function (step) { return gridIntervalCount * pointsPerRow + gridIntervalCount - step; }, // top border, right to left
    function (step) { return (gridIntervalCount - step) * pointsPerRow; }];             // left border, downwards
  for (const topPointAt of borderWalks) {
    const firstSidePoint = positions.length / 3;
    for (let step = 0; step <= gridIntervalCount; step++) {
      const topPoint = topPointAt(step) * 3;
      positions.push(positions[topPoint], positions[topPoint + 1], positions[topPoint + 2]);
      positions.push(positions[topPoint], positions[topPoint + 1], groundUndersideHeight);
    }
    for (let step = 0; step < gridIntervalCount; step++) {
      const upper = firstSidePoint + step * 2;
      sideIndices.push(upper, upper + 1, upper + 3, upper, upper + 3, upper + 2);
    }
  }
  return { waterLines, positions, topIndices, sideIndices };
}
