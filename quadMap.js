// Purpose: an irregular grid of quadrilaterals in a hexagon, the grid Oskar Stalberg uses in
// Townscaper. Ported from the quadrangulated map generator of the SpringShow project
// (2605_SpringShow/2511_Hexagonal_World/01_quadMapGenerator.js):
//   1. a hexagon cut into rings of triangles,
//   2. neighbouring triangles merged into quads at random (a few triangles stay),
//   3. every face split into quads (a quad into four, a triangle into three),
//   4. the points relaxed towards the middles of their faces, which turns the quads square-ish,
//      while the faces are also pushed towards the same area.
// Plan coordinates: x and z, in metres, centred on 0.

const relaxationIterationCount = 2000;
const relaxationStrength = 0.075;
const areaEqualisationStrength = 0.01;

class SeededSequence {
  constructor(seed) {
    this.state = (seed >>> 0) || 1;
  }

  nextFloat() {
    // xorshift: plenty for shuffling
    this.state ^= this.state << 13;
    this.state >>>= 0;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    this.state >>>= 0;
    return this.state / 4294967296;
  }
}

function shuffle(array, sequence) {
  for (let index = array.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(sequence.nextFloat() * (index + 1));
    const kept = array[index];
    array[index] = array[swapIndex];
    array[swapIndex] = kept;
  }
}

function ringPointIndex(ring, sector, step) {
  if (ring === 0) {
    return 0;
  }
  return 1 + (ring * 6 * (ring - 1)) / 2 + sector * ring + step;
}

function faceArea(face) {
  let doubleArea = 0;
  for (let index = 0; index < face.length; index++) {
    const point = face[index];
    const next = face[(index + 1) % face.length];
    doubleArea += point.x * next.z - next.x * point.z;
  }
  return Math.abs(doubleArea / 2);
}

function faceCentre(face) {
  let x = 0;
  let z = 0;
  face.forEach(function (point) {
    x += point.x;
    z += point.z;
  });
  return { x: x / face.length, z: z / face.length };
}

// ringCount: rings of triangles around the middle; averageEdgeLength: metres.
// Returns { points: [{ x, z, isOnBoundary }], cells: [{ corners: [4 point indices], neighbours:
// [4 entries { cell, edge } or null] }], radius }. The corners of every cell run clockwise seen from
// above with x to the right and z up the plan, like the corners top left, top right, bottom right,
// bottom left of a square block; edge k runs from corner k to corner k + 1.
export function generateHexQuadMap(ringCount, averageEdgeLength, seed) {
  const sequence = new SeededSequence(seed);
  const hexagonSpacing = 1;

  // 1. the points of the hexagon rings, and the triangles between them
  const points = [{ x: 0, z: 0, isOnBoundary: false }];
  for (let ring = 1; ring <= ringCount; ring++) {
    for (let sector = 0; sector < 6; sector++) {
      for (let step = 0; step < ring; step++) {
        const cornerAngle = sector * Math.PI / 3;
        const nextCornerAngle = (sector + 1) * Math.PI / 3;
        const share = step / ring;
        points.push({
          x: ring * hexagonSpacing * ((1 - share) * Math.cos(cornerAngle) + share * Math.cos(nextCornerAngle)),
          z: ring * hexagonSpacing * ((1 - share) * Math.sin(cornerAngle) + share * Math.sin(nextCornerAngle)),
          isOnBoundary: ring === ringCount,
        });
      }
    }
  }
  let faces = [];
  for (let sector = 0; sector < 6; sector++) {
    const first = points[sector + 1];
    const second = points[((sector + 1) % 6) + 1];
    faces.push([points[0], first, second]);
    if (ringCount > 1) {
      faces.push([first, second, points[6 + 2 + 2 * sector]]);
    }
  }
  for (let ring = 2; ring <= ringCount; ring++) {
    for (let sector = 0; sector < 6; sector++) {
      for (let step = 0; step < ring; step++) {
        const inner = points[ringPointIndex(ring - 1, (sector + Math.floor(step / (ring - 1))) % 6, step % (ring - 1))];
        const own = points[ringPointIndex(ring, sector, step)];
        const next = points[ringPointIndex(ring, (sector + Math.floor(step / (ring - 1))) % 6, (step + 1) % ring)];
        faces.push([inner, own, next]);
        if (ring < ringCount) {
          const outer = points[ringPointIndex(ring + 1, sector + (Math.floor(step / ring) % 6), (step + 1) % (ring + 1))];
          faces.push([own, next, outer]);
        }
      }
    }
  }

  // 2. neighbouring triangles merged into quads, in a random order
  const pairs = [];
  for (let first = 0; first < faces.length; first++) {
    for (let second = first + 1; second < faces.length; second++) {
      pairs.push([first, second]);
    }
  }
  shuffle(pairs, sequence);
  const merged = new Set();
  const quads = [];
  pairs.forEach(function ([first, second]) {
    if (merged.has(first) || merged.has(second)) {
      return;
    }
    const shared = faces[first].filter(function (point) {
      return faces[second].includes(point);
    });
    if (shared.length !== 2) {
      return;
    }
    const notShared = faces[first].concat(faces[second]).filter(function (point) {
      return !shared.includes(point);
    });
    quads.push([shared[0], notShared[0], shared[1], notShared[1]]);
    merged.add(first);
    merged.add(second);
  });
  faces = quads.concat(faces.filter(function (face, index) {
    return !merged.has(index);
  }));

  // 3. every face split into quads
  const middleOfEdge = new Map();
  const allPoints = points.slice();
  allPoints.forEach(function (point, index) {
    point.index = index;
  });
  function edgeMiddle(first, second) {
    const key = Math.min(first.index, second.index) + '-' + Math.max(first.index, second.index);
    if (!middleOfEdge.has(key)) {
      const middle = {
        x: (first.x + second.x) / 2, z: (first.z + second.z) / 2,
        isOnBoundary: first.isOnBoundary && second.isOnBoundary, index: allPoints.length,
      };
      allPoints.push(middle);
      middleOfEdge.set(key, middle);
    }
    return middleOfEdge.get(key);
  }
  const subdividedFaces = [];
  faces.forEach(function (face) {
    const middles = face.map(function (point, index) {
      return edgeMiddle(point, face[(index + 1) % face.length]);
    });
    const centreOfFace = faceCentre(face);
    const centre = { x: centreOfFace.x, z: centreOfFace.z, isOnBoundary: false, index: allPoints.length };
    allPoints.push(centre);
    face.forEach(function (point, index) {
      subdividedFaces.push([point, middles[index], centre, middles[(index - 1 + middles.length) % middles.length]]);
    });
  });
  faces = subdividedFaces;

  // 4. relaxation
  const facesOfPoint = new Map();
  allPoints.forEach(function (point) {
    facesOfPoint.set(point, []);
  });
  faces.forEach(function (face) {
    face.forEach(function (point) {
      facesOfPoint.get(point).push(face);
    });
  });
  const averageArea = faces.reduce(function (sum, face) {
    return sum + faceArea(face);
  }, 0) / faces.length;
  const relaxationOrder = allPoints.slice();
  for (let iteration = 0; iteration < relaxationIterationCount; iteration++) {
    shuffle(relaxationOrder, sequence);
    relaxationOrder.forEach(function (point) {
      if (point.isOnBoundary) {
        return;
      }
      const adjacentFaces = facesOfPoint.get(point);
      let targetX = 0;
      let targetZ = 0;
      adjacentFaces.forEach(function (face) {
        const centre = faceCentre(face);
        targetX += centre.x;
        targetZ += centre.z;
      });
      targetX /= adjacentFaces.length;
      targetZ /= adjacentFaces.length;
      point.x += (targetX - point.x) * relaxationStrength;
      point.z += (targetZ - point.z) * relaxationStrength;
    });
    faces.forEach(function (face) {
      const areaExcess = (faceArea(face) - averageArea) / averageArea;
      const centre = faceCentre(face);
      face.forEach(function (point) {
        if (!point.isOnBoundary) {
          point.x += (centre.x - point.x) * areaExcess * areaEqualisationStrength;
          point.z += (centre.z - point.z) * areaExcess * areaEqualisationStrength;
        }
      });
    });
  }

  // scale to the wanted edge length; keep only the points that faces use, numbered afresh
  let edgeLengthSum = 0;
  let edgeCount = 0;
  faces.forEach(function (face) {
    face.forEach(function (point, index) {
      const next = face[(index + 1) % 4];
      edgeLengthSum += Math.hypot(next.x - point.x, next.z - point.z);
      edgeCount++;
    });
  });
  const scale = averageEdgeLength / (edgeLengthSum / edgeCount);
  const usedPoints = [];
  const newIndexOf = new Map();
  faces.forEach(function (face) {
    face.forEach(function (point) {
      if (!newIndexOf.has(point)) {
        newIndexOf.set(point, usedPoints.length);
        usedPoints.push({ x: point.x * scale, z: point.z * scale, isOnBoundary: point.isOnBoundary });
      }
    });
  });
  const cells = linkQuadCells(usedPoints, faces.map(function (face) {
    return face.map(function (point) {
      return newIndexOf.get(point);
    });
  }));
  const radius = ringCount * hexagonSpacing * scale;
  return { points: usedPoints, cells: cells, radius: radius };
}

// The cells of a quad map from the points and, per quad, its four corner points in order round
// the quad: every cell gets its corners clockwise and, across each edge, the cell and the edge
// that lie on the other side (null on the rim).
export function linkQuadCells(usedPoints, cornerLists) {
  const cells = cornerLists.map(function (cornerList) {
    let corners = cornerList;
    // clockwise with x right and z up: the signed area is negative
    let signedDoubleArea = 0;
    corners.forEach(function (corner, index) {
      const point = usedPoints[corner];
      const next = usedPoints[corners[(index + 1) % 4]];
      signedDoubleArea += point.x * next.z - next.x * point.z;
    });
    if (signedDoubleArea > 0) {
      corners = corners.slice().reverse();
    }
    return { corners: corners, neighbours: [null, null, null, null] };
  });
  const cellsOfEdge = new Map();
  cells.forEach(function (cell, cellIndex) {
    for (let edge = 0; edge < 4; edge++) {
      const first = cell.corners[edge];
      const second = cell.corners[(edge + 1) % 4];
      const key = Math.min(first, second) + '-' + Math.max(first, second);
      if (!cellsOfEdge.has(key)) {
        cellsOfEdge.set(key, []);
      }
      cellsOfEdge.get(key).push({ cell: cellIndex, edge: edge });
    }
  });
  cellsOfEdge.forEach(function (sides) {
    if (sides.length === 2) {
      cells[sides[0].cell].neighbours[sides[0].edge] = sides[1];
      cells[sides[1].cell].neighbours[sides[1].edge] = sides[0];
    }
  });
  return cells;
}
