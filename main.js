import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils';
import PineTree from './Pine';
import { buildSoftShoreGround } from './softShore';
import { terrainRelief, buildFlatGroundArrays, reliefAmplitude, groundColourNoise } from './terrain';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { ParallelMeshBVHWorker } from 'three-mesh-bvh/worker';
import { richVariantSeeds } from './richVariants';
import { generateHexQuadMap } from './quadMap';
import { generateBentGridQuadMap } from './bentGrid';
import { makeRoofTileTextures, makeGroundTexture, roofTileUv, groundUv } from './bakedTextures';

let buildingBlocks = [];
let cols = 11;
let rows = 11;
let grid = [];
let unsolved = [];
const defaultSeed = 19;
let openEdge = true;
let showTrees = true;
let favorTwoStoreyPavilion = false;
let captureImage = false;
let keptViewIsRequested = false; // "Keep view" was clicked: the view is sent after the next frame
// Which kind of map is shown: the square grid, or the hexagonal grid of quads (see the hexagonal map section)
let mapIsHexagonal = false;
let hexMap = null; // { points, cells, radius } from generateHexQuadMap or generateBentGridQuadMap
// The maps of quads share everything (the "hex" functions below); only the grid differs:
// 'hexagonal' is the irregular grid in a hexagon, 'bent' a square grid with gently bent lines.
let quadMapKind = 'hexagonal';
const bentGridShift = { amplitudeMetres: 3.5, wavelengthMetres: 50 };

// Settings window
document.getElementById('openSettings').addEventListener('click', function () {
  document.getElementById('settings').classList.add('open');
});
document.getElementById('closeSettings').addEventListener('click', function () {
  document.getElementById('settings').classList.remove('open');
});

document.getElementById('openEdgeCheckbox').addEventListener('change', function() {
    openEdge = this.checked;
  });

// When unchecked the two-storey pavilion only appears by the normal chance of the collapse;
// when checked it is forced into half of the schemes. Takes effect at the next generation.
const favorPavilionCheckbox = document.getElementById('favorPavilionCheckbox');
favorPavilionCheckbox.addEventListener('change', function() {
    favorTwoStoreyPavilion = this.checked;
  });

// Trees toggle: applies to the current scheme right away, without regenerating it
const treesCheckbox = document.getElementById('treesCheckbox');
treesCheckbox.addEventListener('change', function() {
    showTrees = this.checked;
    removeAllPinesFromScene(scene);
    if (showTrees) {
      if (mapIsHexagonal) {
        plantHexTrees();
      } else if (playModeIsOn) {
        plantPlayTrees();
      } else {
        plantTrees();
      }
    }
  });


class SeededRandom {
  constructor(seed = Date.now()) {
    this.m = 0x80000000; // 2**31;
    this.a = 1103515245;
    this.c = 321321;
    this.initialState = seed % this.m;  // Store the initial state
    this.state = this.initialState;
  }
  
  // Reset the internal state to its initial value
  reset() {
    this.state = this.initialState;
  }

  // Return a random float in [0, 1)
  nextFloat() {
    // Math.imul keeps the multiplication exact in 32 bits; the plain product exceeds
    // the precision of a double, which made the sequence repeat after ~1500 draws.
    this.state = ((Math.imul(this.a, this.state) + this.c) >>> 0) % this.m;
    return this.state / this.m;
  }

  // Return a random int in [0, m)
  nextInt(m) {
    return Math.floor(this.nextFloat() * m);
  }
}

// Usage
let rng = new SeededRandom(defaultSeed); 
// console.log(rng)

class Tile {
  constructor(index, num, edges) {
    this.index = index;
    this.ro = num;
    this.mirrored = false;
    this.edges = edges;
    this.up = [];
    this.right = [];
    this.down = [];
    this.left = [];
  }

  analyze(tiles) {
    for (let i = 0; i < tiles.length; i++) {
      // UP
      if (compareEdge(tiles[i].edges[2], this.edges[0])) {
        this.up.push(tiles[i]);
      }
      // RIGHT
      if (compareEdge(tiles[i].edges[3], this.edges[1])) {
        this.right.push(tiles[i]);
      }
      // DOWN
      if (compareEdge(tiles[i].edges[0], this.edges[2])) {
        this.down.push(tiles[i]);
      }
      // LEFT
      if (compareEdge(tiles[i].edges[1], this.edges[3])) {
        this.left.push(tiles[i]);
      }
    }
  }

  rotate(num) {
    // Rotate edges
    let newEdges = this.edges.slice(); // Copy array
    for (let i = 0; i < 4; i++) {
      newEdges[i] = this.edges[(i - num + 4) % 4];
    }
    return new Tile(this.index, num, newEdges);
  }
}

// The one rule of the collapse: the heights along two facing edges must match.
// An edge label lists three heights, read clockwise:
//   N water, 0 ground, 1 veranda eave, 2 veranda top = main roof eave, 3 main ridge,
//   4 high ridge, T two-storey pavilion, B bridge.
// The letters U, P, D and C all stand at height 2. They only tell which roof element arrives there:
//   U veranda top, P veranda top with a ridge cap, D main roof eave, C valley corner.
// The collapse ignores that, except that D never meets D (two roofs coming down to one gutter)
// and C never meets C (two valleys running into the same corner, a pit);
// the ridge caps are added afterwards by applyRidgeElements().

// Switches set from the interface. They take effect at the next generation.
const ruleOptions = {
  useLandscapeBlocks: true, // blocks 3, 5 and 24-31: water, shore, bridge
};
const landscapeBlockIndices = [3, 5, 24, 25, 26, 27, 28, 29, 30, 31];
// Play mode: the player sets the level of the points between the cells (water -1, ground 0,
// building 1, two-storey pavilion 2), and every cell takes a block whose corners have those levels.
let playModeIsOn = false;
// Left out of play mode, so that the corners nearly decide the block: the ridge-cap verandas and
// the second gable style come afterwards anyway, block 4 is mislabelled, and the island and the
// bridges would only be random extras.
const playExcludedBlockIndices = [4, 5, 8, 11, 12, 13, 19, 27, 30, 31];
// Veranda blocks that are block 7 or 10 plus ridge caps; the collapse uses 7 and 10 only
const ridgeVariantBlockIndices = [8, 11, 12, 13];
// Block 4 has the model of block 1 but the edges of block 2, so it is left out of the collapse
const mislabelledBlockIndices = [4];
// Blocks 18 and 19 are two styles of the same gable end. The collapse uses 18 only; afterwards
// one style is picked for the whole scheme by applyGableEndStyle().
const gableEndBlockIndices = [18, 19];
const alternativeGableEndBlockIndices = [19];
// Each of these carries half a bridge, on its NBN edge
const bridgeBlockIndices = [27, 30, 31];
// Block 29 has the edges of block 28, but a channel joins its two water corners
const channelBlockIndices = [29];
const maximumWaterPieceCount = 2;
let activeTiles = [];

let tiles = [
  //4 axis of symmetry
  new Tile(0, 0, ["000", "000", "000", "000"]),
  new Tile(1, 0, ["DDD", "DDD", "DDD", "DDD"]),
  new Tile(2, 0, ["C3C", "C3C", "C3C", "C3C"]),
  new Tile(3, 0, ["NNN", "NNN", "NNN", "NNN"]),
  new Tile(4, 0, ["C3C", "C3C", "C3C", "C3C"]),
  new Tile(5, 0, ["NNN", "NNN", "NNN", "NNN"]),
  //2 axis of symmetry
  new Tile(6, 0, ["232", "DDD", "232", "DDD"]),
  //1 axis of symmetry
    new Tile(7, 0, ["012", "UUU", "210", "000"]),
  new Tile(8, 0, ["012", "PPP", "210", "000"]),
  new Tile(9, 0, ["012", "210", "000", "000"]),
  new Tile(10, 0, ["UUU", "UUU", "210", "012"]),
  new Tile(11, 0, ["PPP", "PPP", "210", "012"]),
  new Tile(12, 0, ["PPP", "UUU", "210", "012"]),
  new Tile(13, 0, ["UUU", "PPP", "210", "012"]),
  new Tile(14, 0, ["234", "444", "432", "DDD"]),
  new Tile(15, 0, ["234", "432", "DDD", "DDD"]),
  new Tile(16, 0, ["444", "444", "43C", "C34"]),
  new Tile(17, 0, ["23C", "C3C", "C32", "DDD"]),
  new Tile(18, 0, ["DDD", "232", "DDD", "DDD"]),
  new Tile(19, 0, ["DDD", "232", "DDD", "DDD"]),
  new Tile(20, 0, ["234", "43C", "C32", "DDD"]),
  new Tile(21, 0, ["432", "DDD", "23C", "C34"]),
  new Tile(22, 0, ["DDD", "DDD", "23C", "C32"]),
  new Tile(23, 0, ["2T4", "4T2", "DDD", "DDD"]),
  //1 axis of symmetry, landscape tiles
  new Tile(24, 0, ["N00", "000", "000", "00N"]),
  new Tile(25, 0, ["NNN", "N00", "00N", "NNN"]),
  new Tile(26, 0, ["N00", "000", "00N", "NNN"]),
  new Tile(27, 0, ["N00", "000", "00N", "NBN"]),
  new Tile(28, 0, ["N00", "00N", "N00", "00N"]),
  new Tile(29, 0, ["N00", "00N", "N00", "00N"]),
  new Tile(30, 0, ["00N", "NBN", "NNN", "N00"]),
  new Tile(31, 0, ["N00", "00N", "NNN", "NBN"])]

// Add rotate tiles
tiles.push(tiles[6].rotate(1));
// Rotate tiles, add all 3 other directions
for (let i = 7; i < 32; i++) {
  for (let j = 1; j < 4; j++) {
    tiles.push(tiles[i].rotate(j));
  }
}
// The tiles the collapse may use, and who may sit next to whom, under the current rule switches
function rebuildTileRules() {
  activeTiles = tiles.filter(function (tile) {
    if (playModeIsOn) {
      return !playExcludedBlockIndices.includes(tile.index);
    }
    if (ridgeVariantBlockIndices.includes(tile.index) || mislabelledBlockIndices.includes(tile.index) ||
        alternativeGableEndBlockIndices.includes(tile.index)) {
      return false;
    }
    return ruleOptions.useLandscapeBlocks || !landscapeBlockIndices.includes(tile.index);
  });
  for (let p = 0; p < tiles.length; p++) {
    tiles[p].up = [];
    tiles[p].right = [];
    tiles[p].down = [];
    tiles[p].left = [];
  }
  for (let p = 0; p < activeTiles.length; p++) {
    activeTiles[p].analyze(activeTiles);
  }
}
rebuildTileRules();

class Cell {
  constructor(i, j, tiles) {
    this.i = i;
    this.j = j;
    this.collapsed = false;
    this.options = tiles.slice(); // Copy array
    this.chosen = null;
  }

  checkNeighbors(grid) {
    if (this.j < rows - 1) {
      let up = grid[this.i][this.j + 1];
      if (!up.collapsed) {
        up.options = checkValid(up.options, this.chosen.up);
      }
    }
    if (this.i < cols - 1) {
      let right = grid[this.i + 1][this.j];
      if (!right.collapsed) {
        right.options = checkValid(right.options, this.chosen.right);
      }
    }
    if (this.j > 0) {
      let down = grid[this.i][this.j - 1];
      if (!down.collapsed) {
        down.options = checkValid(down.options, this.chosen.down);
      }
    }
    if (this.i > 0) {
      let left = grid[this.i - 1][this.j];
      if (!left.collapsed) {
        left.options = checkValid(left.options, this.chosen.left);
      }
    }
  }
}
function reverseString(s) {
  return s.split('').reverse().join('');
}

// The heights along an edge: every roof element letter stands at height 2
function edgeHeights(label) {
  return label.replace(/[UPDC]/g, "2");
}

function compareEdge(a, b) {
  // Two main roofs coming down to the same edge would leave a gutter between them
  if (a === "DDD" && b === "DDD") {
    return false;
  }
  // Two valley corners at the same point would pour into each other and leave a pit
  for (let position = 0; position < 3; position++) {
    if (a[position] === "C" && b[2 - position] === "C") {
      return false;
    }
  }
  return edgeHeights(a) === reverseString(edgeHeights(b));
}

// One bridge per scheme. A bridge is two half-bridge blocks facing each other, so once the first
// half is placed, only the cell across its NBN edge may still take a bridge block.
function removeOtherBridgeOptions(bridgeCell, grid, unsolved) {
  const bridgeEdgeIndex = bridgeCell.chosen.edges.indexOf("NBN");
  const columnSteps = [0, 1, 0, -1];
  const rowSteps = [1, 0, -1, 0];
  const otherHalfColumn = bridgeCell.i + columnSteps[bridgeEdgeIndex];
  const otherHalfRow = bridgeCell.j + rowSteps[bridgeEdgeIndex];
  unsolved.forEach(function (cell) {
    if (cell === bridgeCell || (cell.i === otherHalfColumn && cell.j === otherHalfRow)) {
      return;
    }
    cell.options = cell.options.filter(function (tile) {
      return !bridgeBlockIndices.includes(tile.index);
    });
  });
}

function isWaterHeight(height) {
  return height === "N" || height === "B";
}

// The number of separate pieces of water in the scheme. Every block has twelve stretches of edge
// (four edges of three heights, clockwise). Water stretches that follow each other around a block
// are one piece of water, and so are the two stretches that face each other across an edge.
function countWaterPieces(grid) {
  const stretchesPerCell = 12;
  const rowCount = grid[0].length;
  const pieceOfStretch = new Map(); // stretch -> the stretch that stands for its piece
  function stretchId(column, row, edgeIndex, position) {
    return (column * rowCount + row) * stretchesPerCell + edgeIndex * 3 + position;
  }
  function findPiece(stretch) {
    while (pieceOfStretch.get(stretch) !== stretch) {
      pieceOfStretch.set(stretch, pieceOfStretch.get(pieceOfStretch.get(stretch)));
      stretch = pieceOfStretch.get(stretch);
    }
    return stretch;
  }
  function joinPieces(firstStretch, secondStretch) {
    if (pieceOfStretch.has(firstStretch) && pieceOfStretch.has(secondStretch)) {
      pieceOfStretch.set(findPiece(firstStretch), findPiece(secondStretch));
    }
  }
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < rowCount; j++) {
      const tile = grid[i][j].chosen;
      if (!tile) {
        continue;
      }
      for (let edgeIndex = 0; edgeIndex < 4; edgeIndex++) {
        for (let position = 0; position < 3; position++) {
          if (isWaterHeight(tile.edges[edgeIndex][position])) {
            const stretch = stretchId(i, j, edgeIndex, position);
            pieceOfStretch.set(stretch, stretch);
          }
        }
      }
    }
  }
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < rowCount; j++) {
      const tile = grid[i][j].chosen;
      if (!tile) {
        continue;
      }
      const firstStretchOfCell = stretchId(i, j, 0, 0);
      for (let around = 0; around < stretchesPerCell; around++) {
        joinPieces(firstStretchOfCell + around, firstStretchOfCell + (around + 1) % stretchesPerCell);
        if (channelBlockIndices.includes(tile.index)) {
          joinPieces(firstStretchOfCell + around, firstStretchOfCell + (around + 6) % stretchesPerCell);
        }
      }
      for (let position = 0; position < 3; position++) {
        if (j < rowCount - 1) {
          joinPieces(stretchId(i, j, 0, position), stretchId(i, j + 1, 2, 2 - position));
        }
        if (i < grid.length - 1) {
          joinPieces(stretchId(i, j, 1, position), stretchId(i + 1, j, 3, 2 - position));
        }
      }
    }
  }
  const pieces = new Set();
  pieceOfStretch.forEach(function (unused, stretch) {
    pieces.add(findPiece(stretch));
  });
  return pieces.size;
}

// All the gable ends of a scheme get the same one of the two styles
function applyGableEndStyle(gableEndBlockIndex) {
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const tile = grid[i][j].chosen;
      if (tile && gableEndBlockIndices.includes(tile.index) && tile.index !== gableEndBlockIndex) {
        grid[i][j].chosen = createOrientedTile(gableEndBlockIndex, tile.ro, tile.mirrored);
        placeBlockInScene(grid[i][j]);
      }
    }
  }
}

// The level of one corner of a block, read from the two edges that meet there:
// N water -1, 0 ground 0, the 4 between two T edges is the middle of the pavilion 2, any roof height 1
function cornerLevelFromEdges(firstEdge, firstPosition, secondEdge) {
  const height = firstEdge[firstPosition];
  if (height === "N") {
    return -1;
  }
  if (height === "0") {
    return 0;
  }
  if (height === "4" && firstEdge[1] === "T" && secondEdge[1] === "T") {
    return 2;
  }
  return 1;
}

// The levels of the four corners of a block, in the order top left, top right, bottom right, bottom left
const cornerLevelsOfTile = new Map();
function tileCornerLevels(tile) {
  if (!cornerLevelsOfTile.has(tile)) {
    const [up, right, down, left] = tile.edges;
    cornerLevelsOfTile.set(tile, [
      cornerLevelFromEdges(up, 0, left),
      cornerLevelFromEdges(up, 2, right),
      cornerLevelFromEdges(right, 2, down),
      cornerLevelFromEdges(down, 2, left)]);
  }
  return cornerLevelsOfTile.get(tile);
}

// Play mode: fills a grid of cells with blocks whose corners have the given levels and whose
// edges fit each other. After every choice the consequences are carried through the whole grid
// (constraint propagation), so a shape that can be built is nearly always found on the first try.
// levelAtPoint(column, row) gives the level of a point; a cell (i, j) has the points (i, j) to
// (i + 1, j + 1) around it. A cell keeps its previous block where that still fits.
// Returns { grid } or { failure } with the reason.
const cornerSolveAttemptCount = 20;
const neighbourDirections = [
  { columnStep: 0, rowStep: 1, adjacencyName: "up" },
  { columnStep: 1, rowStep: 0, adjacencyName: "right" },
  { columnStep: 0, rowStep: -1, adjacencyName: "down" },
  { columnStep: -1, rowStep: 0, adjacencyName: "left" }];

function describeMissingCorners(levels) {
  const hasWater = levels.includes(-1);
  const hasBuilding = levels.some(function (level) {
    return level >= 1;
  });
  if (hasWater && hasBuilding) {
    return "water can't touch a building";
  }
  if (levels[0] === levels[2] && levels[1] === levels[3] && levels[0] !== levels[1]) {
    return "no block for a diagonal";
  }
  if (levels.includes(2)) {
    return "a pavilion needs building all around";
  }
  return "no block has corners " + levels.join(", ");
}

function solveCornerGrid(columnCount, rowCount, levelAtPoint, previousTiles, seed) {
  // the blocks each cell may take, from its corners alone
  const cornerOptions = [];
  for (let i = 0; i < columnCount; i++) {
    cornerOptions.push([]);
    for (let j = 0; j < rowCount; j++) {
      const wanted = [levelAtPoint(i, j + 1), levelAtPoint(i + 1, j + 1), levelAtPoint(i + 1, j), levelAtPoint(i, j)];
      const options = activeTiles.filter(function (tile) {
        const levels = tileCornerLevels(tile);
        return levels[0] === wanted[0] && levels[1] === wanted[1] && levels[2] === wanted[2] && levels[3] === wanted[3];
      });
      if (options.length === 0) {
        return { failure: describeMissingCorners(wanted) };
      }
      cornerOptions[i].push(options);
    }
  }

  // narrows the neighbours of the listed cells to what can still sit next to them; false on a dead end
  function propagate(options, startCells) {
    const pending = startCells.slice();
    while (pending.length > 0) {
      const [i, j] = pending.pop();
      for (const direction of neighbourDirections) {
        const neighbourColumn = i + direction.columnStep;
        const neighbourRow = j + direction.rowStep;
        if (neighbourColumn < 0 || neighbourColumn >= columnCount || neighbourRow < 0 || neighbourRow >= rowCount) {
          continue;
        }
        const allowed = new Set();
        for (const tile of options[i][j]) {
          for (const neighbourTile of tile[direction.adjacencyName]) {
            allowed.add(neighbourTile);
          }
        }
        const before = options[neighbourColumn][neighbourRow];
        const after = before.filter(function (tile) {
          return allowed.has(tile);
        });
        if (after.length === 0) {
          return false;
        }
        if (after.length < before.length) {
          options[neighbourColumn][neighbourRow] = after;
          pending.push([neighbourColumn, neighbourRow]);
        }
      }
    }
    return true;
  }

  const everyCell = [];
  for (let i = 0; i < columnCount; i++) {
    for (let j = 0; j < rowCount; j++) {
      everyCell.push([i, j]);
    }
  }
  const startOptions = cornerOptions.map(function (column) {
    return column.slice();
  });
  if (!propagate(startOptions, everyCell)) {
    return { failure: "too deep for a roof" };
  }

  for (let attempt = 0; attempt < cornerSolveAttemptCount; attempt++) {
    const options = startOptions.map(function (column) {
      return column.slice();
    });
    const random = new SeededRandom(seed + attempt);
    let deadEnd = false;
    for (;;) {
      // the undecided cell with the fewest choices left
      let nextCell = null;
      for (const [i, j] of everyCell) {
        const count = options[i][j].length;
        if (count > 1 && (nextCell === null || count < options[nextCell[0]][nextCell[1]].length)) {
          nextCell = [i, j];
        }
      }
      if (nextCell === null) {
        break;
      }
      const [i, j] = nextCell;
      const previousTile = previousTiles && attempt === 0 ? previousTiles[i][j] : null;
      const choice = options[i][j].includes(previousTile) ? previousTile : options[i][j][random.nextInt(options[i][j].length)];
      options[i][j] = [choice];
      if (!propagate(options, [[i, j]])) {
        deadEnd = true;
        break;
      }
    }
    if (!deadEnd) {
      return {
        grid: options.map(function (column) {
          return column.map(function (cellOptions) {
            return cellOptions[0];
          });
        })
      };
    }
  }
  return { failure: "the blocks don't fit" };
}

function isVerandaTop(label) {
  return label === "UUU" || label === "PPP";
}

// After the collapse: a veranda top gets a ridge cap where it meets another veranda top (the two
// make a low ridge), and none where it runs under a main roof eave. Each veranda block is swapped
// for the block of its family that carries exactly those caps.
const verandaBlockFamilies = [[7, 8], [10, 11, 12, 13]];
function applyRidgeElements() {
  const replacements = [];
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const tile = grid[i][j].chosen;
      if (!tile) {
        continue;
      }
      const family = verandaBlockFamilies.find(function (blockIndices) {
        return blockIndices.includes(tile.index);
      });
      if (!family) {
        continue;
      }
      const neighbourTiles = [
        j < grid[i].length - 1 ? grid[i][j + 1].chosen : null,
        i < grid.length - 1 ? grid[i + 1][j].chosen : null,
        j > 0 ? grid[i][j - 1].chosen : null,
        i > 0 ? grid[i - 1][j].chosen : null];
      const wantedEdges = tile.edges.map(function (label, edgeIndex) {
        if (!isVerandaTop(label)) {
          return label;
        }
        const neighbourTile = neighbourTiles[edgeIndex];
        const facesVerandaTop = Boolean(neighbourTile) && isVerandaTop(neighbourTile.edges[(edgeIndex + 2) % 4]);
        return facesVerandaTop ? "PPP" : "UUU";
      });
      for (const blockIndex of family) {
        const candidate = createOrientedTile(blockIndex, tile.ro, tile.mirrored);
        if (candidate.edges.join() === wantedEdges.join()) {
          if (blockIndex !== tile.index) {
            replacements.push([grid[i][j], candidate]);
          }
          break;
        }
      }
    }
  }
  // Swapped only after every cell is decided, so that the decisions do not depend on the order
  replacements.forEach(function (replacement) {
    replacement[0].chosen = replacement[1];
    placeBlockInScene(replacement[0]);
  });
  return replacements.length;
}

// Create scene, camera, and renderer
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xccddff);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(-42, 48, 56);

const cubeCamera = new THREE.CubeCamera(0.1, 1000, 256); // near, far, resolution
scene.add(cubeCamera);


const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // keeps the sunlit surfaces from burning out
renderer.toneMappingExposure = 1;
renderer.shadowMap.type = THREE.PCFShadowMap;



// A new map from a seed, at the size set in the settings
function generateWithSeed(seedValue) {
  const newRows = Math.round(Number(document.getElementById('rows').value));
  const newCols = Math.round(Number(document.getElementById('cols').value));
  if (newRows >= 2 && newCols >= 2 && newRows <= 12 && newCols <= 12) {
    rows = newRows;
    cols = newCols;
  }
  document.getElementById('rows').value = rows;
  document.getElementById('cols').value = cols;
  document.getElementById('seedInput').value = seedValue;
  currentSeed = seedValue;
  rng = new SeededRandom(seedValue);
  clearScene();
  startOver();
}
let currentSeed = defaultSeed;

document.getElementById('generateFromSettings').addEventListener('click', function() {
  const seedText = document.getElementById('seedInput').value.trim();
  const seed = seedText === '' ? Date.now() % 1000000 : parseInt(seedText);
  if (mapIsHexagonal) {
    startHexMap(seed);
  } else {
    generateWithSeed(seed);
  }
  document.getElementById('settings').classList.remove('open');
});

//add a directional light
const directionalLight = new THREE.DirectionalLight(0xffffee, 3);
// The sun keeps the compass direction it always had (from -x, +z, where the glow of the sky
// picture is too), but stands higher: at the old 24 degrees every roof slope turned away from
// it fell into full shadow and the long shadows of the roofs cut across each other.
const sunDistance = 250;
const sunAngles = { elevationDegrees: 55, azimuthDegrees: 153 };
placeSun();
directionalLight.target.position.set(0, 0, 0);
directionalLight.castShadow = true;
Object.assign(directionalLight.shadow.mapSize, {  width: 4096,  height: 4096});
Object.assign(directionalLight.shadow, {darkness: 1,  normalBias: 0.02}); // more normalBias draws lines along the creases
// The depth bias is set in metres in fitShadowToScheme: as a share of the depth range of the
// shadow, a fixed value pushed the shadows of an 11 x 11 map 20 cm away from what casts them.
// Tested from 0.005 to 0.21 m: below 0.05 m stripes of self-shadow appear on the flatter roofs,
// and 0.05 m still showed them in some views.
const shadowBiasMetres = 0.08;
scene.add(directionalLight);
fitShadowToScheme();

function placeSun() {
  const elevation = THREE.MathUtils.degToRad(sunAngles.elevationDegrees);
  const azimuth = THREE.MathUtils.degToRad(sunAngles.azimuthDegrees);
  directionalLight.position.set(
    sunDistance * Math.cos(elevation) * Math.cos(azimuth),
    sunDistance * Math.sin(elevation),
    sunDistance * Math.cos(elevation) * Math.sin(azimuth));
}

// The shadow map is spent on the scheme only: the tighter the fit, the crisper the shadow
function fitShadowToScheme() {
  const tallestObjectHeight = 26; // the two-storey pavilion reaches 17, a tree up to 25
  const planRadius = mapIsHexagonal && hexMap ? hexMap.radius : Math.hypot(cols * 3, rows * 3);
  const schemeRadius = Math.hypot(planRadius, tallestObjectHeight) + 3;
  const lightDistance = directionalLight.position.length();
  Object.assign(directionalLight.shadow.camera, {
    near: lightDistance - schemeRadius,  far: lightDistance + schemeRadius,
    left: -schemeRadius,  right: schemeRadius,  top: schemeRadius,  bottom: -schemeRadius});
  directionalLight.shadow.camera.updateProjectionMatrix();
  directionalLight.shadow.bias = -shadowBiasMetres / (2 * schemeRadius);
}
// scene.add ( directionalLight.target, new THREE.CameraHelper(directionalLight.shadow.camera));


const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
function createOrbitHelper(radius) {
  // Create a circle with only the outer edge
  const circleGeometry = new THREE.CircleGeometry(radius, 64);
  const edgesGeometry = new THREE.EdgesGeometry(circleGeometry); // Get only the outer edge
  const material = new THREE.LineBasicMaterial({ color: 0x888888 }); // Red color for visibility

  // Create a circle mesh
  const circle = new THREE.LineSegments(edgesGeometry, material);
  return circle;
}

// Create circles for each plane
const orbitHelperXY = createOrbitHelper(50);
const orbitHelperYZ = createOrbitHelper(50);
const orbitHelperXZ = createOrbitHelper(50);

// Rotate them to align with the planes
orbitHelperYZ.rotation.y = Math.PI / 2;
orbitHelperXZ.rotation.x = Math.PI / 2;

// Add the orbit helpers to the scene
// scene.add(orbitHelperXY, orbitHelperYZ, orbitHelperXZ);


// Create an AxesHelper with a given size
const axesHelper = new THREE.AxesHelper(50);
// scene.add(axesHelper);

// Add environmental lighting
const cubeTextureLoader = new THREE.CubeTextureLoader();
const environmentMapTexture = cubeTextureLoader.load([
  '/cubeTexture/2/px.png',
  '/cubeTexture/2/nx.png',
  '/cubeTexture/2/py.png',
  '/cubeTexture/2/ny.png',
  '/cubeTexture/2/pz.png',
  '/cubeTexture/2/nz.png',
], function (loadedTexture) {
  scene.environment = createShadowLightTexture(loadedTexture);
  if (pathTracer) {
    pathTracer.updateEnvironment();
  }
});
scene.environment = environmentMapTexture;
scene.background = environmentMapTexture;

// The light that fills the shadows comes from the sky picture, which is blue-violet and made the
// shadows cold and colourful. The light is taken from a copy of the sky that is mostly grey and
// a little warm; the sky one sees, and its reflection in the water, stay as they are.
const shadowLightSaturation = 0.15; // share of the sky's own colour that is kept
const shadowLightWarmth = new THREE.Color(1.1, 1.02, 0.76);
const shadowLightFaceSize = 512;
function createShadowLightTexture(skyTexture) {
  const faces = skyTexture.image.map(function (image) {
    // a quarter of the size is plenty for light, which is blurred anyway, and quick to tint
    const canvas = document.createElement('canvas');
    canvas.width = shadowLightFaceSize;
    canvas.height = shadowLightFaceSize;
    const drawingContext = canvas.getContext('2d');
    drawingContext.drawImage(image, 0, 0, shadowLightFaceSize, shadowLightFaceSize);
    const pixels = drawingContext.getImageData(0, 0, canvas.width, canvas.height);
    const values = pixels.data;
    for (let offset = 0; offset < values.length; offset += 4) {
      const brightness = 0.2126 * values[offset] + 0.7152 * values[offset + 1] + 0.0722 * values[offset + 2];
      values[offset] = Math.min(255, (brightness + (values[offset] - brightness) * shadowLightSaturation) * shadowLightWarmth.r);
      values[offset + 1] = Math.min(255, (brightness + (values[offset + 1] - brightness) * shadowLightSaturation) * shadowLightWarmth.g);
      values[offset + 2] = Math.min(255, (brightness + (values[offset + 2] - brightness) * shadowLightSaturation) * shadowLightWarmth.b);
    }
    drawingContext.putImageData(pixels, 0, 0);
    return canvas;
  });
  const shadowLightTexture = new THREE.CubeTexture(faces);
  shadowLightTexture.colorSpace = skyTexture.colorSpace;
  shadowLightTexture.needsUpdate = true;
  return shadowLightTexture;
}
const manager = new THREE.LoadingManager();




// Water seen from above reflects only a few percent as a plain dielectric, which against the dim
// sky light of the scene reads as black. Made partly metallic with a grey-blue tint, it mirrors
// the sky (and in path traced light also the buildings) clearly, in both kinds of rendering.
const waterReflectionStrength = 0.75; // in daylight; the time of day scales it
const reflectiveMaterial = new THREE.MeshStandardMaterial({
  color: 0x5c7482,
  metalness: 0.65,
  roughness: 0.04,
  envMap: environmentMapTexture,
  envMapIntensity: waterReflectionStrength,
  // like the water material of the model that this one replaces; the faces of block 31 are
  // inside out, so its water is only visible when both sides are drawn
  side: THREE.DoubleSide
});
console.log(reflectiveMaterial);

manager.onLoad = function() {
  // Called when all resources are loaded
  buildBlockPalette();
  applyTimeOfDay();
  // the first map is one of the registered rich variants (richVariants.js), and it opens in play mode
  playModeIsOn = true;
  generateWithSeed(richVariantSeeds[Math.floor(Math.random() * richVariantSeeds.length)]);
};
manager.itemStart('buildingBlocks');
// // Initial load
loadBuildingBlocks();

// A new map; play mode, when on, takes the new map over
function startOver() {
  const returnToPlayMode = playModeIsOn;
  if (playModeIsOn) {
    leavePlayMode();
  }
  generateScheme();
  showSchemeInfo();
  if (returnToPlayMode) {
    enterPlayModeKeepingMap();
  }
}

function generateScheme() {
  // A collapse attempt that runs into a contradiction is thrown away and retried.
  // Large grids need thousands of attempts, so this is a loop rather than a recursion.
  const maximumAttemptCount = 50000;
  for (let attemptCount = 1; attemptCount <= maximumAttemptCount; attemptCount++) {
    prepareGrid();
    if (collapse(unsolved, grid)) {
      applyRidgeElements();
      applyGableEndStyle(gableEndBlockIndices[rng.nextInt(gableEndBlockIndices.length)]);
      applyTerrainRelief();
      smoothRoofsAcrossBlocks();
      if (showTrees) {
        plantTrees();
      }
      resetEditorForNewScheme();
      return;
    }
  }
  console.warn('No valid scheme found in ' + maximumAttemptCount + ' attempts, try another seed.');
  resetEditorForNewScheme();
}

// The cells in the order the collapse decided them, for the film (film/capture_footage.js)
let collapseOrder = [];

function prepareGrid() {
  unsolved = [];
  grid = [];
  collapseOrder = [];
  // Create cell for each spot on the grid
  for (let i = 0; i < cols; i++) {
    grid.push([]);
    for (let j = 0; j < rows; j++) {
      grid[i].push(new Cell(i, j, activeTiles));
      unsolved.push(grid[i][j]);
    }
  }
  if(favorTwoStoreyPavilion && rng.nextFloat() < 0.5){
  let randomCell = grid[Math.floor(rng.nextFloat(cols / 3)+ cols / 3 )][Math.floor(rng.nextFloat(rows / 3)+rows / 3)]
  // console.log('tower',randomCell.i, randomCell.j)
  randomCell.chosen = tiles[23];
  randomCell.collapsed = true;
  randomCell.checkNeighbors(grid);
  let index = unsolved.indexOf(randomCell);
if (index > -1) {
  unsolved.splice(index, 1);
}}
 
  if(ruleOptions.useLandscapeBlocks && rng.nextFloat() < 0.5){
    let randomCell = grid[cols-1][rows-1];
    // console.log('pond',randomCell.i, randomCell.j)
    randomCell.chosen = tiles[3];
    randomCell.collapsed = true;
    randomCell.checkNeighbors(grid);
    let index = unsolved.indexOf(randomCell);
  if (index > -1) {
    unsolved.splice(index, 1);
  }}

  if (openEdge === true){
        for (let i = 0; i < cols; i++) {
          for (let j = 0; j < rows; j++) {
            if (i === 0 || i === cols - 1 || j === 0 || j === rows - 1) {
              grid[i][j].chosen = tiles[0];
              grid[i][j].collapsed = true;
              grid[i][j].checkNeighbors(grid);
              let index = unsolved.indexOf(grid[i][j]);
              if (index > -1) {
                unsolved.splice(index, 1);
              }
            }
          }
        }
      }

}

function plantTrees() {
  markSceneChanged();
  //traverse the collapsed grid, if it is a open land tiles[0] , add a tree
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
    if (grid[i][j].chosen && grid[i][j].chosen.index === 0 && rng.nextFloat() < 0.10){
      const pine = new PineTree(rng.nextInt(25) ,i*6 -cols*3 ,j * 6 - rows *3);
      pine.treeGroup.position.y = reliefHeightAt(grid[i][j], i*6 -cols*3, j * 6 - rows *3);
      pine.addToScene(scene);
      pine.generatedBlock = true;
    }
  }
}
}

function collapse(unsolved, grid) {
  let bridgeIsPlaced = false;
  while (unsolved.length > 0) {
    unsolved.sort((a, b) => a.options.length - b.options.length);
    if (unsolved[0].options.length === 0) {
      return false;
    } else {
      let chosen = unsolved[0].options[Math.floor(rng.nextFloat() * unsolved[0].options.length)];
      unsolved[0].chosen = chosen;
      unsolved[0].collapsed = true;
      collapseOrder.push(unsolved[0]);
      unsolved[0].checkNeighbors(grid);
      if (!bridgeIsPlaced && bridgeBlockIndices.includes(chosen.index)) {
        bridgeIsPlaced = true;
        removeOtherBridgeOptions(unsolved[0], grid, unsolved);
      }
      unsolved.shift();
    }
  }
  // Water in more than two separate pieces: the attempt is thrown away like a contradiction
  if (countWaterPieces(grid) > maximumWaterPieceCount) {
    return false;
  }

  if (unsolved.length === 0) {
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        placeBlockInScene(grid[i][j]);
      }
    }
  }
  return true;
  // Hide reflective meshes
  // scene.traverse((child) => {
  //   if (child.isMesh && child.material.name.startsWith('water')) {
  //     child.visible = false;
  //   }
  // });

  // // Set up CubeCamera and capture the environment
  // cubeCamera.update(renderer, scene);

  // // Show reflective meshes and set the environment map
  // scene.traverse((child) => {
  //   if (child.isMesh && child.material.name.startsWith('water')) {
  //     child.visible = true;
  //     child.material.envMap = cubeCamera.renderTarget.texture;
  //     child.material.needsUpdate = true; // Important to update the material
  //   }
  // });
}

// Puts the 3D block of a cell into the scene, replacing the one that was there
function placeBlockInScene(cell) {
  markSceneChanged();
  if (cell.sceneObject) {
    scene.remove(cell.sceneObject);
    disposeOwnGround(cell.sceneObject);
    cell.sceneObject = null;
  }
  if (!cell.chosen) {
    return;
  }
  // Get the chosen building block
  let chosenBlock = buildingBlocks[cell.chosen.index];
  // Clone the building block
  let house = chosenBlock.clone();
  // Make the object visible
  house.visible = true;
  house.castShadow = true; // this building will cast shadows
  house.receiveShadow = true; // this building will receive shadows
  house.position.set(cell.i*6 - cols*3 , 0, cell.j * 6 - rows*3);
  house.scale.set(cell.chosen.mirrored ? -1 : 1, 1, -1); //z flipped to adapt from blender
  house.rotation.set(0, cell.chosen.ro * Math.PI / 2 , 0);
  house.generatedBlock = true;
  house.userData.cell = cell;
  cell.sceneObject = house;
  // Add the house to the scene
  scene.add(house);
}

function checkValid(arr, valid) {
  for (let i = arr.length - 1; i >= 0; i--) {
    let element = arr[i];
    if (valid.indexOf(element) === -1) {
      arr.splice(i, 1);
    }
  }
  return arr;
}

function clearScene() {
  markSceneChanged();
  // Get a list of objects to remove
  const objectsToRemove = scene.children.filter((object) => object.generatedBlock === true);
  // Remove each object from the scene
  objectsToRemove.forEach((object) => {
    scene.remove(object);
    disposeOwnGround(object);
  });
  //the pines should be removed
  removeAllPinesFromScene(scene);

}

function removeAllPinesFromScene(scene) {
  markSceneChanged();
  playTreeOfCell.clear();
  hexTreeOfCell.clear();
  // Get all the tree groups (PineTree objects) from the scene
  const pineGroupsToRemove = scene.children.filter(object => object.generated === true);

  // Iterate over each tree group and remove it from the scene
  pineGroupsToRemove.forEach(treeGroup => {
      // Optional: Dispose of geometries and materials to free up GPU resources
      treeGroup.traverse(child => {
          child.geometry?.dispose();
          child.material?.dispose();
      });

      // Remove the tree group from the scene
      scene.remove(treeGroup);
  });
}

// Replaces the ground of a water block by one with rounded water lines (see softShore.js).
// The model has y up and z towards the viewer; softShore works in plan, with z up.
// In most blocks a few dozen triangles are wound against their own normals. A double-sided
// material takes such a triangle as seen from behind and turns its normal around, so it is lit as
// if it faced the other way. Turning those triangles makes winding and normal agree.
function makeWindingFollowNormals(geometry) {
  const index = geometry.index;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  if (!index || !normals) {
    return 0;
  }
  const cornerA = new THREE.Vector3();
  const cornerB = new THREE.Vector3();
  const cornerC = new THREE.Vector3();
  const windingNormal = new THREE.Vector3();
  const storedNormal = new THREE.Vector3();
  const edge = new THREE.Vector3();
  let turnedTriangleCount = 0;
  for (let corner = 0; corner < index.count; corner += 3) {
    const pointA = index.getX(corner);
    const pointB = index.getX(corner + 1);
    const pointC = index.getX(corner + 2);
    cornerA.fromBufferAttribute(positions, pointA);
    cornerB.fromBufferAttribute(positions, pointB);
    cornerC.fromBufferAttribute(positions, pointC);
    windingNormal.subVectors(cornerB, cornerA).cross(edge.subVectors(cornerC, cornerA));
    storedNormal.fromBufferAttribute(normals, pointA)
      .add(cornerB.fromBufferAttribute(normals, pointB))
      .add(cornerC.fromBufferAttribute(normals, pointC));
    if (windingNormal.dot(storedNormal) < 0) {
      index.setX(corner + 1, pointC);
      index.setX(corner + 2, pointB);
      turnedTriangleCount++;
    }
  }
  index.needsUpdate = true;
  return turnedTriangleCount;
}

// The roof faces are shaded flat in the model, so a curved roof shows its facets. Faces that
// meet at less than the crease angle (the facets of one curved face) are shaded as one smooth
// surface. Ridges, hips, valleys and the edges of the slab meet at more and stay sharp, and the
// ridge caps (roof.003) are not touched at all.
const roofCreaseAngle = THREE.MathUtils.degToRad(20);

function blockIndexOfModelPart(part, modelScene) {
  let ancestor = part;
  while (ancestor.parent && ancestor.parent !== modelScene) {
    ancestor = ancestor.parent;
  }
  return parseInt(ancestor.name);
}

// In the two-storey pavilion (block 23) the lower roof runs on inside the upper storey, behind its
// walls. That part is cut away: every roof triangle is clipped against the room of the upper storey
// and only the pieces outside it are kept. The cut lies inside the wall, so no edge shows.
// Model coordinates: y up, and the corner of the block at the middle of the pavilion is x 3, z -3.
const pavilionBlockIndex = 23;
const upperStoreyCut = {
  wallInsideX: -0.95,  // between the outer (-1.1) and inner (-0.8) face of the wall
  wallInsideZ: 0.95,   // the same wall on the other side (z is minus the plan y)
  floorHeight: 7.0,    // top of the balcony floor
  ceilingHeight: 9.8,  // under the ceiling of the upper storey, where the upper roof begins
};

// Keeps the part of a convex polygon on one side of a plane where a coordinate has a given value
function clipPolygon(points, axis, value, keepAbove) {
  const kept = [];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const currentIsKept = keepAbove ? current.getComponent(axis) >= value : current.getComponent(axis) <= value;
    const nextIsKept = keepAbove ? next.getComponent(axis) >= value : next.getComponent(axis) <= value;
    if (currentIsKept) {
      kept.push(current);
    }
    if (currentIsKept !== nextIsKept) {
      const fraction = (value - current.getComponent(axis)) / (next.getComponent(axis) - current.getComponent(axis));
      kept.push(current.clone().lerp(next, fraction));
    }
  }
  return kept;
}

function trimRoofInsideUpperStorey(geometry) {
  const flatGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = flatGeometry.attributes.position;
  const keptPositions = [];
  const xAxis = 0;
  const yAxis = 1;
  const zAxis = 2;
  for (let corner = 0; corner < positions.count; corner += 3) {
    const triangle = [0, 1, 2].map(function (offset) {
      return new THREE.Vector3().fromBufferAttribute(positions, corner + offset);
    });
    // the outside of the room, as four separate convex pieces
    const outsidePieces = [
      clipPolygon(triangle, xAxis, upperStoreyCut.wallInsideX, false),
      clipPolygon(clipPolygon(triangle, xAxis, upperStoreyCut.wallInsideX, true), zAxis, upperStoreyCut.wallInsideZ, true)];
    let insideColumn = clipPolygon(clipPolygon(triangle, xAxis, upperStoreyCut.wallInsideX, true), zAxis, upperStoreyCut.wallInsideZ, false);
    outsidePieces.push(clipPolygon(insideColumn, yAxis, upperStoreyCut.floorHeight, false));
    outsidePieces.push(clipPolygon(insideColumn, yAxis, upperStoreyCut.ceilingHeight, true));
    outsidePieces.forEach(function (piece) {
      for (let fan = 1; fan + 1 < piece.length; fan++) {
        [piece[0], piece[fan], piece[fan + 1]].forEach(function (point) {
          keptPositions.push(point.x, point.y, point.z);
        });
      }
    });
  }
  const trimmedGeometry = new THREE.BufferGeometry();
  trimmedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
  trimmedGeometry.computeVertexNormals();
  if (flatGeometry !== geometry) {
    flatGeometry.dispose();
  }
  geometry.dispose();
  return trimmedGeometry;
}

// Splits the roof's triangles near the borders of the block until no edge there is longer than
// half a metre, so that the roof can change smoothly where it meets the next block. An edge is
// split or not by its own length and place, so both triangles beside it agree and no gap opens.
const roofSubdivisionEdgeLength = 0.5;
const roofSubdivisionBand = 1.4; // in the block: further out than this from the middle
function isNearBlockBorder(point) {
  return Math.abs(point.x) > roofSubdivisionBand || Math.abs(point.z) > roofSubdivisionBand;
}

function subdivideNearBorders(geometry, longestEdgeLength = roofSubdivisionEdgeLength, splitsAt = isNearBlockBorder) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const sourcePositions = source.attributes.position;
  const points = [];
  const pointIndexOfKey = new Map();
  function pointIndexOf(x, y, z) {
    const key = Math.round(x * 10000) + ',' + Math.round(y * 10000) + ',' + Math.round(z * 10000);
    if (!pointIndexOfKey.has(key)) {
      pointIndexOfKey.set(key, points.length);
      points.push(new THREE.Vector3(x, y, z));
    }
    return pointIndexOfKey.get(key);
  }
  let triangles = [];
  for (let corner = 0; corner < sourcePositions.count; corner += 3) {
    triangles.push([0, 1, 2].map(function (offset) {
      return pointIndexOf(sourcePositions.getX(corner + offset), sourcePositions.getY(corner + offset), sourcePositions.getZ(corner + offset));
    }));
  }
  const middle = new THREE.Vector3();
  for (let round = 0; round < 6; round++) {
    const middleOfEdge = new Map();
    function splitPoint(first, second) {
      const key = first < second ? first + ',' + second : second + ',' + first;
      if (middleOfEdge.has(key)) {
        return middleOfEdge.get(key);
      }
      let result = -1;
      if (points[first].distanceTo(points[second]) > longestEdgeLength) {
        middle.addVectors(points[first], points[second]).multiplyScalar(0.5);
        if (splitsAt(middle)) {
          result = pointIndexOf(middle.x, middle.y, middle.z);
        }
      }
      middleOfEdge.set(key, result);
      return result;
    }
    let anySplit = false;
    const nextTriangles = [];
    triangles.forEach(function (triangle) {
      const splits = [0, 1, 2].map(function (edge) {
        return splitPoint(triangle[edge], triangle[(edge + 1) % 3]);
      });
      const splitCount = splits.filter(function (split) {
        return split >= 0;
      }).length;
      if (splitCount === 0) {
        nextTriangles.push(triangle);
        return;
      }
      anySplit = true;
      if (splitCount === 3) {
        const [a, b, c] = triangle;
        const [ab, bc, ca] = splits;
        nextTriangles.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      } else if (splitCount === 1) {
        const edge = splits.findIndex(function (split) {
          return split >= 0;
        });
        const first = triangle[edge];
        const second = triangle[(edge + 1) % 3];
        const opposite = triangle[(edge + 2) % 3];
        nextTriangles.push([first, splits[edge], opposite], [splits[edge], second, opposite]);
      } else {
        // two split edges: turned so that the unsplit one runs from a to b
        const unsplit = splits.findIndex(function (split) {
          return split < 0;
        });
        const a = triangle[unsplit];
        const b = triangle[(unsplit + 1) % 3];
        const c = triangle[(unsplit + 2) % 3];
        const onBc = splits[(unsplit + 1) % 3];
        const onCa = splits[(unsplit + 2) % 3];
        nextTriangles.push([a, b, onBc], [a, onBc, onCa], [onBc, c, onCa]);
      }
    });
    triangles = nextTriangles;
    if (!anySplit) {
      break;
    }
  }
  const positions = new Float32Array(triangles.length * 9);
  triangles.forEach(function (triangle, triangleIndex) {
    triangle.forEach(function (point, corner) {
      positions.set([points[point].x, points[point].y, points[point].z], triangleIndex * 9 + corner * 3);
    });
  });
  const subdivided = new THREE.BufferGeometry();
  subdivided.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  subdivided.computeVertexNormals();
  if (source !== geometry) {
    source.dispose();
  }
  geometry.dispose();
  return subdivided;
}

// Japanese roof tiles (sangawara) on the roof faces, in the normal view: rows of wave-shaped tiles
// running down the slope, laid in horizontal courses, each course overlapping the one below and
// casting a thin shadow line on it, and each tile a little lighter or darker than its neighbours.
// The shape stays as it is: the waves only tilt the shading. The path tracer sees plain roofs.
//
// Where the rows run is worked out once per block, when the model loads (addRoofTileAttributes),
// and stored on its points: which way the slope goes down, snapped to the nearest of the block's
// sides (so the twisted, upturned corners keep the rows of their face), how far across the slope
// each point lies, and whether the point is tiled at all (the hip strips are not). On the
// hexagonal map the bending of a block carries these along, so the rows follow the quad.
const roofTileWidth = 0.3;     // metres across the slope
const roofCourseHeight = 0.18; // metres of height from one course to the next
const hipStripAngleDegrees = 37; // a face turned further than this from the block's sides is a hip strip

function addRoofTileAttributes(geometry) {
  const positions = geometry.attributes.position; // three points per triangle: the roofs are not indexed
  const pointCount = positions.count;
  const weights = new Float32Array(pointCount);
  const acrossCoordinates = new Float32Array(pointCount);
  const slopeDirections = new Float32Array(pointCount * 3);
  const first = new THREE.Vector3();
  const second = new THREE.Vector3();
  const third = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  for (let corner = 0; corner + 2 < pointCount; corner += 3) {
    first.fromBufferAttribute(positions, corner);
    second.fromBufferAttribute(positions, corner + 1);
    third.fromBufferAttribute(positions, corner + 2);
    faceNormal.subVectors(second, first).cross(third.sub(first));
    if (faceNormal.y < 0) {
      faceNormal.negate();
    }
    faceNormal.normalize();
    const planLength = Math.hypot(faceNormal.x, faceNormal.z);
    let downX = 0;
    let downZ = 1;
    let weight = 0;
    if (planLength > 0.15) {
      const angleFromXDegrees = THREE.MathUtils.radToDeg(Math.atan2(Math.abs(faceNormal.z), Math.abs(faceNormal.x)));
      const turnFromSideDegrees = Math.min(angleFromXDegrees, 90 - angleFromXDegrees);
      weight = turnFromSideDegrees > hipStripAngleDegrees ? 0 : 1;
      if (Math.abs(faceNormal.x) > Math.abs(faceNormal.z)) {
        downX = Math.sign(faceNormal.x);
        downZ = 0;
      } else {
        downX = 0;
        downZ = Math.sign(faceNormal.z);
      }
    }
    for (let offset = 0; offset < 3; offset++) {
      const point = corner + offset;
      weights[point] = weight;
      // across the slope: the down direction turned a quarter
      acrossCoordinates[point] = positions.getX(point) * -downZ + positions.getZ(point) * downX;
      slopeDirections.set([downX, 0, downZ], point * 3);
    }
  }
  geometry.setAttribute('roofTileWeight', new THREE.BufferAttribute(weights, 1));
  geometry.setAttribute('roofTileAcross', new THREE.BufferAttribute(acrossCoordinates, 1));
  geometry.setAttribute('roofTileSlope', new THREE.BufferAttribute(slopeDirections, 3));
  // the baked tile textures (bakedTextures.js, for the path tracer) are laid by tile and course
  const uvs = new Float32Array(pointCount * 2);
  for (let point = 0; point < pointCount; point++) {
    const uv = roofTileUv(acrossCoordinates[point], positions.getY(point), weights[point] > 0.5, roofTileWidth, roofCourseHeight);
    uvs[point * 2] = uv[0];
    uvs[point * 2 + 1] = uv[1];
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

const roofTileMaterials = new Set(); // (they take the baked tile textures while the path tracer is on)
function addRoofTiles(material) {
  if (material.userData.hasRoofTiles) {
    return;
  }
  material.userData.hasRoofTiles = true;
  roofTileMaterials.add(material);
  material.onBeforeCompile = function (shader) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float roofTileWeight;
        attribute float roofTileAcross;
        attribute vec3 roofTileSlope;
        varying vec3 vRoofWorldPosition;
        varying float vRoofTileWeight;
        varying float vRoofTileAcross;
        varying vec3 vRoofTileSlope;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoofWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vRoofTileWeight = roofTileWeight;
        vRoofTileAcross = roofTileAcross;
        vRoofTileSlope = mat3(modelMatrix) * roofTileSlope;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRoofWorldPosition;
        varying float vRoofTileWeight;
        varying float vRoofTileAcross;
        varying vec3 vRoofTileSlope;
        float roofTileHash(vec2 cell) {
          return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 roofNormal = normalize(cross(dFdx(vRoofWorldPosition), dFdy(vRoofWorldPosition)));
        if (roofNormal.y < 0.0) {
          roofNormal = -roofNormal;
        }
        float slopeSine = length(roofNormal.xz);          // 0 on a flat roof, 1 on a wall
        float acrossTiles = vRoofTileAcross / ${roofTileWidth.toFixed(3)};
        float downCourses = vRoofWorldPosition.y / ${roofCourseHeight.toFixed(3)}; // courses are horizontal
        // the pattern fades where it would be finer than the pixels, on flat faces and on the hip strips
        float tilePixelSize = max(fwidth(acrossTiles), fwidth(downCourses));
        float roofTileVisibility = (1.0 - smoothstep(0.2, 0.5, tilePixelSize)) * smoothstep(0.15, 0.35, slopeSine) *
          smoothstep(0.5, 0.95, vRoofTileWeight);
        float wave = 0.5 + 0.5 * cos(6.2831853 * acrossTiles);            // 1 on a tile's back, 0 in the channel
        float course = fract(downCourses);                               // 0 at a course's lower edge
        float overlapShadow = smoothstep(0.0, 0.12, course);             // the line below each course's edge
        float tileShade = 0.94 + 0.12 * roofTileHash(floor(vec2(acrossTiles, downCourses)));
        float roofTileLight = (0.72 + 0.28 * wave) * (0.7 + 0.3 * overlapShadow) * tileShade;
        diffuseColor.rgb *= mix(1.0, roofTileLight, roofTileVisibility);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // fired clay, matt: no sheen off the roofs, the channels between the tiles the dullest
        roughnessFactor = max(roughnessFactor, 0.88 + 0.1 * (1.0 - wave) * roofTileVisibility);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // the slope of the wave across the tiles, and the step at each course, tilt the normal
          float waveSlope = -3.1415927 * sin(6.2831853 * acrossTiles) * 0.6;
          float courseStep = (1.0 - smoothstep(0.0, 0.12, course)) * 1.0;
          vec2 downPlan = normalize(vRoofTileSlope.xz + vec2(1e-6));
          vec3 acrossWorld = vec3(-downPlan.y, 0.0, downPlan.x);
          vec3 upSlopeWorld = normalize(cross(roofNormal, acrossWorld));
          vec3 tiltWorld = acrossWorld * waveSlope + upSlopeWorld * courseStep;
          vec3 tiltView = (viewMatrix * vec4(tiltWorld, 0.0)).xyz;
          tiltView -= normal * dot(tiltView, normal);
          normal = normalize(normal + tiltView * roofTileVisibility);
        }`);
  };
  material.customProgramCacheKey = function () {
    return 'roofTilesMatt';
  };
  material.needsUpdate = true;
}

function smoothRoofFaces(geometry) {
  const smoothGeometry = toCreasedNormals(geometry, roofCreaseAngle);
  geometry.dispose();
  return smoothGeometry;
}

// ---------------------------------------------------------------------------
// Relief of the open ground: up to 30 cm up and down (terrain.js). It is computed for every
// placed open-ground or water block from its position in the scene, so neighbouring blocks agree
// along their border, and it fades out towards buildings, so that nothing floats or sinks.
// Each such block gets its own copy of the ground, so the path tracer sees the relief too.
// ---------------------------------------------------------------------------
const terrainBlockIndices = [0].concat(landscapeBlockIndices);
// The relief runs over the land, down the banks and over the bed of the ponds. On the bed it is
// stronger, so that its highest places come up out of the water. The open land keeps above the
// water: its hollows level out softly a little above the water surface (-0.4), else a hollow
// crossing into a block without water would show a pond with a straight edge.
const waterSurfaceHeight = -0.4;
const undersideHeightLimit = -1.9;   // the underside of the ground slab stays where it is
const bedReliefScale = 1.25;         // upwards only: about 5% of a bed (-1.2) rises out of the water, up to 0.3
const landHollowSoftStart = -0.2;
const landHollowLowest = -0.33;
function groundReliefAt(flatHeight, relief) {
  let landRelief = relief;
  if (relief < landHollowSoftStart) {
    const softRange = landHollowSoftStart - landHollowLowest;
    landRelief = landHollowSoftStart - softRange * (1 - Math.exp((relief - landHollowSoftStart) / softRange));
  }
  const underwaterShare = 1 - THREE.MathUtils.smoothstep(flatHeight, waterSurfaceHeight, 0);
  const bedRelief = relief > 0 ? relief * bedReliefScale : relief; // not down through the underside (-2.4)
  return THREE.MathUtils.lerp(landRelief, bedRelief, underwaterShare);
}
const reliefFadeDistance = 3; // metres from the footprint of a building
const openGroundGridIntervalCount = 60; // 10 cm steps, point for point the same as the water blocks along a shared border
const flatGroundOfMesh = new WeakMap(); // ground mesh in the scene -> the unbent ground it copies

function makeOpenGroundBendable(block) {
  block.traverse(function (child) {
    if (child.isMesh && child.material.name.startsWith('ground')) {
      const arrays = buildFlatGroundArrays(3, -2, openGroundGridIntervalCount);
      const flatGeometry = new THREE.BufferGeometry();
      flatGeometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
      flatGeometry.setIndex(arrays.indices);
      flatGeometry.computeVertexNormals();
      child.geometry.dispose();
      child.geometry = flatGeometry;
    }
  });
}

// A block leaving the scene frees the copy of the ground that carried its relief
function disposeOwnGround(block) {
  block.traverse(function (child) {
    if (flatGroundOfMesh.has(child)) {
      child.geometry.dispose();
      flatGroundOfMesh.delete(child);
    }
    if (modelRoofOfMesh.has(child)) {
      child.geometry.dispose();
      modelRoofOfMesh.delete(child);
    }
  });
}

// ---------------------------------------------------------------------------
// Where a roof runs on from one block into the next, the shading must not break along the border.
// The upper roofs (the main roofs, edge DDD) are made of big flat triangles and meet the veranda's
// curved surface at a hard line. After every change of the map, along every border the shading of
// each point is averaged with the shading of the neighbouring roof at the same place along the
// border (found by interpolating between its points, so the two blocks need not have points in the
// same places), where the two belong to one surface. The roofs are finely divided near the block
// borders (subdivideNearBorders), so the change stays close to the border.
// (Moving the roofs themselves to close the 10 cm step at some of these borders was tried and
// dropped: the trims lying on the roofs did not move with them.)
// ---------------------------------------------------------------------------
const modelRoofOfMesh = new WeakMap(); // roof mesh in the scene -> the roof shared with the block
const roofBorderTolerance = 0.02;      // metres: a point this close to a border lies on it
const roofJoinHeightTolerance = 0.15;  // metres: points further apart in height are different surfaces
const roofJoinCreaseCosine = Math.cos(THREE.MathUtils.degToRad(25));

// The points of a cell's roof faces that lie on one of its four borders, upper surfaces only
function collectRoofBorderPoints(cell) {
  const borders = [[], [], [], []]; // up (+z), right (+x), down (-z), left (-x), as the edges of a tile
  const centreX = cellCenterX(cell.i);
  const centreZ = cellCenterZ(cell.j);
  const point = new THREE.Vector3();
  cell.sceneObject.traverse(function (child) {
    if (!child.isMesh || !child.material.name.startsWith('roof.002')) {
      return;
    }
    const positions = child.geometry.attributes.position;
    const normals = child.geometry.attributes.normal;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrixWorld);
    const inverseNormalMatrix = normalMatrix.clone().invert();
    for (let index = 0; index < positions.count; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(child.matrixWorld);
      const sceneNormal = new THREE.Vector3().fromBufferAttribute(normals, index).applyMatrix3(normalMatrix).normalize();
      if (sceneNormal.y < 0.2) {
        continue; // the underside and the edges of the roof slab
      }
      const entry = { mesh: child, index: index, height: point.y, sceneNormal: sceneNormal, inverseNormalMatrix: inverseNormalMatrix };
      if (Math.abs(point.z - (centreZ + cellSize / 2)) < roofBorderTolerance) {
        borders[0].push(Object.assign({ along: point.x }, entry));
      }
      if (Math.abs(point.x - (centreX + cellSize / 2)) < roofBorderTolerance) {
        borders[1].push(Object.assign({ along: point.z }, entry));
      }
      if (Math.abs(point.z - (centreZ - cellSize / 2)) < roofBorderTolerance) {
        borders[2].push(Object.assign({ along: point.x }, entry));
      }
      if (Math.abs(point.x - (centreX - cellSize / 2)) < roofBorderTolerance) {
        borders[3].push(Object.assign({ along: point.z }, entry));
      }
    }
  });
  borders.forEach(function (border) {
    border.sort(function (first, second) {
      return first.along - second.along;
    });
  });
  return borders;
}

// The height and shading of a border at a place along it, between the two nearest points of the
// surface closest to the given height; null where the border has no roof there
function borderSurfaceAt(border, along, nearHeight) {
  let best = null;
  for (let index = 0; index + 1 < border.length; index++) {
    const before = border[index];
    const after = border[index + 1];
    if (before.along > along + 1e-6 || after.along < along - 1e-6 || after.along - before.along > 1.5) {
      continue;
    }
    const share = after.along - before.along > 1e-6 ? (along - before.along) / (after.along - before.along) : 0;
    const height = THREE.MathUtils.lerp(before.height, after.height, share);
    if (best === null || Math.abs(height - nearHeight) < Math.abs(best.height - nearHeight)) {
      best = { height: height, normal: before.sceneNormal.clone().lerp(after.sceneNormal, share).normalize() };
    }
  }
  return best;
}

function smoothRoofsAcrossBlocks() {
  // every roof starts again from its block's own copy
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const block = grid[i][j].sceneObject;
      if (!block) {
        continue;
      }
      block.updateMatrixWorld(true);
      block.traverse(function (child) {
        if (!child.isMesh || !child.material.name.startsWith('roof.002')) {
          return;
        }
        if (!modelRoofOfMesh.has(child)) {
          modelRoofOfMesh.set(child, child.geometry);
        } else {
          child.geometry.dispose();
        }
        child.geometry = modelRoofOfMesh.get(child).clone();
      });
    }
  }
  // the pairs of neighbouring cells that both have a roof: [cell, its edge, neighbour, the neighbour's edge]
  const pairs = [];
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const cell = grid[i][j];
      if (!cell.chosen || !cell.sceneObject) {
        continue;
      }
      if (i + 1 < grid.length && grid[i + 1][j].chosen && grid[i + 1][j].sceneObject) {
        pairs.push([cell, 1, grid[i + 1][j], 3]);
      }
      if (j + 1 < grid[i].length && grid[i][j + 1].chosen && grid[i][j + 1].sceneObject) {
        pairs.push([cell, 0, grid[i][j + 1], 2]);
      }
    }
  }
  const bordersOfCell = new Map();
  function bordersOf(cell) {
    if (!bordersOfCell.has(cell)) {
      bordersOfCell.set(cell, collectRoofBorderPoints(cell));
    }
    return bordersOfCell.get(cell);
  }
  // the shading along every border, from the shading both sides had before any change
  const updates = [];
  pairs.forEach(function ([cell, edge, neighbour, neighbourEdge]) {
    const ownBorder = bordersOf(cell)[edge];
    const otherBorder = bordersOf(neighbour)[neighbourEdge];
    [[ownBorder, otherBorder], [otherBorder, ownBorder]].forEach(function ([border, facingBorder]) {
      border.forEach(function (entry) {
        const facing = borderSurfaceAt(facingBorder, entry.along, entry.height);
        if (!facing || Math.abs(facing.height - entry.height) > roofJoinHeightTolerance ||
            entry.sceneNormal.dot(facing.normal) < roofJoinCreaseCosine) {
          return; // not the same surface: a ridge, a hip, or a roof at another height
        }
        updates.push([entry, entry.sceneNormal.clone().add(facing.normal).normalize()]);
      });
    });
  });
  updates.forEach(function ([entry, sceneNormal]) {
    const localNormal = sceneNormal.applyMatrix3(entry.inverseNormalMatrix).normalize();
    entry.mesh.geometry.attributes.normal.setXYZ(entry.index, localNormal.x, localNormal.y, localNormal.z);
    entry.mesh.geometry.attributes.normal.needsUpdate = true;
  });
  markSceneChanged();
}

function isTerrainCell(cell) {
  return Boolean(cell.chosen) && terrainBlockIndices.includes(cell.chosen.index);
}

// The ground of the building blocks gets the relief too, where it lies at ground level around
// the buildings; the raised plinth they stand on stays as it is. Its triangles are split at load
// until no edge at ground level is longer than this, so the ground can follow the relief.
const buildingGroundEdgeLength = 0.4;
const groundLevelTolerance = 0.05;   // metres: points this close to height 0 lie at ground level
const plinthTopHeight = 1.0;          // metres: ground material higher than this belongs to the building

function makeBuildingGroundBendable() {
  buildingBlocks.forEach(function (block, blockIndex) {
    if (!block || terrainBlockIndices.includes(blockIndex)) {
      return;
    }
    block.traverse(function (child) {
      if (child.isMesh && child.material.name.startsWith('ground')) {
        child.geometry = subdivideNearBorders(child.geometry, buildingGroundEdgeLength, function (middle) {
          return Math.abs(middle.y) < groundLevelTolerance;
        });
      }
    });
  });
}

// The plan area each building stands on: the box around its raised plinth, in the scene.
// An empty cell of the editor counts as a whole building, so the ground levels out towards it.
let buildingFootprints = [];
function findBuildingFootprints() {
  const footprints = [];
  const point = new THREE.Vector3();
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const cell = grid[i][j];
      const wholeCell = {
        minimumX: cellCenterX(i) - cellSize / 2, maximumX: cellCenterX(i) + cellSize / 2,
        minimumZ: cellCenterZ(j) - cellSize / 2, maximumZ: cellCenterZ(j) + cellSize / 2,
      };
      if (!cell.chosen || !cell.sceneObject) {
        footprints.push(wholeCell);
        continue;
      }
      if (isTerrainCell(cell)) {
        continue;
      }
      const footprint = { minimumX: Infinity, maximumX: -Infinity, minimumZ: Infinity, maximumZ: -Infinity };
      cell.sceneObject.updateMatrixWorld(true);
      cell.sceneObject.traverse(function (child) {
        if (!child.isMesh || !child.material.name.startsWith('ground')) {
          return;
        }
        const positions = (flatGroundOfMesh.get(child) || child.geometry).attributes.position;
        for (let index = 0; index < positions.count; index++) {
          point.fromBufferAttribute(positions, index);
          if (point.y < groundLevelTolerance || point.y > plinthTopHeight) {
            continue;
          }
          point.applyMatrix4(child.matrixWorld);
          footprint.minimumX = Math.min(footprint.minimumX, point.x);
          footprint.maximumX = Math.max(footprint.maximumX, point.x);
          footprint.minimumZ = Math.min(footprint.minimumZ, point.z);
          footprint.maximumZ = Math.max(footprint.maximumZ, point.z);
        }
      });
      footprints.push(footprint.minimumX <= footprint.maximumX ? footprint : wholeCell);
    }
  }
  return footprints;
}

function footprintsNear(cell, footprints) {
  const reach = cellSize / 2 + reliefFadeDistance;
  return footprints.filter(function (footprint) {
    return footprint.maximumX > cellCenterX(cell.i) - reach && footprint.minimumX < cellCenterX(cell.i) + reach &&
      footprint.maximumZ > cellCenterZ(cell.j) - reach && footprint.minimumZ < cellCenterZ(cell.j) + reach;
  });
}

// 0 on and next to a building, rising to 1 over the fade distance away from it
function reliefWeightAt(x, z, footprints) {
  let nearestDistance = Infinity;
  for (const footprint of footprints) {
    const distanceX = Math.max(footprint.minimumX - x, 0, x - footprint.maximumX);
    const distanceZ = Math.max(footprint.minimumZ - z, 0, z - footprint.maximumZ);
    nearestDistance = Math.min(nearestDistance, Math.hypot(distanceX, distanceZ));
  }
  return THREE.MathUtils.smoothstep(nearestDistance, 0, reliefFadeDistance);
}

// The height of the relief at a point of the ground, for things standing on it
function reliefHeightAt(cell, x, z) {
  return groundReliefAt(0, terrainRelief(x, z) * reliefWeightAt(x, z, footprintsNear(cell, buildingFootprints)));
}

function applyTerrainRelief() {
  const flatPoint = new THREE.Vector3();
  const scenePoint = new THREE.Vector3();
  buildingFootprints = findBuildingFootprints();
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const cell = grid[i][j];
      if (!cell.sceneObject || !cell.chosen) {
        continue;
      }
      const isTerrain = isTerrainCell(cell);
      const nearbyFootprints = footprintsNear(cell, buildingFootprints);
      cell.sceneObject.updateMatrixWorld(true);
      cell.sceneObject.traverse(function (child) {
        if (!child.isMesh || !child.material.name.startsWith('ground')) {
          return;
        }
        if (!flatGroundOfMesh.has(child)) {
          flatGroundOfMesh.set(child, child.geometry); // still the geometry shared with the block
          child.geometry = child.geometry.clone();
        }
        const flatPositions = flatGroundOfMesh.get(child).attributes.position;
        const positions = child.geometry.attributes.position;
        for (let point = 0; point < flatPositions.count; point++) {
          flatPoint.fromBufferAttribute(flatPositions, point);
          scenePoint.copy(flatPoint).applyMatrix4(child.matrixWorld);
          if (!isTerrain) {
            // a building block: only its ground level moves; the plinth and the building stay
            if (flatPoint.y > plinthTopHeight || flatPoint.y <= undersideHeightLimit) {
              continue;
            }
            const isGroundLevel = Math.abs(flatPoint.y) < groundLevelTolerance;
            const relief = isGroundLevel
              ? terrainRelief(scenePoint.x, scenePoint.z) * reliefWeightAt(scenePoint.x, scenePoint.z, nearbyFootprints) : 0;
            const height = flatPoint.y + (isGroundLevel ? groundReliefAt(0, relief) : 0);
            positions.setY(point, height);
            paintGroundPoint(child.geometry, point, scenePoint.x, scenePoint.z, Math.max(flatPoint.y, 0), relief, height);
            continue;
          }
          const relief = flatPoint.y > undersideHeightLimit
            ? terrainRelief(scenePoint.x, scenePoint.z) * reliefWeightAt(scenePoint.x, scenePoint.z, nearbyFootprints) : 0;
          const height = flatPoint.y + groundReliefAt(flatPoint.y, relief);
          positions.setY(point, height);
          paintGroundPoint(child.geometry, point, scenePoint.x, scenePoint.z, flatPoint.y, relief, height);
        }
        positions.needsUpdate = true;
        child.geometry.attributes.color.needsUpdate = true;
        child.geometry.attributes.wetness.needsUpdate = true;
        if (child.geometry.index) {
          child.geometry.computeVertexNormals();
        } else {
          // the split ground of a building block: smooth over the ground, sharp at the plinth's edge
          child.geometry = toCreasedNormals(child.geometry, groundCreaseAngle);
        }
        child.geometry.computeBoundingSphere();
      });
    }
  }
  markSceneChanged();
}
const groundCreaseAngle = THREE.MathUtils.degToRad(40);

// ---------------------------------------------------------------------------
// Lush ground: one material for all the ground. Its colour is painted on the points of the ground
// (so the path tracer sees it too): broad patches of lush, sunny and mossy green, wet hollows in
// the low places of the relief turning to shallow standing water in the lowest, and wet mud down
// the banks of the ponds. In the normal view a shader adds the fine grain of the grass and makes
// the wet places glossy, so the standing water mirrors the sky.
// ---------------------------------------------------------------------------
const lushGrassColour = new THREE.Color(0x7a8a46);
const sunnyGrassColour = new THREE.Color(0xa7a45b);
const mossColour = new THREE.Color(0x5c6a3b);
const wetGrassColour = new THREE.Color(0x4e5532);
const standingWaterColour = new THREE.Color(0x26342c);
const mudColour = new THREE.Color(0x55492f);
const earthColour = new THREE.Color(0x5b4a33);
// how deep, as a share of the relief amplitude, a hollow must be to be wet, and to hold water
const wetHollowStart = 0.35;
const wetHollowFull = 0.75;
const standingWaterStart = 0.82;
let lushGroundMaterial = null;

// The colour and the wetness (0 dry to 1 standing water) of a point of the ground.
// x and z: position in the scene; flatHeight: height in the block before the relief; relief: added height
const paintedColour = new THREE.Color();
function paintGroundPoint(geometry, point, x, z, flatHeight, relief, height) {
  if (flatHeight <= undersideHeightLimit || (flatHeight < -0.02 && height < waterSurfaceHeight - 0.05)) {
    // the underside of the slab, and the bed of a pond under the water
    geometry.attributes.color.setXYZW(point, earthColour.r, earthColour.g, earthColour.b, 1);
    geometry.attributes.wetness.setX(point, 0);
    return;
  }
  if (flatHeight < -0.02) {
    // a bank, or a part of the bed above the water: wet mud, drying into grass higher up
    paintedColour.copy(mudColour).lerp(wetGrassColour, THREE.MathUtils.smoothstep(height, -0.25, 0.05));
    geometry.attributes.color.setXYZW(point, paintedColour.r, paintedColour.g, paintedColour.b, 1);
    geometry.attributes.wetness.setX(point, 1 - 0.5 * THREE.MathUtils.smoothstep(height, -0.25, 0.05));
    return;
  }
  const patch = groundColourNoise(x, z);
  paintedColour.copy(lushGrassColour);
  if (patch > 0) {
    paintedColour.lerp(sunnyGrassColour, patch * 0.8);
  } else {
    paintedColour.lerp(mossColour, -patch * 0.8);
  }
  const hollowDepth = -relief / reliefAmplitude;
  const hollowWetness = THREE.MathUtils.smoothstep(hollowDepth, wetHollowStart, wetHollowFull);
  const bankWetness = THREE.MathUtils.smoothstep(-flatHeight, 0.02, 0.45); // down the bank of a pond
  let wetness = Math.max(hollowWetness, bankWetness);
  paintedColour.lerp(bankWetness > hollowWetness ? mudColour : wetGrassColour, wetness * 0.85);
  const waterShare = THREE.MathUtils.smoothstep(hollowDepth, standingWaterStart, 0.95);
  if (waterShare > 0) {
    paintedColour.lerp(standingWaterColour, waterShare);
    wetness = 1;
  }
  geometry.attributes.color.setXYZW(point, paintedColour.r, paintedColour.g, paintedColour.b, 1);
  geometry.attributes.wetness.setX(point, wetness);
}

// Every piece of ground gets the lush material, with a plain colour where no relief is painted
// (the ground under the buildings, and the blocks in the palette)
function prepareLushGround(modelScene) {
  modelScene.traverse(function (child) {
    if (!child.isMesh || !child.material.name.startsWith('ground')) {
      return;
    }
    if (!lushGroundMaterial) {
      lushGroundMaterial = createLushGroundMaterial(child.material);
    }
    const pointCount = child.geometry.attributes.position.count;
    const modelColour = child.material.color;
    const positions = child.geometry.attributes.position;
    // four components: the path tracer gives every other mesh a four-component colour, and merges them
    const colours = new Float32Array(pointCount * 4);
    for (let point = 0; point < pointCount; point++) {
      // high up, the ground material dresses parts of the building: those keep the model's colour
      const colour = positions.getY(point) > plinthTopHeight ? modelColour : lushGrassColour;
      colours.set([colour.r, colour.g, colour.b, 1], point * 4);
    }
    child.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 4));
    child.geometry.setAttribute('wetness', new THREE.BufferAttribute(new Float32Array(pointCount), 1));
    // the baked grass texture (bakedTextures.js, for the path tracer) repeats with the blocks
    const uvs = new Float32Array(pointCount * 2);
    for (let point = 0; point < pointCount; point++) {
      const uv = groundUv(positions.getX(point), positions.getZ(point));
      uvs[point * 2] = uv[0];
      uvs[point * 2 + 1] = uv[1];
    }
    child.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    child.material = lushGroundMaterial;
  });
}

function createLushGroundMaterial(modelMaterial) {
  const material = modelMaterial.clone(); // keeps the name, which the rest of the code looks for
  material.color.set(0xffffff);
  material.vertexColors = true;
  material.roughness = 0.92;
  material.metalness = 0;
  material.onBeforeCompile = function (shader) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float wetness;
        varying float vGroundWetness;
        varying vec3 vGroundWorldPosition;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGroundWetness = wetness;
        vGroundWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGroundWetness;
        varying vec3 vGroundWorldPosition;
        float groundHash(vec2 position) {
          return fract(sin(dot(position, vec2(127.1, 311.7))) * 43758.5453);
        }
        float groundValueNoise(vec2 position) {
          vec2 cell = floor(position);
          vec2 fraction = fract(position);
          vec2 blend = fraction * fraction * (3.0 - 2.0 * fraction);
          return mix(mix(groundHash(cell), groundHash(cell + vec2(1.0, 0.0)), blend.x),
                     mix(groundHash(cell + vec2(0.0, 1.0)), groundHash(cell + vec2(1.0, 1.0)), blend.x), blend.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 groundPlan = vGroundWorldPosition.xz;
        float clumps = groundValueNoise(groundPlan * 1.3);   // tufts and clumps, under a metre
        float grain = groundValueNoise(groundPlan * 9.0);    // the grain of the grass blades
        float dryness = 1.0 - smoothstep(0.3, 0.9, vGroundWetness);
        diffuseColor.rgb *= mix(1.0, 0.78 + 0.32 * clumps, dryness);
        diffuseColor.rgb *= mix(1.0, 0.86 + 0.24 * grain, dryness);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.04, 0.82), dryness * smoothstep(0.65, 0.95, clumps));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.45, smoothstep(0.3, 0.8, vGroundWetness));
        roughnessFactor = mix(roughnessFactor, 0.06, smoothstep(0.9, 1.0, vGroundWetness));`);
  };
  material.customProgramCacheKey = function () {
    return 'lushGround';
  };
  return material;
}

function softenWaterLines(block) {
  block.traverse(function (child) {
    if (!child.isMesh || !child.material.name.startsWith('ground')) {
      return;
    }
    const modelledPositions = child.geometry.attributes.position;
    const modelledIndex = child.geometry.index;
    const cornerCount = modelledIndex ? modelledIndex.count : modelledPositions.count;
    const triangles = [];
    for (let corner = 0; corner < cornerCount; corner += 3) {
      const triangle = [];
      for (let offset = 0; offset < 3; offset++) {
        const point = modelledIndex ? modelledIndex.getX(corner + offset) : corner + offset;
        triangle.push([modelledPositions.getX(point), -modelledPositions.getZ(point), modelledPositions.getY(point)]);
      }
      triangles.push(triangle);
    }
    const softGround = buildSoftShoreGround(triangles);
    if (!softGround) {
      return; // no water line in this block
    }
    const positions = [];
    for (let point = 0; point < softGround.positions.length; point += 3) {
      positions.push(softGround.positions[point], softGround.positions[point + 2], -softGround.positions[point + 1]);
    }
    const softGeometry = new THREE.BufferGeometry();
    softGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    softGeometry.setIndex(softGround.topIndices.concat(softGround.sideIndices));
    softGeometry.computeVertexNormals();
    child.geometry.dispose();
    child.geometry = softGeometry;
  });
}

function loadBuildingBlocks() {
  // Clear existing mesh if any

  scene.children.forEach((object) => {
    if (object.isMesh) {
      scene.remove(object);
    }
  });
  
  // Load GLB file
  let loader = new GLTFLoader(manager);
  loader.load('/20230812_refactor.glb', function (gltf){
    gltf.scene.children.forEach((child) => {
        child.visible = false;
        // Store building blocks for future reference
        buildingBlocks[parseInt(child.name)] = child;
    });
    console.log(gltf.scene);
    scene.add(gltf.scene);

    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        makeWindingFollowNormals(child.geometry);
        // roof.002 is the roof faces; roof.003, the ridges and caps, stays as modelled
        if (child.material.name.startsWith('roof.002')) {
          if (blockIndexOfModelPart(child, gltf.scene) === pavilionBlockIndex) {
            child.geometry = trimRoofInsideUpperStorey(child.geometry);
          }
          child.geometry = addRoofTileAttributes(smoothRoofFaces(subdivideNearBorders(child.geometry)));
          addRoofTiles(child.material);
        }
        // Enable casting and receiving shadows for the mesh
        child.castShadow = true;
        // The materials are double-sided, and a thin roof slab drawn into the shadow map from both
        // sides shadows itself in wedges; only the faces turned towards the sun cast the shadow
        child.material.shadowSide = THREE.FrontSide;
        child.receiveShadow = true;
        if (child.material.name.startsWith('windowPaper')) {
          paperDoorMaterials.add(child.material);
        }
        if (child.material.name.startsWith('water')) {
          child.material = reflectiveMaterial;
        }
        // Modify material properties if needed
        // if (!child.material.transparent) {
        //   child.material.transparent = true;
        // }
      }
    });
    landscapeBlockIndices.forEach(function (blockIndex) {
      if (buildingBlocks[blockIndex]) {
        softenWaterLines(buildingBlocks[blockIndex]);
      }
    });
    makeOpenGroundBendable(buildingBlocks[0]);
    makeBuildingGroundBendable();
    prepareLushGround(gltf.scene);
    manager.itemEnd('buildingBlocks');
  });
}
// Add regeneration button

document.getElementById('regenerate').addEventListener('click', regenerate);

// //add a large plane down below at y = -10 to catch shadows
const planeGeometry = new THREE.PlaneGeometry(10000, 10000);
const planeMaterial = new THREE.MeshStandardMaterial({
  color: 0xaaccaa,
  side: THREE.DoubleSide,
});
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
plane.receiveShadow = true;
plane.rotation.x = Math.PI / 2;
plane.position.y = -1;
// scene.add(plane);

function regenerate() {
  if (mapIsHexagonal) {
    startHexMap(Date.now() % 1000000); // a new hexagonal grid
    return;
  }
  generateWithSeed(Date.now() % 1000000);
}

// ---------------------------------------------------------------------------
// Variety of a map: the Shannon entropy, in bits, of how often each block is used. A map of one
// block has 0 bits; the more kinds of block, and the more evenly used, the higher. The maps with
// the highest values are registered as rich variants in richVariants.js.
// ---------------------------------------------------------------------------
function blockVarietyBits(cells) {
  const countOfBlock = new Map();
  let cellCount = 0;
  cells.forEach(function (column) {
    column.forEach(function (cell) {
      if (cell.chosen) {
        countOfBlock.set(cell.chosen.index, (countOfBlock.get(cell.chosen.index) || 0) + 1);
        cellCount++;
      }
    });
  });
  let bits = 0;
  countOfBlock.forEach(function (count) {
    const share = count / cellCount;
    bits -= share * Math.log2(share);
  });
  return { bits: bits, blockKindCount: countOfBlock.size };
}

// The second measure: the variety of the combinations of blocks. At every point where four cells
// meet, the four blocks around it, each with the way it is turned and mirrored, form one
// combination. A combination and the same four blocks turned together by quarter turns count as
// one kind. The entropy is taken over how often each kind occurs.
const fourWaySymmetricBlockIndices = [0, 1, 2, 3, 4, 5]; // the same whichever way they are turned
const twoWaySymmetricBlockIndices = [6];                 // the same turned by half a turn

function orientedBlockKey(tile, extraQuarterTurns) {
  if (!tile) {
    return 'empty';
  }
  let quarterTurns = (tile.ro + extraQuarterTurns) % 4;
  if (fourWaySymmetricBlockIndices.includes(tile.index)) {
    quarterTurns = 0;
  } else if (twoWaySymmetricBlockIndices.includes(tile.index)) {
    quarterTurns = quarterTurns % 2;
  }
  return tile.index + '/' + quarterTurns + (tile.mirrored ? 'm' : '');
}

function junctionVarietyBits(cells) {
  const countOfKind = new Map();
  let junctionCount = 0;
  for (let i = 0; i + 1 < cells.length; i++) {
    for (let j = 0; j + 1 < cells[i].length; j++) {
      // clockwise from the top left: (i, j+1), (i+1, j+1), (i+1, j), (i, j)
      const around = [cells[i][j + 1].chosen, cells[i + 1][j + 1].chosen, cells[i + 1][j].chosen, cells[i][j].chosen];
      let kind = null;
      for (let quarterTurns = 0; quarterTurns < 4; quarterTurns++) {
        // turning the four together clockwise: each block moves one place on and turns a quarter
        const turned = [0, 1, 2, 3].map(function (place) {
          return orientedBlockKey(around[(place - quarterTurns + 4) % 4], quarterTurns);
        }).join(' ');
        if (kind === null || turned < kind) {
          kind = turned;
        }
      }
      countOfKind.set(kind, (countOfKind.get(kind) || 0) + 1);
      junctionCount++;
    }
  }
  let bits = 0;
  countOfKind.forEach(function (count) {
    const share = count / junctionCount;
    bits -= share * Math.log2(share);
  });
  return { bits: bits, kindCount: countOfKind.size, junctionCount: junctionCount };
}

function showSchemeInfo() {
  const isRich = richVariantSeeds.includes(currentSeed) ? ', a rich variant' : '';
  document.getElementById('schemeInfo').textContent = 'Seed ' + currentSeed + isRich;
}

// Both entropies of the scene as it is now, after every change: the numbers, and bars against the
// most the map could reach (every kind used equally often, and no more kinds than places to fill)
const blockKindTotal = 32;
function showSceneEntropy() {
  const blockVariety = blockVarietyBits(mapIsHexagonal ? [hexCells] : grid);
  const junctionVariety = mapIsHexagonal ? hexJunctionVarietyBits() : junctionVarietyBits(grid);
  const cellCount = mapIsHexagonal ? hexCells.length : grid.length * (grid[0] ? grid[0].length : 0);
  const largestBlockBits = Math.log2(Math.max(2, Math.min(blockKindTotal, cellCount)));
  const largestJunctionBits = Math.log2(Math.max(2, junctionVariety.junctionCount));
  document.getElementById('blockEntropyValue').textContent = blockVariety.bits.toFixed(2);
  document.getElementById('blockEntropyBar').style.width = Math.min(100, 100 * blockVariety.bits / largestBlockBits) + '%';
  document.getElementById('junctionEntropyValue').textContent = junctionVariety.bits.toFixed(2);
  document.getElementById('junctionEntropyBar').style.width = Math.min(100, 100 * junctionVariety.bits / largestJunctionBits) + '%';
  document.getElementById('entropyDetail').textContent = blockVariety.blockKindCount + ' kinds of block, ' +
    junctionVariety.kindCount + ' kinds of combination';
}

// The statistics behind richVariants.js, to run from the browser console after a change of the
// rules or the blocks, with the settings as they should be for the first map:
// measureSchemeVariety(1, 400) generates the maps of seeds 1 to 400 and lists the richest.
window.measureSchemeVariety = function (firstSeed, seedCount) {
  const results = [];
  for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
    generateWithSeed(seed);
    const blockVariety = blockVarietyBits(grid);
    const junctionVariety = junctionVarietyBits(grid);
    results.push({
      seed: seed,
      combinationBits: Number(junctionVariety.bits.toFixed(3)),
      combinationKindCount: junctionVariety.kindCount,
      blockBits: Number(blockVariety.bits.toFixed(3)),
      blockKindCount: blockVariety.blockKindCount,
    });
  }
  // ranked by the variety of the combinations, which also rewards varied blocks
  results.sort(function (first, second) {
    return second.combinationBits - first.combinationBits;
  });
  console.table(results.slice(0, 20));
  return results;
};

document.getElementById('saveImage').addEventListener('click', function() {
  captureImage = true;
});

// ---------------------------------------------------------------------------
// Manual editor: choose a block, place it on a cell, rotate or mirror it.
// An unallowed connection is kept, and marked with a red wall on the shared edge.
// ---------------------------------------------------------------------------
const cellSize = 6;
const conflictMarkerHeight = 12;
const clickMovementTolerance = 5; // pixels; a longer drag is an orbit, not a click

let brushBlockIndex = null; // null means the select tool: a click only selects
const eraseBrush = 'erase';  // the erase tool: a click removes the block
let brushQuarterTurnCount = 0;
let brushIsMirrored = false;
let selectedCell = null;
let hoveredCell = null;
let hoverNeedsUpdate = false;
let conflictMarkers = [];
let pointerDownX = 0;
let pointerDownY = 0;

const raycaster = new THREE.Raycaster();
const pointerPosition = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const hoverOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(cellSize, cellSize)),
  new THREE.LineBasicMaterial({ color: 0x00ccff, depthTest: false }));
hoverOutline.rotation.x = -Math.PI / 2;
hoverOutline.renderOrder = 10;
hoverOutline.visible = false;
scene.add(hoverOutline);

const selectionOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(cellSize, conflictMarkerHeight, cellSize)),
  new THREE.LineBasicMaterial({ color: 0xffaa00, depthTest: false }));
selectionOutline.renderOrder = 11;
selectionOutline.visible = false;
scene.add(selectionOutline);

const emptyCellOutlines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x555555 }));
emptyCellOutlines.frustumCulled = false; // its geometry is rebuilt on every edit
emptyCellOutlines.visible = false;
scene.add(emptyCellOutlines);

const conflictWallGeometry =new THREE.PlaneGeometry(cellSize, conflictMarkerHeight);
const conflictWallMaterial = new THREE.MeshBasicMaterial({
  color: 0xff0000, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
const conflictEdgeGeometry = new THREE.EdgesGeometry(conflictWallGeometry);
const conflictEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false, transparent: true, opacity: 0.5 });

function cellCenterX(column) {
  return column * cellSize - cols * cellSize / 2;
}

function cellCenterZ(row) {
  return row * cellSize - rows * cellSize / 2;
}

// A block in a given orientation. The mirror is applied first (left and right swap), then the rotation.
function createOrientedTile(blockIndex, quarterTurnCount, isMirrored) {
  let edges = tiles[blockIndex].edges; // tiles[0..31] are the unrotated blocks
  if (isMirrored) {
    edges = [reverseString(edges[0]), reverseString(edges[3]), reverseString(edges[2]), reverseString(edges[1])];
  }
  const orientedTile = new Tile(blockIndex, 0, edges).rotate(quarterTurnCount);
  orientedTile.mirrored = isMirrored;
  return orientedTile;
}

function removePinesAtCell(cell) {
  markSceneChanged();
  const pinesAtCell = scene.children.filter(function (object) {
    return object.generated === true && object.position.x === cellCenterX(cell.i) && object.position.z === cellCenterZ(cell.j);
  });
  pinesAtCell.forEach(function (treeGroup) {
    treeGroup.traverse(function (child) {
      child.geometry?.dispose();
      child.material?.dispose();
    });
    scene.remove(treeGroup);
  });
}

function setCellTile(cell, tile) {
  if (cell.hexIndex !== undefined) {
    setHexCellTile(cell, tile);
    return;
  }
  cell.chosen = tile;
  cell.collapsed = tile !== null;
  removePinesAtCell(cell);
  placeBlockInScene(cell);
  applyRidgeElements(); // the verandas around take the ridge caps their new neighbours call for
  applyTerrainRelief(); // the neighbours fade their relief out next to a new building
  smoothRoofsAcrossBlocks();
  refreshConflictMarkers();
  updateEditorStatus();
}

function addConflictMarker(positionX, positionZ, wallRunsAlongZ) {
  const marker = new THREE.Group();
  const wall = new THREE.Mesh(conflictWallGeometry, conflictWallMaterial);
  const wallEdges = new THREE.LineSegments(conflictEdgeGeometry, conflictEdgeMaterial);
  wall.renderOrder = 8;
  wallEdges.renderOrder = 9;
  marker.add(wall, wallEdges);
  marker.position.set(positionX, conflictMarkerHeight / 2, positionZ);
  if (wallRunsAlongZ) {
    marker.rotation.y = Math.PI / 2;
  }
  scene.add(marker);
  conflictMarkers.push(marker);
}

// Compares every pair of neighbouring blocks with the collapse rule and marks the unallowed ones
function refreshConflictMarkers() {
  conflictMarkers.forEach(function (marker) {
    scene.remove(marker);
  });
  conflictMarkers = [];
  if (mapIsHexagonal) {
    refreshHexConflictMarkers();
  }
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const tile = grid[i][j].chosen;
      if (!tile) {
        continue;
      }
      if (i < grid.length - 1) {
        const rightTile = grid[i + 1][j].chosen;
        if (rightTile && !compareEdge(rightTile.edges[3], tile.edges[1])) {
          addConflictMarker(cellCenterX(i) + cellSize / 2, cellCenterZ(j), true);
        }
      }
      if (j < grid[i].length - 1) {
        const upTile = grid[i][j + 1].chosen;
        if (upTile && !compareEdge(upTile.edges[2], tile.edges[0])) {
          addConflictMarker(cellCenterX(i), cellCenterZ(j) + cellSize / 2, false);
        }
      }
    }
  }
  refreshEmptyCellOutlines();
  showSceneEntropy();
  const conflictStatus = document.getElementById('conflictStatus');
  conflictStatus.textContent = conflictMarkers.length === 0 ? 'No conflicts' : 'Conflicts: ' + conflictMarkers.length;
  conflictStatus.classList.toggle('hasConflict', conflictMarkers.length > 0);
}

// Draws a grey square on every cell without a block, so that the empty cells can be seen and clicked
function refreshEmptyCellOutlines() {
  if (mapIsHexagonal) {
    refreshHexEmptyCellOutlines();
    return;
  }
  const linePoints = [];
  const halfCellSize = cellSize / 2;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (grid[i][j].chosen) {
        continue;
      }
      const left = cellCenterX(i) - halfCellSize;
      const right = cellCenterX(i) + halfCellSize;
      const near = cellCenterZ(j) - halfCellSize;
      const far = cellCenterZ(j) + halfCellSize;
      linePoints.push(
        left, 0, near, right, 0, near,
        right, 0, near, right, 0, far,
        right, 0, far, left, 0, far,
        left, 0, far, left, 0, near);
    }
  }
  emptyCellOutlines.geometry.dispose();
  emptyCellOutlines.geometry = new THREE.BufferGeometry();
  emptyCellOutlines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
  emptyCellOutlines.visible = linePoints.length > 0;
}

function describeOrientation(quarterTurnCount, isMirrored) {
  return 'rotated ' + quarterTurnCount * 90 + '°' + (isMirrored ? ', mirrored' : '');
}

function updateEditorStatus() {
  let brushText = 'Select: click a block';
  if (brushBlockIndex === eraseBrush) {
    brushText = 'Erase: click a block to remove it';
  } else if (brushBlockIndex !== null) {
    brushText = 'Place block ' + brushBlockIndex + ', ' + describeOrientation(brushQuarterTurnCount, brushIsMirrored);
  }
  let selectionText = '';
  if (selectedCell) {
    selectionText = 'Selected: ';
    if (selectedCell.chosen) {
      const tile = selectedCell.chosen;
      selectionText += 'block ' + tile.index + ', ' + describeOrientation(tile.ro, tile.mirrored) +
        ' (edge heights ' + tile.edges.map(edgeHeights).join(' ') + ')';
    } else {
      selectionText += 'an empty cell';
    }
  }
  document.getElementById('brushStatus').textContent = brushText;
  document.getElementById('selectionStatus').textContent = selectionText;
}

function selectCell(cell) {
  selectedCell = cell;
  const isHexCell = Boolean(cell) && cell.hexIndex !== undefined;
  hexSelectionLine.visible = isHexCell;
  if (isHexCell) {
    outlineQuad(hexSelectionLine, cell.hexIndex, 0.15);
  }
  selectionOutline.visible = cell !== null && !isHexCell;
  if (cell && !isHexCell) {
    selectionOutline.position.set(cellCenterX(cell.i), conflictMarkerHeight / 2, cellCenterZ(cell.j));
  }
  updateEditorStatus();
}

function resetEditorForNewScheme() {
  fitShadowToScheme();
  hoveredCell = null;
  hoverOutline.visible = false;
  selectCell(null);
  refreshConflictMarkers();
}

function setBrushBlock(blockIndex) {
  brushBlockIndex = blockIndex;
  document.querySelectorAll('#blockPalette button').forEach(function (button) {
    button.classList.toggle('active', button.dataset.blockIndex === String(blockIndex));
  });
  document.getElementById('selectTool').classList.toggle('active', blockIndex === null);
  document.getElementById('eraseTool').classList.toggle('active', blockIndex === eraseBrush);
  updateEditorStatus();
}

// Rotate and mirror act on the selected block; the brush follows, so the next block is placed the same way
function rotateSelection() {
  if (selectedCell && selectedCell.chosen) {
    brushQuarterTurnCount = (selectedCell.chosen.ro + 1) % 4;
    brushIsMirrored = selectedCell.chosen.mirrored;
    setCellTile(selectedCell, createOrientedTile(selectedCell.chosen.index, brushQuarterTurnCount, brushIsMirrored));
  } else {
    brushQuarterTurnCount = (brushQuarterTurnCount + 1) % 4;
    updateEditorStatus();
  }
}

function mirrorSelection() {
  if (selectedCell && selectedCell.chosen) {
    brushQuarterTurnCount = selectedCell.chosen.ro;
    brushIsMirrored = !selectedCell.chosen.mirrored;
    setCellTile(selectedCell, createOrientedTile(selectedCell.chosen.index, brushQuarterTurnCount, brushIsMirrored));
  } else {
    brushIsMirrored = !brushIsMirrored;
    updateEditorStatus();
  }
}

function removeSelection() {
  if (selectedCell && selectedCell.chosen) {
    setCellTile(selectedCell, null);
  }
}

function clearAllBlocks() {
  if (mapIsHexagonal) {
    clearAllHexBlocks();
    return;
  }
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      grid[i][j].chosen = null;
      grid[i][j].collapsed = false;
      placeBlockInScene(grid[i][j]);
    }
  }
  removeAllPinesFromScene(scene);
  refreshConflictMarkers();
  updateEditorStatus();
}

function setPointerPosition(event) {
  const canvasBounds = renderer.domElement.getBoundingClientRect();
  pointerPosition.x = ((event.clientX - canvasBounds.left) / canvasBounds.width) * 2 - 1;
  pointerPosition.y = -((event.clientY - canvasBounds.top) / canvasBounds.height) * 2 + 1;
}

// The block the pointer is on, or the empty cell of the ground it is on when that is nearer
function findCellUnderPointer() {
  if (mapIsHexagonal) {
    return findHexCellUnderPointer();
  }
  raycaster.setFromCamera(pointerPosition, camera);
  const placedObjects = [];
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (grid[i][j].sceneObject) {
        placedObjects.push(grid[i][j].sceneObject);
      }
    }
  }
  let foundCell = null;
  let foundDistance = Infinity;
  const blockHits = raycaster.intersectObjects(placedObjects, true);
  if (blockHits.length > 0) {
    let hitObject = blockHits[0].object;
    while (hitObject && !hitObject.userData.cell) {
      hitObject = hitObject.parent;
    }
    if (hitObject) {
      foundCell = hitObject.userData.cell;
      foundDistance = blockHits[0].distance;
    }
  }
  const groundPoint = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  if (groundPoint) {
    const column = Math.round((groundPoint.x + cols * cellSize / 2) / cellSize);
    const row = Math.round((groundPoint.z + rows * cellSize / 2) / cellSize);
    const isInsideGrid = column >= 0 && column < grid.length && row >= 0 && row < grid[column].length;
    if (isInsideGrid && !grid[column][row].chosen && groundPoint.distanceTo(raycaster.ray.origin) < foundDistance) {
      foundCell = grid[column][row];
    }
  }
  return foundCell;
}

function updateHoveredCell() {
  if (!hoverNeedsUpdate || playModeIsOn) {
    return;
  }
  hoverNeedsUpdate = false;
  if (mapIsHexagonal) {
    hoveredCell = findHexCellUnderPointer();
    hexHoverLine.visible = hoveredCell !== null;
    if (hoveredCell) {
      outlineQuad(hexHoverLine, hoveredCell.hexIndex, 0.1);
    }
    return;
  }
  hoveredCell = findCellUnderPointer();
  hoverOutline.visible = hoveredCell !== null;
  if (hoveredCell) {
    hoverOutline.position.set(cellCenterX(hoveredCell.i), 0.05, cellCenterZ(hoveredCell.j));
  }
}

renderer.domElement.addEventListener('pointerdown', function (event) {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
});

renderer.domElement.addEventListener('pointermove', function (event) {
  setPointerPosition(event);
  hoverNeedsUpdate = event.buttons === 0; // not while orbiting
});

renderer.domElement.addEventListener('pointerleave', function () {
  hoverNeedsUpdate = false;
  hoveredCell = null;
  hoverOutline.visible = false;
  hexHoverLine.visible = false;
});

renderer.domElement.addEventListener('pointerup', function (event) {
  const pointerMovement = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
  if (playModeIsOn || event.button !== 0 || pointerMovement > clickMovementTolerance) {
    return;
  }
  setPointerPosition(event);
  const clickedCell = findCellUnderPointer();
  if (clickedCell && brushBlockIndex === eraseBrush) {
    if (clickedCell.chosen) {
      setCellTile(clickedCell, null);
    }
  } else if (clickedCell && brushBlockIndex !== null) {
    setCellTile(clickedCell, createOrientedTile(brushBlockIndex, brushQuarterTurnCount, brushIsMirrored));
  }
  selectCell(clickedCell);
});

window.addEventListener('keydown', function (event) {
  const isTyping = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA';
  if (isTyping || event.ctrlKey || event.metaKey || event.altKey || playModeIsOn) {
    return;
  }
  if (event.key === 'e' || event.key === 'E') {
    setBrushBlock(brushBlockIndex === eraseBrush ? null : eraseBrush);
  } else if (event.key === 'r' || event.key === 'R') {
    rotateSelection();
  } else if (event.key === 'm' || event.key === 'M') {
    mirrorSelection();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    removeSelection();
  } else if (event.key === 'Escape') {
    setBrushBlock(null);
  }
});

// Rule switches: the next generation uses them, and the conflict warnings of the editor follow at once
document.querySelectorAll('.ruleCheckbox').forEach(function (ruleCheckbox) {
  ruleCheckbox.checked = ruleOptions[ruleCheckbox.dataset.ruleOption];
  ruleCheckbox.addEventListener('change', function () {
    ruleOptions[this.dataset.ruleOption] = this.checked;
    rebuildTileRules();
    refreshConflictMarkers();
  });
});

document.getElementById('rotateBlock').addEventListener('click', rotateSelection);
document.getElementById('mirrorBlock').addEventListener('click', mirrorSelection);
document.getElementById('selectTool').addEventListener('click', function () {
  setBrushBlock(null);
});
document.getElementById('eraseTool').addEventListener('click', function () {
  setBrushBlock(eraseBrush);
});
document.getElementById('clearAllBlocks').addEventListener('click', clearAllBlocks);

// Fills the palette with a picture of every block, slowly turning. One small renderer of its own
// draws the blocks one after another and each picture is copied into the canvas of its button.
const thumbnailPixelSize = 190; // drawn at twice the size they are shown, for sharpness
// Blocks that are another block with only its ridge caps, its gable style or its mirror image
// changed are shown once: the ridge caps and the gable style follow by themselves, and the mirror
// image is one press of Mirror away. Block 4 is the model of block 1.
const paletteVariantOf = { 4: 1, 8: 7, 11: 10, 12: 10, 13: 10, 19: 18, 21: 20, 31: 30 };
const thumbnailTurnSeconds = 20;
let thumbnailRenderer = null;
let thumbnailScene = null;
let thumbnailCamera = null;
const paletteThumbnails = []; // { block, drawingContext }
let thumbnailFrameCount = 0;

function buildBlockPalette() {
  thumbnailRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  thumbnailRenderer.setSize(thumbnailPixelSize, thumbnailPixelSize, false);
  thumbnailScene = new THREE.Scene();
  thumbnailScene.background = new THREE.Color(0xdde3ee);
  thumbnailScene.add(new THREE.HemisphereLight(0xffffff, 0x777766, 1.6));
  const thumbnailLight = new THREE.DirectionalLight(0xffffff, 1.5);
  thumbnailLight.position.set(-4, 8, 6);
  thumbnailScene.add(thumbnailLight);
  const viewHalfSize = 9.5; // wide enough for the two-storey pavilion
  thumbnailCamera = new THREE.OrthographicCamera(-viewHalfSize, viewHalfSize, viewHalfSize, -viewHalfSize, 0.1, 200);
  thumbnailCamera.position.set(30, 30, 30);
  thumbnailCamera.lookAt(0, 5, 0);

  const palette = document.getElementById('blockPalette');
  palette.innerHTML = '';
  for (let blockIndex = 0; blockIndex < buildingBlocks.length; blockIndex++) {
    if (!buildingBlocks[blockIndex] || paletteVariantOf[blockIndex] !== undefined) {
      continue;
    }
    const variantIndices = Object.keys(paletteVariantOf).filter(function (variantIndex) {
      return paletteVariantOf[variantIndex] === blockIndex;
    });
    const block = buildingBlocks[blockIndex].clone();
    block.visible = false;
    block.position.set(0, 0, 0);
    block.scale.set(1, 1, -1);
    thumbnailScene.add(block);

    const blockButton = document.createElement('button');
    blockButton.dataset.blockIndex = String(blockIndex);
    blockButton.title = 'Block ' + blockIndex + (variantIndices.length > 0 ? ' (also ' + variantIndices.join(', ') + ')' : '');
    const picture = document.createElement('canvas');
    picture.width = thumbnailPixelSize;
    picture.height = thumbnailPixelSize;
    const numberLabel = document.createElement('span');
    numberLabel.className = 'blockNumber';
    numberLabel.textContent = blockIndex;
    blockButton.append(picture, numberLabel);
    blockButton.addEventListener('click', function () {
      setBrushBlock(blockIndex);
    });
    palette.appendChild(blockButton);
    paletteThumbnails.push({ block: block, drawingContext: picture.getContext('2d') });
  }
  setBrushBlock(null);
}

function turnBlockThumbnails() {
  if (playModeIsOn || !thumbnailRenderer) {
    return; // the palette is hidden
  }
  thumbnailFrameCount++;
  if (thumbnailFrameCount % 2 === 1) {
    return; // every other frame is smooth enough for a slow turn
  }
  const angle = performance.now() / 1000 / thumbnailTurnSeconds * Math.PI * 2;
  paletteThumbnails.forEach(function (thumbnail) {
    thumbnail.block.visible = true;
    thumbnail.block.rotation.y = angle;
    thumbnailRenderer.render(thumbnailScene, thumbnailCamera);
    thumbnail.drawingContext.drawImage(thumbnailRenderer.domElement, 0, 0);
    thumbnail.block.visible = false;
  });
}

// ---------------------------------------------------------------------------
// Play mode, after Oskar Stalberg's Townscaper: the player raises and lowers the points between
// the cells, and the blocks follow. Every cell takes a block whose four corners have the levels of
// the four points around it; where that leaves a choice (which way a ridge runs, how deep a roof
// is) the edges of the neighbours decide, and a cell keeps the block it had if it still fits.
// ---------------------------------------------------------------------------
const lowestPointLevel = -1;
const highestPointLevel = 2;
const playSeed = 4242;
const playTreeShare = 0.1;
let pointLevels = [];        // (cols + 1) x (rows + 1) points; only the inner ones can be changed
let previousSolvedTiles = null;
const playTreeOfCell = new Map(); // "i,j" -> tree standing in that cell
let playMessageTimer = null;
let hoveredPoint = null;

const pointMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.45, 0.75, 32),
  new THREE.MeshBasicMaterial({ color: 0x00ccff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
pointMarker.rotation.x = -Math.PI / 2;
pointMarker.renderOrder = 12;
pointMarker.visible = false;
scene.add(pointMarker);

function pointIndex(column, row) {
  return column * (rows + 1) + row;
}

function pointX(column) {
  return column * cellSize - cols * cellSize / 2 - cellSize / 2;
}

function pointZ(row) {
  return row * cellSize - rows * cellSize / 2 - cellSize / 2;
}

// The Play and Block buttons, and the panels that belong to each mode
function showModeInInterface() {
  document.getElementById('playModeButton').classList.toggle('active', playModeIsOn);
  document.getElementById('blockModeButton').classList.toggle('active', !playModeIsOn);
  document.getElementById('editor').style.display = playModeIsOn ? 'none' : 'block';
  document.getElementById('flatField').style.display = playModeIsOn ? '' : 'none';
  if (playModeIsOn) {
    selectCell(null);
    hoverOutline.visible = false;
    hexHoverLine.visible = false;
  } else {
    renderer.domElement.style.cursor = '';
    pointMarker.visible = false;
  }
}

// An empty, flat field of the current size
function startPlayMode() {
  playModeIsOn = true;
  showModeInInterface();
  rebuildTileRules();
  pointLevels = new Array((cols + 1) * (rows + 1)).fill(0);
  previousSolvedTiles = null;
  removeAllPinesFromScene(scene);
  showPlayGrid(solvePlayGrid().grid);
  showPlayStatus('');
}

// Takes over the map as it stands: the points get the levels of the corners of the blocks
// around them, and nothing in the scene changes until the first click
function enterPlayModeKeepingMap() {
  playModeIsOn = true;
  showModeInInterface();
  rebuildTileRules();
  pointLevels = new Array((cols + 1) * (rows + 1)).fill(0);
  const pointIsSet = new Array(pointLevels.length).fill(false);
  previousSolvedTiles = [];
  for (let i = 0; i < cols; i++) {
    previousSolvedTiles.push([]);
    for (let j = 0; j < rows; j++) {
      const tile = grid[i] && grid[i][j] ? grid[i][j].chosen : null;
      previousSolvedTiles[i].push(tile ? matchingPlayTile(tile) : null);
      if (!tile) {
        continue; // an empty cell of the editor says nothing about its corners
      }
      const levels = tileCornerLevels(tile);
      const cornerPoints = [[i, j + 1], [i + 1, j + 1], [i + 1, j], [i, j]];
      cornerPoints.forEach(function (cornerPoint, corner) {
        const index = pointIndex(cornerPoint[0], cornerPoint[1]);
        if (!pointIsSet[index]) {
          pointLevels[index] = levels[corner];
          pointIsSet[index] = true;
        }
      });
    }
  }
  // the trees standing on the map stay, as the trees of their cells
  playTreeOfCell.clear();
  scene.children.filter(function (object) {
    return object.generated === true;
  }).forEach(function (treeGroup) {
    const column = Math.round((treeGroup.position.x + cols * cellSize / 2) / cellSize);
    const row = Math.round((treeGroup.position.z + rows * cellSize / 2) / cellSize);
    playTreeOfCell.set(column + ',' + row, { treeGroup: treeGroup });
  });
  showPlayStatus('');
}

// The block of the play set that the solver should keep for a block of the map: the same block
// turned the same way, with the ridge caps and the gable style taken off (they come back afterwards)
const playBaseBlockOf = { 8: 7, 11: 10, 12: 10, 13: 10, 19: 18 };
function matchingPlayTile(tile) {
  const baseIndex = playBaseBlockOf[tile.index] !== undefined ? playBaseBlockOf[tile.index] : tile.index;
  const wantedEdges = createOrientedTile(baseIndex, tile.ro, tile.mirrored).edges.join();
  return activeTiles.find(function (candidate) {
    return candidate.index === baseIndex && candidate.edges.join() === wantedEdges;
  }) || null;
}

// Leaves the map as it is; it can be edited further with the block editor
function leavePlayMode() {
  playModeIsOn = false;
  showModeInInterface();
  rebuildTileRules();
  pointMarker.visible = false;
  hoveredPoint = null;
  playTreeOfCell.clear(); // the trees stay in the scene as ordinary trees
  document.getElementById('playStatus').textContent = 'Pick a block, click to place.';
  refreshConflictMarkers();
}

function showPlayStatus(message) {
  const help = 'Click to raise, right click to lower.';
  document.getElementById('playStatus').textContent = message || help;
  clearTimeout(playMessageTimer);
  if (message) {
    playMessageTimer = setTimeout(function () {
      showPlayStatus('');
    }, 3000);
  }
}

// The blocks for the current points, as a grid of cells, or the reason why there are none
function solvePlayGrid() {
  const result = solveCornerGrid(cols, rows, function (column, row) {
    return pointLevels[pointIndex(column, row)];
  }, previousSolvedTiles, playSeed);
  if (!result.grid) {
    return result;
  }
  const newGrid = [];
  for (let i = 0; i < cols; i++) {
    newGrid.push([]);
    for (let j = 0; j < rows; j++) {
      const cell = new Cell(i, j, []);
      cell.chosen = result.grid[i][j];
      cell.collapsed = true;
      newGrid[i].push(cell);
    }
  }
  return { grid: newGrid };
}

function showPlayGrid(newGrid) {
  previousSolvedTiles = newGrid.map(function (column) {
    return column.map(function (cell) {
      return cell.chosen;
    });
  });
  // the blocks are rebuilt, the trees stay where they still have ground to stand on
  scene.children.filter(function (object) {
    return object.generatedBlock === true;
  }).forEach(function (object) {
    scene.remove(object);
    disposeOwnGround(object);
  });
  markSceneChanged();
  const openGroundBefore = new Set();
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (grid[i][j].chosen && grid[i][j].chosen.index === 0) {
        openGroundBefore.add(i + ',' + j);
      }
    }
  }
  grid = newGrid;
  unsolved = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      placeBlockInScene(grid[i][j]);
    }
  }
  applyRidgeElements();
  applyGableEndStyle(gableEndBlockIndices[0]);
  applyTerrainRelief();
  smoothRoofsAcrossBlocks();
  if (showTrees) {
    plantPlayTrees(openGroundBefore);
  }
  resetEditorForNewScheme();
}

// Trees in play mode depend only on their cell, so they do not jump about with every click: a tree
// stays while its cell stays open ground, and only a cell that has just become open ground (all
// cells, when openGroundBefore is not given) may get a new one
function plantPlayTrees(openGroundBefore) {
  markSceneChanged();
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const key = i + ',' + j;
      const isOpenGround = Boolean(grid[i][j].chosen) && grid[i][j].chosen.index === 0;
      const cellRandom = new SeededRandom(1000003 * (i + 1) + 7919 * (j + 1));
      const isNewGround = !openGroundBefore || !openGroundBefore.has(key);
      const wantsTree = isOpenGround && (playTreeOfCell.has(key) || (isNewGround && cellRandom.nextFloat() < playTreeShare));
      const tree = playTreeOfCell.get(key);
      if (tree && !wantsTree) {
        scene.remove(tree.treeGroup);
        playTreeOfCell.delete(key);
      } else if (wantsTree && !tree) {
        const pine = new PineTree(cellRandom.nextInt(25), cellCenterX(i), cellCenterZ(j));
        pine.addToScene(scene);
        playTreeOfCell.set(key, pine);
      }
      const standingTree = playTreeOfCell.get(key);
      if (standingTree) {
        standingTree.treeGroup.position.y = reliefHeightAt(grid[i][j], cellCenterX(i), cellCenterZ(j));
      }
    }
  }
}

function changePointLevel(point, levelStep) {
  const index = pointIndex(point.column, point.row);
  const oldLevel = pointLevels[index];
  const newLevel = Math.min(highestPointLevel, Math.max(lowestPointLevel, oldLevel + levelStep));
  if (newLevel === oldLevel) {
    return;
  }
  pointLevels[index] = newLevel;
  const result = solvePlayGrid();
  if (!result.grid) {
    pointLevels[index] = oldLevel;
    showPlayStatus('Not possible: ' + result.failure + '.');
    return;
  }
  showPlayGrid(result.grid);
  showPlayStatus('');
}

// The inner point nearest to where the pointer meets the blocks or the ground
function findPointUnderPointer() {
  raycaster.setFromCamera(pointerPosition, camera);
  const placedObjects = [];
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (grid[i][j].sceneObject) {
        placedObjects.push(grid[i][j].sceneObject);
      }
    }
  }
  const hits = raycaster.intersectObjects(placedObjects, true);
  const hitPoint = hits.length > 0 ? hits[0].point : raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  if (!hitPoint) {
    return null;
  }
  const column = Math.round((hitPoint.x + cols * cellSize / 2 + cellSize / 2) / cellSize);
  const row = Math.round((hitPoint.z + rows * cellSize / 2 + cellSize / 2) / cellSize);
  if (column < 1 || column > cols - 1 || row < 1 || row > rows - 1) {
    return null; // the outer points stay ground, so that the field keeps an open edge
  }
  return { column: column, row: row };
}

function updateHoveredPoint() {
  if (!playModeIsOn || !hoverNeedsUpdate) {
    return;
  }
  hoverNeedsUpdate = false;
  if (mapIsHexagonal) {
    updateHexHoveredPoint();
    return;
  }
  hoveredPoint = findPointUnderPointer();
  pointMarker.visible = hoveredPoint !== null;
  if (hoveredPoint) {
    pointMarker.position.set(pointX(hoveredPoint.column), 0.1, pointZ(hoveredPoint.row));
    const level = pointLevels[pointIndex(hoveredPoint.column, hoveredPoint.row)];
    pointMarker.material.color.set([0x3366ff, 0x00ccff, 0xffaa00, 0xff3300][level - lowestPointLevel]);
    renderer.domElement.style.cursor = playCursor(canChangePointLevel(hoveredPoint, 1), canChangePointLevel(hoveredPoint, -1));
  } else {
    renderer.domElement.style.cursor = '';
  }
}

// Whether a click would be taken: the change is tried on the side, the map stays as it is.
// Remembered for the current points, since the pointer rests on the same point for many frames.
const pointChangeIsPossible = new Map();
function canChangePointLevel(point, levelStep) {
  const index = pointIndex(point.column, point.row);
  const oldLevel = pointLevels[index];
  const newLevel = oldLevel + levelStep;
  if (newLevel < lowestPointLevel || newLevel > highestPointLevel) {
    return false;
  }
  const key = index + ':' + levelStep + ':' + pointLevels.join('');
  if (!pointChangeIsPossible.has(key)) {
    if (pointChangeIsPossible.size > 500) {
      pointChangeIsPossible.clear();
    }
    pointLevels[index] = newLevel;
    const result = solveCornerGrid(cols, rows, function (column, row) {
      return pointLevels[pointIndex(column, row)];
    }, null, playSeed);
    pointLevels[index] = oldLevel;
    pointChangeIsPossible.set(key, Boolean(result.grid));
  }
  return pointChangeIsPossible.get(key);
}

// Cursors drawn as small pictures: a pointer at the top left, where the click lands, and beside it a
// small mouse whose left button lights green when a left click raises the point, and whose right
// button lights orange when a right click lowers it. A button that would do nothing stays grey.
const raiseColour = '#2a9d4b';
const lowerColour = '#d9822b';
const idleButtonColour = '#d6d6d6';
function cursorPicture(svgContent) {
  return 'url("data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' + svgContent + '</svg>') + '") 1 1, pointer';
}
function mouseCursor(canRaise, canLower) {
  const pointer = '<path d="M1 1 L1 13 L4.5 9.5 L7 15 L9 14 L6.5 8.5 L11 8.5 Z" fill="black" stroke="white" stroke-width="1.2"/>';
  const leftButton = '<path d="M20 12 L20 19 L13 19 L13 17 Q13 12 20 12 Z" fill="' + (canRaise ? raiseColour : idleButtonColour) + '"/>';
  const rightButton = '<path d="M20 12 L20 19 L27 19 L27 17 Q27 12 20 12 Z" fill="' + (canLower ? lowerColour : idleButtonColour) + '"/>';
  const body = '<path d="M13 17 Q13 12 20 12 Q27 12 27 17 L27 24 Q27 31 20 31 Q13 31 13 24 Z" fill="white" stroke="#333" stroke-width="1.3"/>';
  const buttonLines = '<path d="M20 12 L20 19 M13 19 L27 19" stroke="#333" stroke-width="1.1"/>';
  const outline = '<path d="M13 17 Q13 12 20 12 Q27 12 27 17 L27 24 Q27 31 20 31 Q13 31 13 24 Z" fill="none" stroke="#333" stroke-width="1.3"/>';
  let cross = '';
  if (!canRaise && !canLower) {
    cross = '<path d="M14 13 L26 30 M26 13 L14 30" stroke="white" stroke-width="3.5"/><path d="M14 13 L26 30 M26 13 L14 30" stroke="#c62828" stroke-width="2"/>';
  }
  return cursorPicture(pointer + body + leftButton + rightButton + buttonLines + outline + cross);
}
const playCursors = {
  raiseAndLower: mouseCursor(true, true),
  raiseOnly: mouseCursor(true, false),
  lowerOnly: mouseCursor(false, true),
  neither: mouseCursor(false, false),
};
function playCursor(canRaise, canLower) {
  if (canRaise && canLower) {
    return playCursors.raiseAndLower;
  }
  if (canRaise) {
    return playCursors.raiseOnly;
  }
  if (canLower) {
    return playCursors.lowerOnly;
  }
  return playCursors.neither;
}

renderer.domElement.addEventListener('pointerup', function (event) {
  const pointerMovement = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
  if (!playModeIsOn || pointerMovement > clickMovementTolerance || (event.button !== 0 && event.button !== 2)) {
    return; // a drag turns or pans the view
  }
  setPointerPosition(event);
  if (mapIsHexagonal) {
    const hexPoint = findHexPointUnderPointer();
    if (hexPoint !== null) {
      changeHexPointLevel(hexPoint, event.button === 0 ? 1 : -1);
      hoverNeedsUpdate = true;
    }
    return;
  }
  const point = findPointUnderPointer();
  if (point) {
    changePointLevel(point, event.button === 0 ? 1 : -1);
    hoverNeedsUpdate = true;
  }
});

document.getElementById('playModeButton').addEventListener('click', function () {
  if (!playModeIsOn && mapIsHexagonal) {
    enterHexPlayModeKeepingMap();
  } else if (!playModeIsOn) {
    enterPlayModeKeepingMap();
  }
});
document.getElementById('blockModeButton').addEventListener('click', function () {
  if (playModeIsOn) {
    leavePlayMode();
  }
});
document.getElementById('flatField').addEventListener('click', function () {
  if (mapIsHexagonal) {
    flattenHexMap();
    return;
  }
  clearScene();
  startPlayMode();
  document.getElementById('schemeInfo').textContent = 'A flat field';
});

// ---------------------------------------------------------------------------
// The hexagonal map: Oskar Stalberg's irregular grid of quads in a hexagon (quadMap.js), played the
// same way as the square map. Every quad takes a block whose four corners have the levels of the
// four points around it, chosen so that neighbouring blocks fit; the square block models are then
// bent into the quads (bilinearly), so their borders meet wherever two quads share an edge.
// Generation, play mode, block mode and the terrain relief all work on it as on the square map.
// ---------------------------------------------------------------------------
let hexRingCount = 3;              // about 120 quads; the film sets more rings for a larger map
let hexMapSeed = 1;
let hexPointLevels = [];
let hexCells = [];                 // per quad: { chosen (the block shown), solvedTile, sceneObject, builtKey }
let hexHoveredPoint = null;
const hexTreeOfCell = new Map();   // quad index -> tree standing in it
const hexCompatibility = new Map(); // "label|label" -> whether two edges may face each other

function canFace(ownLabel, otherLabel) {
  const key = ownLabel + '|' + otherLabel;
  if (!hexCompatibility.has(key)) {
    hexCompatibility.set(key, compareEdge(otherLabel, ownLabel));
  }
  return hexCompatibility.get(key);
}

// Blocks for the quads that fit the levels of their corners and each other; like solveCornerGrid,
// with the quads' own neighbours in place of rows and columns. Returns { tiles } or { failure }.
function solveHexMap(levelOfPoint, previousTiles) {
  const cells = hexMap.cells;
  const cornerOptions = [];
  for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
    const wanted = cells[cellIndex].corners.map(levelOfPoint);
    const options = activeTiles.filter(function (tile) {
      const levels = tileCornerLevels(tile);
      return levels[0] === wanted[0] && levels[1] === wanted[1] && levels[2] === wanted[2] && levels[3] === wanted[3];
    });
    if (options.length === 0) {
      return { failure: describeMissingCorners(wanted) };
    }
    cornerOptions.push(options);
  }
  function propagate(options, startCells) {
    const pending = startCells.slice();
    while (pending.length > 0) {
      const cellIndex = pending.pop();
      cells[cellIndex].neighbours.forEach(function (neighbour, edge) {
        if (!neighbour) {
          return;
        }
        const labelsHere = new Set(options[cellIndex].map(function (tile) {
          return tile.edges[edge];
        }));
        const before = options[neighbour.cell];
        const after = before.filter(function (tile) {
          const label = tile.edges[neighbour.edge];
          for (const labelHere of labelsHere) {
            if (canFace(labelHere, label)) {
              return true;
            }
          }
          return false;
        });
        if (after.length === 0) {
          throw new Error('dead end');
        }
        if (after.length < before.length) {
          options[neighbour.cell] = after;
          pending.push(neighbour.cell);
        }
      });
    }
  }
  const startOptions = cornerOptions.map(function (options) {
    return options.slice();
  });
  try {
    propagate(startOptions, cells.map(function (cell, index) {
      return index;
    }));
  } catch (error) {
    return { failure: "no roof fits that shape" };
  }
  for (let attempt = 0; attempt < cornerSolveAttemptCount; attempt++) {
    const options = startOptions.map(function (cellOptions) {
      return cellOptions.slice();
    });
    const random = new SeededRandom(playSeed + attempt);
    try {
      for (;;) {
        let nextCell = -1;
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
          if (options[cellIndex].length > 1 && (nextCell < 0 || options[cellIndex].length < options[nextCell].length)) {
            nextCell = cellIndex;
          }
        }
        if (nextCell < 0) {
          break;
        }
        const previousTile = previousTiles && attempt === 0 ? previousTiles[nextCell] : null;
        const choice = options[nextCell].includes(previousTile) ? previousTile : options[nextCell][random.nextInt(options[nextCell].length)];
        options[nextCell] = [choice];
        propagate(options, [nextCell]);
      }
      return {
        tiles: options.map(function (cellOptions) {
          return cellOptions[0];
        })
      };
    } catch (error) {
      // a dead end: try again with other choices
    }
  }
  return { failure: "the blocks don't fit" };
}

// The block a quad shows: the solved one, with the ridge caps its neighbours call for
function hexBlockWithRidges(cellIndex, tiles) {
  const tile = tiles[cellIndex];
  const family = verandaBlockFamilies.find(function (blockIndices) {
    return blockIndices.includes(tile.index);
  });
  if (!family) {
    return tile;
  }
  const wantedEdges = tile.edges.map(function (label, edge) {
    if (!isVerandaTop(label)) {
      return label;
    }
    const neighbour = hexMap.cells[cellIndex].neighbours[edge];
    const facesVerandaTop = Boolean(neighbour) && Boolean(tiles[neighbour.cell]) && isVerandaTop(tiles[neighbour.cell].edges[neighbour.edge]);
    return facesVerandaTop ? 'PPP' : 'UUU';
  });
  for (const blockIndex of family) {
    const candidate = createOrientedTile(blockIndex, tile.ro, tile.mirrored);
    if (candidate.edges.join() === wantedEdges.join()) {
      return candidate;
    }
  }
  return tile;
}

function reverseTriangleWinding(geometry) {
  if (geometry.index) {
    const index = geometry.index;
    for (let corner = 0; corner < index.count; corner += 3) {
      const second = index.getX(corner + 1);
      index.setX(corner + 1, index.getX(corner + 2));
      index.setX(corner + 2, second);
    }
    index.needsUpdate = true;
    return;
  }
  Object.values(geometry.attributes).forEach(function (attribute) {
    for (let corner = 0; corner < attribute.count; corner += 3) {
      for (let component = 0; component < attribute.itemSize; component++) {
        const second = attribute.getComponent(corner + 1, component);
        attribute.setComponent(corner + 1, component, attribute.getComponent(corner + 2, component));
        attribute.setComponent(corner + 2, component, second);
      }
    }
    attribute.needsUpdate = true;
  });
}

// Bends geometry made for a square block (x and z from -3 to 3) into a quad: the square's corners
// top left (-3, +3), top right, bottom right, bottom left go to the quad's corners 0 to 3. The
// heights stay; the normals follow the bending.
function bendIntoQuad(geometry, corners) {
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const slopeDirections = geometry.attributes.roofTileSlope;
  const halfCell = cellSize / 2;
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  for (let index = 0; index < positions.count; index++) {
    const across = (positions.getX(index) + halfCell) / cellSize; // 0 at the left, 1 at the right
    const up = (positions.getZ(index) + halfCell) / cellSize;     // 0 at the bottom, 1 at the top
    const x = bottomLeft.x * (1 - across) * (1 - up) + bottomRight.x * across * (1 - up) + topRight.x * across * up + topLeft.x * (1 - across) * up;
    const z = bottomLeft.z * (1 - across) * (1 - up) + bottomRight.z * across * (1 - up) + topRight.z * across * up + topLeft.z * (1 - across) * up;
    positions.setXYZ(index, x, positions.getY(index), z);
    if (normals) {
      // how the bending stretches the plan here: its derivatives along x and along z of the square
      const alongAcrossX = ((bottomRight.x - bottomLeft.x) * (1 - up) + (topRight.x - topLeft.x) * up) / cellSize;
      const alongAcrossZ = ((bottomRight.z - bottomLeft.z) * (1 - up) + (topRight.z - topLeft.z) * up) / cellSize;
      const alongUpX = ((topLeft.x - bottomLeft.x) * (1 - across) + (topRight.x - bottomRight.x) * across) / cellSize;
      const alongUpZ = ((topLeft.z - bottomLeft.z) * (1 - across) + (topRight.z - bottomRight.z) * across) / cellSize;
      const determinant = alongAcrossX * alongUpZ - alongUpX * alongAcrossZ;
      const normalX = normals.getX(index);
      const normalZ = normals.getZ(index);
      // normals go with the inverse transpose of the stretching
      const bentNormalX = (alongUpZ * normalX - alongAcrossZ * normalZ) / determinant;
      const bentNormalZ = (-alongUpX * normalX + alongAcrossX * normalZ) / determinant;
      const length = Math.hypot(bentNormalX, normals.getY(index), bentNormalZ) || 1;
      normals.setXYZ(index, bentNormalX / length, normals.getY(index) / length, bentNormalZ / length);
    }
    if (slopeDirections) {
      // a direction in the plan goes with the stretching itself
      const stretchAcrossX = ((bottomRight.x - bottomLeft.x) * (1 - up) + (topRight.x - topLeft.x) * up) / cellSize;
      const stretchAcrossZ = ((bottomRight.z - bottomLeft.z) * (1 - up) + (topRight.z - topLeft.z) * up) / cellSize;
      const stretchUpX = ((topLeft.x - bottomLeft.x) * (1 - across) + (topRight.x - bottomRight.x) * across) / cellSize;
      const stretchUpZ = ((topLeft.z - bottomLeft.z) * (1 - across) + (topRight.z - bottomRight.z) * across) / cellSize;
      const directionX = slopeDirections.getX(index);
      const directionZ = slopeDirections.getZ(index);
      slopeDirections.setXYZ(index, stretchAcrossX * directionX + stretchUpX * directionZ, 0, stretchAcrossZ * directionX + stretchUpZ * directionZ);
    }
  }
  positions.needsUpdate = true;
  if (normals) {
    normals.needsUpdate = true;
  }
  if (slopeDirections) {
    slopeDirections.needsUpdate = true;
  }
  geometry.computeBoundingSphere();
}

const hexPlacement = new THREE.Object3D();
function buildHexCellObject(cellIndex, tile) {
  const corners = hexMap.cells[cellIndex].corners.map(function (pointIndex) {
    return hexMap.points[pointIndex];
  });
  const block = buildingBlocks[tile.index].clone();
  block.visible = true;
  block.position.set(0, 0, 0);
  block.rotation.set(0, tile.ro * Math.PI / 2, 0);
  block.scale.set(tile.mirrored ? -1 : 1, 1, -1); // z flipped to adapt from blender, as on the square map
  block.updateMatrixWorld(true);
  const group = new THREE.Group();
  group.generatedBlock = true;
  group.userData.hexCell = cellIndex;
  block.traverse(function (child) {
    if (!child.isMesh) {
      return;
    }
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    if (geometry.attributes.roofTileSlope) {
      // applyMatrix4 turns positions and normals only; the tile direction is turned here
      geometry.attributes.roofTileSlope.applyMatrix3(new THREE.Matrix3().setFromMatrix4(child.matrixWorld));
    }
    if (child.matrixWorld.determinant() < 0) {
      reverseTriangleWinding(geometry); // a mirroring bake turns the faces inside out
    }
    bendIntoQuad(geometry, corners);
    let shapedGeometry = geometry;
    if (child.material.name && child.material.name.startsWith('ground') && geometry.attributes.color) {
      shapeHexGround(geometry, cellIndex);
      if (geometry.index) {
        geometry.computeVertexNormals(); // the fine ground of the open and water blocks: smooth all over
      } else {
        // the split ground of a building block: smooth over the ground, sharp at the plinth's edge
        shapedGeometry = toCreasedNormals(geometry, groundCreaseAngle);
        geometry.dispose();
      }
    }
    const mesh = new THREE.Mesh(shapedGeometry, child.material);
    mesh.castShadow = child.castShadow;
    mesh.receiveShadow = child.receiveShadow;
    group.add(mesh);
  });
  return group;
}

function disposeHexCellObject(cell) {
  if (!cell.sceneObject) {
    return;
  }
  scene.remove(cell.sceneObject);
  cell.sceneObject.traverse(function (child) {
    if (child.isMesh) {
      child.geometry.dispose();
    }
  });
  cell.sceneObject = null;
  cell.builtKey = null;
}

// The quads that share a corner with a quad, the quad itself among them; found once per map
let hexCellsAround = [];
function findHexCellsAround() {
  const cellsOfPoint = hexMap.points.map(function () {
    return [];
  });
  hexMap.cells.forEach(function (cell, cellIndex) {
    cell.corners.forEach(function (pointIndex) {
      cellsOfPoint[pointIndex].push(cellIndex);
    });
  });
  hexCellsAround = hexMap.cells.map(function (cell) {
    const around = new Set();
    cell.corners.forEach(function (pointIndex) {
      cellsOfPoint[pointIndex].forEach(function (otherCell) {
        around.add(otherCell);
      });
    });
    return Array.from(around).sort(function (first, second) {
      return first - second;
    });
  });
}

function hexQuadCorners(cellIndex) {
  return hexMap.cells[cellIndex].corners.map(function (pointIndex) {
    return hexMap.points[pointIndex];
  });
}

function isPointInQuad(x, z, corners) {
  let inside = false;
  for (let index = 0, previous = corners.length - 1; index < corners.length; previous = index++) {
    const point = corners[index];
    const before = corners[previous];
    if ((point.z > z) !== (before.z > z) && x < (before.x - point.x) * (z - point.z) / (before.z - point.z) + point.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToQuad(x, z, corners) {
  if (isPointInQuad(x, z, corners)) {
    return 0;
  }
  let nearest = Infinity;
  corners.forEach(function (point, index) {
    const next = corners[(index + 1) % corners.length];
    const alongX = next.x - point.x;
    const alongZ = next.z - point.z;
    const lengthSquared = alongX * alongX + alongZ * alongZ;
    const share = lengthSquared > 0 ? Math.min(1, Math.max(0, ((x - point.x) * alongX + (z - point.z) * alongZ) / lengthSquared)) : 0;
    nearest = Math.min(nearest, Math.hypot(x - point.x - alongX * share, z - point.z - alongZ * share));
  });
  return nearest;
}

function isHexTerrainCell(cellIndex) {
  const tile = hexCells[cellIndex].baseTile;
  return Boolean(tile) && terrainBlockIndices.includes(tile.index);
}

// The relief at a point of the hexagonal map, faded out towards the building quads around
function hexReliefAt(x, z, buildingQuads) {
  let nearestDistance = Infinity;
  buildingQuads.forEach(function (corners) {
    nearestDistance = Math.min(nearestDistance, distanceToQuad(x, z, corners));
  });
  return terrainRelief(x, z) * THREE.MathUtils.smoothstep(nearestDistance, 0, reliefFadeDistance);
}

function hexBuildingQuadsAround(cellIndex) {
  return hexCellsAround[cellIndex].filter(function (otherCell) {
    return !isHexTerrainCell(otherCell);
  }).map(hexQuadCorners);
}

// Gives the ground of a built quad the relief and the lush colouring, like applyTerrainRelief on
// the square map. heightLimit: in a building block only the ground level moves.
function shapeHexGround(geometry, cellIndex) {
  const buildingQuads = hexBuildingQuadsAround(cellIndex);
  const isTerrain = isHexTerrainCell(cellIndex);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const flatHeight = positions.getY(index);
    if (flatHeight > plinthTopHeight || flatHeight <= undersideHeightLimit) {
      continue;
    }
    let relief = 0;
    let height = flatHeight;
    if (isTerrain) {
      relief = hexReliefAt(x, z, buildingQuads);
      height = flatHeight + groundReliefAt(flatHeight, relief);
    } else if (Math.abs(flatHeight) < groundLevelTolerance) {
      relief = hexReliefAt(x, z, buildingQuads);
      height = flatHeight + groundReliefAt(0, relief);
    }
    positions.setY(index, height);
    paintGroundPoint(geometry, index, x, z, isTerrain ? flatHeight : Math.max(flatHeight, 0), relief, height);
  }
  positions.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
  geometry.attributes.wetness.needsUpdate = true;
}

// Builds or rebuilds what has changed: each quad shows its block with the ridge caps its neighbours
// call for, and its ground follows the relief, which depends on which quads around are buildings
function rebuildHexCells() {
  const baseTiles = hexCells.map(function (cell) {
    return cell.baseTile;
  });
  hexCells.forEach(function (cell, cellIndex) {
    if (!cell.baseTile) {
      cell.chosen = null;
      disposeHexCellObject(cell);
      return;
    }
    const shown = hexBlockWithRidges(cellIndex, baseTiles);
    const surroundings = hexCellsAround[cellIndex].map(function (otherCell) {
      return isHexTerrainCell(otherCell) ? 't' : 'b';
    }).join('');
    const key = shown.index + '/' + shown.ro + (shown.mirrored ? 'm' : '') + ':' + surroundings;
    cell.chosen = shown;
    if (cell.builtKey === key) {
      return; // unchanged: keep what is built
    }
    disposeHexCellObject(cell);
    cell.sceneObject = buildHexCellObject(cellIndex, shown);
    cell.builtKey = key;
    scene.add(cell.sceneObject);
  });
  if (showTrees) {
    plantHexTrees();
  }
  markSceneChanged();
  if (playModeIsOn) {
    showSceneEntropy();
  } else {
    refreshConflictMarkers();
  }
}

function showHexSolution(tiles) {
  hexCells.forEach(function (cell, cellIndex) {
    cell.solvedTile = tiles[cellIndex];
    cell.baseTile = tiles[cellIndex];
  });
  rebuildHexCells();
}

function hexCellCentre(cellIndex) {
  let x = 0;
  let z = 0;
  hexMap.cells[cellIndex].corners.forEach(function (pointIndex) {
    x += hexMap.points[pointIndex].x;
    z += hexMap.points[pointIndex].z;
  });
  return { x: x / 4, z: z / 4 };
}

// A tree stays while its quad stays open ground; a quad that becomes open ground may get one
function plantHexTrees() {
  hexCells.forEach(function (cell, cellIndex) {
    const isOpenGround = Boolean(cell.chosen) && cell.chosen.index === 0;
    const tree = hexTreeOfCell.get(cellIndex);
    if (tree && !isOpenGround) {
      scene.remove(tree.treeGroup);
      hexTreeOfCell.delete(cellIndex);
      return;
    }
    if (!tree && isOpenGround) {
      const cellRandom = new SeededRandom(1000003 * (cellIndex + 1) + 7919 * hexMapSeed);
      if (cellRandom.nextFloat() < playTreeShare) {
        const centre = hexCellCentre(cellIndex);
        const pine = new PineTree(cellRandom.nextInt(25), centre.x, centre.z);
        pine.addToScene(scene);
        hexTreeOfCell.set(cellIndex, pine);
      }
    }
    const standingTree = hexTreeOfCell.get(cellIndex);
    if (standingTree) {
      const centre = hexCellCentre(cellIndex);
      standingTree.treeGroup.position.y = groundReliefAt(0, hexReliefAt(centre.x, centre.z, hexBuildingQuadsAround(cellIndex)));
    }
  });
  markSceneChanged();
}

// A random scheme on the hexagonal map, by the same rules as the square map: the edges of
// neighbouring blocks must fit, the rim stays open ground (with open edge on), and there is at most
// one bridge. Returns the blocks, or null when no attempt worked out.
const hexGenerationAttemptCount = 300;
function generateHexScheme(seed) {
  const cells = hexMap.cells;
  function propagate(options, startCells) {
    const pending = startCells.slice();
    while (pending.length > 0) {
      const cellIndex = pending.pop();
      cells[cellIndex].neighbours.forEach(function (neighbour, edge) {
        if (!neighbour) {
          return;
        }
        const labelsHere = new Set(options[cellIndex].map(function (tile) {
          return tile.edges[edge];
        }));
        const before = options[neighbour.cell];
        const after = before.filter(function (tile) {
          const label = tile.edges[neighbour.edge];
          for (const labelHere of labelsHere) {
            if (canFace(labelHere, label)) {
              return true;
            }
          }
          return false;
        });
        if (after.length === 0) {
          throw new Error('dead end');
        }
        if (after.length < before.length) {
          options[neighbour.cell] = after;
          pending.push(neighbour.cell);
        }
      });
    }
  }
  const everyCell = cells.map(function (cell, index) {
    return index;
  });
  for (let attempt = 0; attempt < hexGenerationAttemptCount; attempt++) {
    const random = new SeededRandom(seed * 7919 + attempt);
    const options = cells.map(function (cell) {
      const isOnRim = cell.neighbours.some(function (neighbour) {
        return neighbour === null;
      });
      return openEdge && isOnRim ? [tiles[0]] : activeTiles.slice();
    });
    let bridgeIsPlaced = false;
    try {
      propagate(options, everyCell);
      for (;;) {
        let nextCell = -1;
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
          if (options[cellIndex].length > 1 && (nextCell < 0 || options[cellIndex].length < options[nextCell].length)) {
            nextCell = cellIndex;
          }
        }
        if (nextCell < 0) {
          break;
        }
        const choice = options[nextCell][random.nextInt(options[nextCell].length)];
        options[nextCell] = [choice];
        const changedCells = [nextCell];
        if (!bridgeIsPlaced && bridgeBlockIndices.includes(choice.index)) {
          bridgeIsPlaced = true;
          // the other half of the bridge lies across the bridge edge; no other quad gets one
          const bridgeEdge = choice.edges.indexOf('NBN');
          const otherHalf = bridgeEdge >= 0 && cells[nextCell].neighbours[bridgeEdge] ? cells[nextCell].neighbours[bridgeEdge].cell : -1;
          options.forEach(function (cellOptions, cellIndex) {
            if (cellIndex === nextCell || cellIndex === otherHalf || cellOptions.length === 1) {
              return;
            }
            const withoutBridges = cellOptions.filter(function (tile) {
              return !bridgeBlockIndices.includes(tile.index);
            });
            if (withoutBridges.length === 0) {
              throw new Error('dead end');
            }
            if (withoutBridges.length < cellOptions.length) {
              options[cellIndex] = withoutBridges;
              changedCells.push(cellIndex);
            }
          });
        }
        propagate(options, changedCells);
      }
      return options.map(function (cellOptions) {
        return cellOptions[0];
      });
    } catch (error) {
      // a dead end: try again
    }
  }
  return null;
}

// Play mode takes over the blocks standing on the hexagonal map, like enterPlayModeKeepingMap
function enterHexPlayModeKeepingMap() {
  playModeIsOn = true;
  showModeInInterface();
  rebuildTileRules();
  hexPointLevels = new Array(hexMap.points.length).fill(0);
  const pointIsSet = new Array(hexMap.points.length).fill(false);
  hexCells.forEach(function (cell, cellIndex) {
    cell.solvedTile = cell.baseTile ? matchingPlayTile(cell.baseTile) : null;
    if (!cell.baseTile) {
      return;
    }
    const levels = tileCornerLevels(cell.baseTile);
    hexMap.cells[cellIndex].corners.forEach(function (pointIndex, corner) {
      if (!pointIsSet[pointIndex]) {
        hexPointLevels[pointIndex] = levels[corner];
        pointIsSet[pointIndex] = true;
      }
    });
  });
  showSceneEntropy();
  showPlayStatus('');
}

function startHexMap(seed) {
  const startsInPlayMode = playModeIsOn;
  clearScene(); // the square map's blocks and all trees
  hexCells.forEach(disposeHexCellObject);
  hexTreeOfCell.clear();
  grid = []; // the square map's systems (relief, roof joins) find nothing to do
  unsolved = [];
  mapIsHexagonal = true;
  hexMapSeed = seed;
  if (quadMapKind === 'bent') {
    const newRows = Math.round(Number(document.getElementById('rows').value));
    const newCols = Math.round(Number(document.getElementById('cols').value));
    if (newRows >= 2 && newCols >= 2 && newRows <= 12 && newCols <= 12) {
      rows = newRows;
      cols = newCols;
    }
    hexMap = generateBentGridQuadMap(cols, rows, cellSize, bentGridShift.amplitudeMetres, bentGridShift.wavelengthMetres, seed);
  } else {
    hexMap = generateHexQuadMap(hexRingCount, cellSize, seed);
  }
  document.getElementById('seedInput').value = seed;
  findHexCellsAround();
  hexPointLevels = new Array(hexMap.points.length).fill(0);
  hexCells = hexMap.cells.map(function (cell, cellIndex) {
    return { hexIndex: cellIndex, chosen: null, baseTile: null, solvedTile: null, sceneObject: null, builtKey: null };
  });
  showMapTypeInInterface();
  fitShadowToScheme();
  // a random scheme, by the generation rules
  playModeIsOn = false;
  rebuildTileRules();
  const generated = generateHexScheme(seed);
  hexCells.forEach(function (cell, cellIndex) {
    cell.baseTile = generated ? generated[cellIndex] : tiles[0];
  });
  rebuildHexCells();
  if (startsInPlayMode) {
    enterHexPlayModeKeepingMap();
  } else {
    showModeInInterface();
    resetEditorForNewScheme();
  }
  document.getElementById('schemeInfo').textContent = (quadMapKind === 'bent' ? 'Bent grid ' : 'Hexagonal map ') + seed + ', ' + hexMap.cells.length + ' quads' +
    (generated ? '' : ' (no scheme found, left open)');
}

function flattenHexMap() {
  hexPointLevels.fill(0);
  const result = solveHexMap(function (pointIndex) {
    return hexPointLevels[pointIndex];
  }, null);
  showHexSolution(result.tiles);
}

// ---- block mode on the hexagonal map ----
const hexHoverLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00ccff, depthTest: false }));
hexHoverLine.renderOrder = 10;
hexHoverLine.visible = false;
scene.add(hexHoverLine);
const hexSelectionLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffaa00, depthTest: false }));
hexSelectionLine.renderOrder = 11;
hexSelectionLine.visible = false;
scene.add(hexSelectionLine);

function outlineQuad(line, cellIndex, height) {
  const positions = [];
  hexQuadCorners(cellIndex).forEach(function (point) {
    positions.push(point.x, height, point.z);
  });
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

// The quad the pointer is on: the block it hits, or the empty quad of the ground when that is nearer
function findHexCellUnderPointer() {
  raycaster.setFromCamera(pointerPosition, camera);
  const placedObjects = hexCells.map(function (cell) {
    return cell.sceneObject;
  }).filter(Boolean);
  let found = null;
  let foundDistance = Infinity;
  const hits = raycaster.intersectObjects(placedObjects, true);
  if (hits.length > 0) {
    let hitObject = hits[0].object;
    while (hitObject && hitObject.userData.hexCell === undefined) {
      hitObject = hitObject.parent;
    }
    if (hitObject) {
      found = hexCells[hitObject.userData.hexCell];
      foundDistance = hits[0].distance;
    }
  }
  const groundPoint = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  if (groundPoint && groundPoint.distanceTo(raycaster.ray.origin) < foundDistance) {
    for (let cellIndex = 0; cellIndex < hexCells.length; cellIndex++) {
      if (!hexCells[cellIndex].baseTile && isPointInQuad(groundPoint.x, groundPoint.z, hexQuadCorners(cellIndex))) {
        found = hexCells[cellIndex];
      }
    }
  }
  return found;
}

function setHexCellTile(cell, tile) {
  cell.baseTile = tile;
  const tree = hexTreeOfCell.get(cell.hexIndex);
  if (tree && tile) {
    scene.remove(tree.treeGroup);
    hexTreeOfCell.delete(cell.hexIndex);
  }
  rebuildHexCells();
  updateEditorStatus();
}

function refreshHexConflictMarkers() {
  hexMap.cells.forEach(function (cell, cellIndex) {
    const tile = hexCells[cellIndex].chosen;
    if (!tile) {
      return;
    }
    cell.neighbours.forEach(function (neighbour, edge) {
      if (!neighbour || neighbour.cell < cellIndex) {
        return; // each shared edge once
      }
      const otherTile = hexCells[neighbour.cell].chosen;
      if (!otherTile || compareEdge(otherTile.edges[neighbour.edge], tile.edges[edge])) {
        return;
      }
      const start = hexMap.points[cell.corners[edge]];
      const end = hexMap.points[cell.corners[(edge + 1) % 4]];
      const marker = new THREE.Group();
      const wall = new THREE.Mesh(conflictWallGeometry, conflictWallMaterial);
      const wallEdges = new THREE.LineSegments(conflictEdgeGeometry, conflictEdgeMaterial);
      wall.renderOrder = 8;
      wallEdges.renderOrder = 9;
      marker.add(wall, wallEdges);
      marker.position.set((start.x + end.x) / 2, conflictMarkerHeight / 2, (start.z + end.z) / 2);
      marker.rotation.y = -Math.atan2(end.z - start.z, end.x - start.x);
      marker.scale.x = Math.hypot(end.x - start.x, end.z - start.z) / cellSize;
      scene.add(marker);
      conflictMarkers.push(marker);
    });
  });
}

function refreshHexEmptyCellOutlines() {
  const linePoints = [];
  hexCells.forEach(function (cell, cellIndex) {
    if (cell.baseTile) {
      return;
    }
    const corners = hexQuadCorners(cellIndex);
    corners.forEach(function (point, index) {
      const next = corners[(index + 1) % 4];
      linePoints.push(point.x, 0, point.z, next.x, 0, next.z);
    });
  });
  emptyCellOutlines.geometry.dispose();
  emptyCellOutlines.geometry = new THREE.BufferGeometry();
  emptyCellOutlines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
  emptyCellOutlines.visible = linePoints.length > 0;
}

function clearAllHexBlocks() {
  hexCells.forEach(function (cell) {
    cell.baseTile = null;
  });
  hexTreeOfCell.forEach(function (tree) {
    scene.remove(tree.treeGroup);
  });
  hexTreeOfCell.clear();
  rebuildHexCells();
  updateEditorStatus();
}

function leaveHexMap() {
  hexCells.forEach(disposeHexCellObject);
  hexCells = [];
  hexTreeOfCell.forEach(function (tree) {
    scene.remove(tree.treeGroup);
  });
  hexTreeOfCell.clear();
  mapIsHexagonal = false;
  hexMap = null;
  pointMarker.visible = false;
  hexHoverLine.visible = false;
  hexSelectionLine.visible = false;
  showMapTypeInInterface();
}

function changeHexPointLevel(pointIndex, levelStep) {
  const oldLevel = hexPointLevels[pointIndex];
  const newLevel = Math.min(highestPointLevel, Math.max(lowestPointLevel, oldLevel + levelStep));
  if (newLevel === oldLevel) {
    return;
  }
  hexPointLevels[pointIndex] = newLevel;
  const result = solveHexMap(function (index) {
    return hexPointLevels[index];
  }, hexCells.map(function (cell) {
    return cell.solvedTile;
  }));
  if (!result.tiles) {
    hexPointLevels[pointIndex] = oldLevel;
    showPlayStatus('Not possible: ' + result.failure + '.');
    return;
  }
  showHexSolution(result.tiles);
  showPlayStatus('');
}

const hexPointChangeIsPossible = new Map();
function canChangeHexPointLevel(pointIndex, levelStep) {
  const oldLevel = hexPointLevels[pointIndex];
  const newLevel = oldLevel + levelStep;
  if (newLevel < lowestPointLevel || newLevel > highestPointLevel) {
    return false;
  }
  const key = pointIndex + ':' + levelStep + ':' + hexPointLevels.join('');
  if (!hexPointChangeIsPossible.has(key)) {
    if (hexPointChangeIsPossible.size > 500) {
      hexPointChangeIsPossible.clear();
    }
    hexPointLevels[pointIndex] = newLevel;
    const result = solveHexMap(function (index) {
      return hexPointLevels[index];
    }, null);
    hexPointLevels[pointIndex] = oldLevel;
    hexPointChangeIsPossible.set(key, Boolean(result.tiles));
  }
  return hexPointChangeIsPossible.get(key);
}

// The inner point of the hexagonal map nearest to where the pointer meets the blocks or the ground
function findHexPointUnderPointer() {
  raycaster.setFromCamera(pointerPosition, camera);
  const placedObjects = hexCells.map(function (cell) {
    return cell.sceneObject;
  }).filter(Boolean);
  const hits = raycaster.intersectObjects(placedObjects, true);
  const hitPoint = hits.length > 0 ? hits[0].point : raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  if (!hitPoint) {
    return null;
  }
  let nearest = null;
  let nearestDistance = cellSize * 0.6;
  hexMap.points.forEach(function (point, pointIndex) {
    if (point.isOnBoundary) {
      return; // the rim of the hexagon stays ground
    }
    const distance = Math.hypot(point.x - hitPoint.x, point.z - hitPoint.z);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = pointIndex;
    }
  });
  return nearest;
}

function updateHexHoveredPoint() {
  hexHoveredPoint = findHexPointUnderPointer();
  pointMarker.visible = hexHoveredPoint !== null;
  if (hexHoveredPoint === null) {
    renderer.domElement.style.cursor = '';
    return;
  }
  const point = hexMap.points[hexHoveredPoint];
  pointMarker.position.set(point.x, 0.1, point.z);
  pointMarker.material.color.set([0x3366ff, 0x00ccff, 0xffaa00, 0xff3300][hexPointLevels[hexHoveredPoint] - lowestPointLevel]);
  renderer.domElement.style.cursor = playCursor(canChangeHexPointLevel(hexHoveredPoint, 1), canChangeHexPointLevel(hexHoveredPoint, -1));
}

// The combination measure for the hexagonal map: at every inner point, the blocks around it in
// order round the point, each with which of its own corners lies at the point. That needs no
// direction of the map, so turned copies of a combination are the same kind by themselves.
function hexJunctionVarietyBits() {
  const countOfKind = new Map();
  let junctionCount = 0;
  hexMap.points.forEach(function (point, pointIndex) {
    if (point.isOnBoundary) {
      return;
    }
    const around = [];
    hexMap.cells.forEach(function (cell, cellIndex) {
      const cornerHere = cell.corners.indexOf(pointIndex);
      if (cornerHere < 0) {
        return;
      }
      const tile = hexCells[cellIndex].chosen;
      const centre = hexCellCentre(cellIndex);
      if (!tile) {
        around.push({ angle: Math.atan2(centre.z - point.z, centre.x - point.x), key: 'empty' });
        return;
      }
      let blockCorner = (cornerHere - tile.ro + 4) % 4;
      if (fourWaySymmetricBlockIndices.includes(tile.index)) {
        blockCorner = 0;
      } else if (twoWaySymmetricBlockIndices.includes(tile.index)) {
        blockCorner = blockCorner % 2;
      }
      around.push({ angle: Math.atan2(centre.z - point.z, centre.x - point.x), key: tile.index + '@' + blockCorner + (tile.mirrored ? 'm' : '') });
    });
    around.sort(function (first, second) {
      return first.angle - second.angle;
    });
    const keys = around.map(function (entry) {
      return entry.key;
    });
    let kind = null;
    for (let start = 0; start < keys.length; start++) {
      const turned = keys.slice(start).concat(keys.slice(0, start)).join(' ');
      if (kind === null || turned < kind) {
        kind = turned;
      }
    }
    countOfKind.set(kind, (countOfKind.get(kind) || 0) + 1);
    junctionCount++;
  });
  let bits = 0;
  countOfKind.forEach(function (count) {
    const share = count / junctionCount;
    bits -= share * Math.log2(share);
  });
  return { bits: bits, kindCount: countOfKind.size, junctionCount: junctionCount };
}

function showMapTypeInInterface() {
  document.getElementById('squareMapButton').classList.toggle('active', !mapIsHexagonal);
  document.getElementById('hexagonalMapButton').classList.toggle('active', mapIsHexagonal && quadMapKind === 'hexagonal');
  document.getElementById('bentMapButton').classList.toggle('active', mapIsHexagonal && quadMapKind === 'bent');
  document.getElementById('bentGridControls').style.display = mapIsHexagonal && quadMapKind === 'bent' ? '' : 'none';
  document.getElementById('hexSizeControls').style.display = mapIsHexagonal && quadMapKind === 'hexagonal' ? '' : 'none';
  document.getElementById('gridSizeControls').style.display = mapIsHexagonal && quadMapKind === 'hexagonal' ? 'none' : '';
  showHexRingCount();
}

// The size of the hexagonal map: the same seed again with the new number of rings, when the slider is let go
function showHexRingCount() {
  document.getElementById('hexRingCountSlider').value = hexRingCount;
  document.getElementById('hexRingCountText').textContent = hexRingCount + ' rings';
}
document.getElementById('hexRingCountSlider').addEventListener('input', function () {
  document.getElementById('hexRingCountText').textContent = this.value + ' rings';
});
document.getElementById('hexRingCountSlider').addEventListener('change', function () {
  hexRingCount = Number(this.value);
  if (mapIsHexagonal && quadMapKind === 'hexagonal') {
    startHexMap(hexMapSeed);
  }
});

function startQuadMapOfKind(kind, seed) {
  quadMapKind = kind;
  startHexMap(seed);
}

document.getElementById('hexagonalMapButton').addEventListener('click', function () {
  if (!mapIsHexagonal || quadMapKind !== 'hexagonal') {
    startQuadMapOfKind('hexagonal', Date.now() % 1000000);
  }
});
// The pictures on the map buttons: the grid each kind makes, drawn small by the generator that
// makes the map itself (a square grid, the bent grid, the hexagon of quads), so that the buttons
// show what they give rather than a word
function drawMapPicture(canvas, points, cells, fillShare) {
  const brush = canvas.getContext('2d');
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  points.forEach(function (point) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  });
  const margin = 8;
  const scale = (fillShare || 1) * Math.min((canvas.width - 2 * margin) / (maxX - minX), (canvas.height - 2 * margin) / (maxZ - minZ));
  const offsetX = (canvas.width - (maxX - minX) * scale) / 2;
  const offsetZ = (canvas.height - (maxZ - minZ) * scale) / 2;
  brush.clearRect(0, 0, canvas.width, canvas.height);
  brush.fillStyle = '#f4f1ea';
  brush.strokeStyle = '#3a3f47';
  brush.lineWidth = 2.6; // (the canvas is drawn at twice the size it is shown at)
  brush.lineJoin = 'round';
  function traceCell(cell) {
    brush.beginPath();
    cell.corners.forEach(function (cornerIndex, index) {
      const point = points[cornerIndex];
      const x = offsetX + (point.x - minX) * scale;
      const y = offsetZ + (point.z - minZ) * scale;
      if (index === 0) {
        brush.moveTo(x, y);
      } else {
        brush.lineTo(x, y);
      }
    });
    brush.closePath();
  }
  // (all the fills first, then all the outlines: a fill drawn later would cover half of a neighbour's line)
  cells.forEach(function (cell) {
    traceCell(cell);
    brush.fill();
  });
  cells.forEach(function (cell) {
    traceCell(cell);
    brush.stroke();
  });
}
function drawMapPictures() {
  const pictureColumns = 7;
  const pictureRows = 5;
  const squarePoints = [];
  const squareCells = [];
  for (let row = 0; row <= pictureRows; row++) {
    for (let column = 0; column <= pictureColumns; column++) {
      squarePoints.push({ x: column * cellSize, z: row * cellSize });
    }
  }
  for (let row = 0; row < pictureRows; row++) {
    for (let column = 0; column < pictureColumns; column++) {
      const corner = row * (pictureColumns + 1) + column;
      squareCells.push({ corners: [corner, corner + 1, corner + pictureColumns + 2, corner + pictureColumns + 1] });
    }
  }
  drawMapPicture(document.querySelector('#squareMapButton .mapPicture'), squarePoints, squareCells);
  const bentPictureMap = generateBentGridQuadMap(pictureColumns, pictureRows, cellSize, bentGridShift.amplitudeMetres, bentGridShift.wavelengthMetres * 0.8, 3);
  drawMapPicture(document.querySelector('#bentMapButton .mapPicture'), bentPictureMap.points, bentPictureMap.cells, 1.05);
  const hexPictureMap = generateHexQuadMap(2, cellSize, 7);
  drawMapPicture(document.querySelector('#hexagonalMapButton .mapPicture'), hexPictureMap.points, hexPictureMap.cells, 1.1);
}
drawMapPictures();
document.getElementById('bentMapButton').addEventListener('click', function () {
  if (!mapIsHexagonal || quadMapKind !== 'bent') {
    startQuadMapOfKind('bent', Date.now() % 1000000);
  }
});

// The bend of the bent grid: the same seed again with the new bend, when a slider is let go
function showBentGridShift() {
  document.getElementById('bentGridAmplitude').value = bentGridShift.amplitudeMetres;
  document.getElementById('bentGridWavelength').value = bentGridShift.wavelengthMetres;
  document.getElementById('bentGridAmplitudeText').textContent = bentGridShift.amplitudeMetres.toFixed(1) + ' m';
  document.getElementById('bentGridWavelengthText').textContent = bentGridShift.wavelengthMetres.toFixed(0) + ' m';
}
['bentGridAmplitude', 'bentGridWavelength'].forEach(function (sliderId) {
  const slider = document.getElementById(sliderId);
  slider.addEventListener('input', function () {
    bentGridShift.amplitudeMetres = Number(document.getElementById('bentGridAmplitude').value);
    bentGridShift.wavelengthMetres = Number(document.getElementById('bentGridWavelength').value);
    showBentGridShift();
  });
  slider.addEventListener('change', function () {
    if (mapIsHexagonal && quadMapKind === 'bent') {
      startHexMap(hexMapSeed);
    }
  });
});
showBentGridShift();
document.getElementById('squareMapButton').addEventListener('click', function () {
  if (mapIsHexagonal) {
    leaveHexMap();
    generateWithSeed(richVariantSeeds[Math.floor(Math.random() * richVariantSeeds.length)]);
  }
});

// ---------------------------------------------------------------------------
// Path traced light: every sample follows the light through several bounces, so surfaces light
// each other and the sun shadow is sharp. The picture starts noisy and clears up while the
// camera rests; moving the camera or changing the scheme starts it again.
// ---------------------------------------------------------------------------
const pathTracedBounceCount = 5;
const maximumPathTracedSampleCount = 500;
let pathTracer = null; // made when the option is first switched on
let pathTracingIsOn = false;
let sceneVersion = 0;
let pathTracedSceneVersion = -1;
let pathTracerIsLoading = false; // a scene is being prepared in the background
let firstTracedFrameIsAnnounced = false;
let bvhWorkerHasFailed = false; // then the scene is prepared on the page itself, with a pause

function markSceneChanged() {
  sceneVersion++;
}

// The scene is prepared in the background: the search structure over its triangles is built in
// worker threads, and the shader compiles without blocking the page. Until it is ready the
// normal view goes on, and a scene changed meanwhile is prepared again afterwards.
function loadSceneIntoPathTracer() {
  if (pathTracerIsLoading) {
    return;
  }
  pathTracerIsLoading = true;
  const loadingVersion = sceneVersion;
  // the red conflict walls and the cell outlines are drawing aids, not part of the lit scene
  const drawingAids = conflictMarkers.concat([emptyCellOutlines, hoverOutline, selectionOutline]);
  const aidWasVisible = drawingAids.map(function (aid) {
    return aid.visible;
  });
  drawingAids.forEach(function (aid) {
    aid.visible = false;
  });
  scene.updateMatrixWorld(true);
  let loading;
  if (bvhWorkerHasFailed) {
    try {
      pathTracer.setScene(scene, camera);
      loading = Promise.resolve();
    } catch (error) {
      loading = Promise.reject(error);
    }
  } else {
    loading = pathTracer.setSceneAsync(scene, camera);
  }
  // the meshes are collected at once, so the drawing aids can be shown again straight away
  drawingAids.forEach(function (aid, index) {
    aid.visible = aidWasVisible[index];
  });
  loading.then(function () {
    pathTracerIsLoading = false;
    pathTracedSceneVersion = loadingVersion;
    rememberTracedCamera();
  }, function (error) {
    pathTracerIsLoading = false;
    if (!bvhWorkerHasFailed) {
      // most likely the worker file could not be loaded; the next frame prepares the scene on the page
      console.warn('Path tracing: the worker failed, preparing on the page instead.', error);
      bvhWorkerHasFailed = true;
      pathTracer.dispose();
      pathTracer = createPathTracer(false); // the old one still counts its failed build as running
      document.getElementById('pathTracingStatus').textContent =
        'Preparing on the page instead, the page pauses for a moment…';
      return;
    }
    console.error('Path tracing could not be prepared', error);
    pathTracingIsOn = false;
    document.getElementById('pathTracingCheckbox').checked = false;
    document.getElementById('pathTracingStatus').textContent = 'Path traced light could not be prepared: ' + error.message;
  });
}

function renderPathTracedSample() {
  if (!pathTracingIsOn) {
    renderer.render(scene, camera);
    return;
  }
  if (pathTracedSceneVersion !== sceneVersion) {
    loadSceneIntoPathTracer();
  }
  if (pathTracedSceneVersion === -1 || pathTracerIsLoading || pathTracer.isCompiling) {
    // not ready yet: the normal view stays on screen
    renderer.render(scene, camera);
    document.getElementById('pathTracingStatus').textContent = 'Preparing path traced light…';
    return;
  }
  // The very first traced frame makes the graphics driver translate the path tracing shader, which
  // WebGL can only do on the page's own thread: the page pauses once (half a minute the first time
  // on a machine, a few seconds once the browser has cached it). The notice is shown a frame ahead.
  if (!firstTracedFrameIsAnnounced) {
    firstTracedFrameIsAnnounced = true;
    renderer.render(scene, camera);
    document.getElementById('pathTracingStatus').textContent =
      'The graphics driver is compiling the light shader. The page pauses once for this…';
    return;
  }
  // one more sample when an image is to be saved: the canvas must be drawn in the frame it is read
  if (pathTracer.samples < maximumPathTracedSampleCount || captureImage) {
    pathTracer.renderSample();
  }
  document.getElementById('pathTracingStatus').textContent =
    Math.floor(pathTracer.samples) + ' / ' + maximumPathTracedSampleCount + ' samples';
}

// The patterns the normal view draws in its shaders, baked (bakedTextures.js): the materials take
// them as maps while the path tracer is on, which reads maps and not shaders, and give them back
// for the normal view, which draws the patterns itself and would draw them twice over the maps
let bakedRoofTextures = null;
let bakedGroundTexture = null;
function setBakedMapsForTracing(isOn) {
  if (isOn && bakedRoofTextures === null) {
    bakedRoofTextures = makeRoofTileTextures();
    bakedGroundTexture = makeGroundTexture();
  }
  roofTileMaterials.forEach(function (material) {
    if (isOn) {
      material.userData.roughnessBeforeTracing = material.roughness;
      material.map = bakedRoofTextures.map;
      material.roughnessMap = bakedRoofTextures.roughnessMap;
      material.roughness = 1; // (the roughness map carries it)
    } else {
      material.map = null;
      material.roughnessMap = null;
      if (material.userData.roughnessBeforeTracing !== undefined) {
        material.roughness = material.userData.roughnessBeforeTracing;
      }
    }
    material.needsUpdate = true;
  });
  if (lushGroundMaterial) {
    lushGroundMaterial.map = isOn ? bakedGroundTexture : null;
    lushGroundMaterial.needsUpdate = true;
  }
}

document.getElementById('pathTracingCheckbox').addEventListener('change', function () {
  pathTracingIsOn = this.checked;
  setBakedMapsForTracing(pathTracingIsOn);
  if (pathTracingIsOn && !pathTracer) {
    // The path tracer reads these two from every scene, also from one it makes itself, and
    // three 0.160 does not have them yet (they came in 0.162). Unrotated is what is wanted.
    if (!('backgroundRotation' in THREE.Scene.prototype)) {
      THREE.Scene.prototype.backgroundRotation = new THREE.Euler();
      THREE.Scene.prototype.environmentRotation = new THREE.Euler();
    }
    pathTracer = createPathTracer(true);
  }
  if (pathTracingIsOn) {
    pathTracedSceneVersion = -1; // reload: the scene may have changed while the option was off
    sceneVersion++;
  } else {
    document.getElementById('pathTracingStatus').textContent = '';
  }
});

function createPathTracer(buildsInWorkers) {
  const newPathTracer = new WebGLPathTracer(renderer);
  if (buildsInWorkers) {
    newPathTracer.setBVHWorker(new ParallelMeshBVHWorker());
  }
  newPathTracer.bounces = pathTracedBounceCount;
  newPathTracer.filterGlossyFactor = 0.5; // calms the bright speckles of glossy reflections
  newPathTracer.renderScale = 1 / renderer.getPixelRatio();
  newPathTracer.tiles.set(2, 2); // a sample is drawn in four parts, so the page stays responsive
  return newPathTracer;
}

// The orbit controls glide to a stop, nudging the camera by ever smaller steps for a while, and
// with the low frame rate of path tracing that goes on for many seconds. Each nudge would start
// the picture over at 0 samples, so a camera change too small to see is not passed on.
const tracedCameraPosition = new THREE.Vector3();
const tracedCameraQuaternion = new THREE.Quaternion();
const visibleCameraMoveShare = 0.0005; // of the distance to the target
const visibleCameraTurn = 0.0003;      // radians
controls.addEventListener('change', function () {
  if (!pathTracingIsOn || !pathTracer || pathTracedSceneVersion !== sceneVersion) {
    return;
  }
  const moveDistance = camera.position.distanceTo(tracedCameraPosition);
  const turnAngle = camera.quaternion.angleTo(tracedCameraQuaternion);
  if (moveDistance > visibleCameraMoveShare * camera.position.distanceTo(controls.target) || turnAngle > visibleCameraTurn) {
    rememberTracedCamera();
    pathTracer.updateCamera();
  }
});

function rememberTracedCamera() {
  tracedCameraPosition.copy(camera.position);
  tracedCameraQuaternion.copy(camera.quaternion);
}

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateHoveredCell();
  updateHoveredPoint();
  turnBlockThumbnails();
  if (pathTracingIsOn) {
    renderPathTracedSample();
  } else {
    renderer.render(scene, camera);
  }
  if (keptViewIsRequested) {
    keptViewIsRequested = false;
    sendKeptView(renderer.domElement.toDataURL('image/jpeg', 0.85));
  }
  if (captureImage) {
    const dataURL = renderer.domElement.toDataURL('image/png');

    // Create a link element
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = 'screenshot.png';
    link.click();

    // Reset the captureImage flag
    captureImage = false;
  }

}

animate(); //call the loop

window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
  // Update camera's aspect ratio and projection matrix
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  // Update renderer's size
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (pathTracer) {
    pathTracer.updateCamera();
  }
}
const maxTextureSize = renderer.capabilities.maxTextureSize;
console.log('Max texture size: ' + maxTextureSize);
// renderer.gammaFactor = 2.2; // Use sRGB encoding for textures and colors
// renderer.outputEncoding = THREE.sRGBEncoding;
// environmentMapTexture.encoding = THREE.sRGBEncoding;
// reflectiveMaterial.metalness = 1; // Make it fully metallic
// reflectiveMaterial.roughness = 0; // Make it completely smooth
// ---------------------------------------------------------------------------
// Time of day: the sun crosses the sky from morning to evening; at night a weak moon takes over,
// the sky darkens and the paper doors glow. In path traced light the glowing doors are light
// sources of their own and light the verandas and the ground in front of them.
// ---------------------------------------------------------------------------
const paperDoorMaterials = new Set(); // filled when the model loads
const daylightEnvironmentIntensity = 0.3;
const nightEnvironmentShare = 0.08;  // of the daylight sky light that is left at night
const nightBackgroundShare = 0.06;
const middaySunElevationDegrees = 55;
const middaySunAzimuthDegrees = 153;
const sunAzimuthDegreesPerHour = 15;
const daylightSunIntensity = 3;
const moonIntensity = 0.35;
const moonElevationDegrees = 40;
const moonAzimuthDegrees = middaySunAzimuthDegrees + 180;
const moonColor = new THREE.Color(0x9fb4ff);
const lowSunColor = new THREE.Color(0xffa860);
const highSunColor = new THREE.Color(0xffffee);
const nightPaperDoorGlow = 0.5;      // times the model's glow, at night; none by day (2.5 until 2026-10-13: the author wants a fifth of it)
const nightExposureIncrease = 0.6;

function formatHour(hour) {
  const wholeHours = Math.floor(hour) % 24;
  const minutes = Math.floor((hour - Math.floor(hour)) * 60);
  return String(wholeHours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function applyTimeOfDay() {
  const hour = Number(document.getElementById('timeOfDay').value);
  document.getElementById('timeOfDayText').textContent = formatHour(hour);
  const sunElevationDegrees = middaySunElevationDegrees * Math.sin(Math.PI * (hour - 6) / 12);
  const daylight = THREE.MathUtils.smoothstep(sunElevationDegrees, -6, 20); // 0 at night, 1 by day

  // one light: the sun while it is up, the moon after it has set; each fades out at the horizon
  if (sunElevationDegrees > 0) {
    sunAngles.elevationDegrees = sunElevationDegrees;
    sunAngles.azimuthDegrees = middaySunAzimuthDegrees + (hour - 12) * sunAzimuthDegreesPerHour;
    directionalLight.color.copy(lowSunColor).lerp(highSunColor, THREE.MathUtils.smoothstep(sunElevationDegrees, 0, 35));
    directionalLight.intensity = daylightSunIntensity * THREE.MathUtils.smoothstep(sunElevationDegrees, 0, 15);
  } else {
    sunAngles.elevationDegrees = moonElevationDegrees;
    sunAngles.azimuthDegrees = moonAzimuthDegrees;
    directionalLight.color.copy(moonColor);
    directionalLight.intensity = moonIntensity * THREE.MathUtils.smoothstep(-sunElevationDegrees, 0, 10);
  }
  placeSun();
  fitShadowToScheme();

  // the sky light and the reflections in the water dim with the daylight
  const skyShare = nightEnvironmentShare + (1 - nightEnvironmentShare) * daylight;
  const environmentIntensity = daylightEnvironmentIntensity * skyShare;
  scene.traverse(function (child) {
    if (child.isMesh && child.material.isMeshStandardMaterial && child.material !== reflectiveMaterial) {
      child.material.envMapIntensity = environmentIntensity;
    }
  });
  PineTree.environmentIntensity = environmentIntensity; // for the trees planted later
  reflectiveMaterial.envMapIntensity = waterReflectionStrength * skyShare;
  scene.environmentIntensity = environmentIntensity; // read by the path tracer
  scene.backgroundIntensity = nightBackgroundShare + (1 - nightBackgroundShare) * daylight;
  renderer.toneMappingExposure = 1 + nightExposureIncrease * (1 - daylight);

  // the paper doors glow from inside
  paperDoorMaterials.forEach(function (material) {
    material.emissiveIntensity = nightPaperDoorGlow * (1 - daylight);
  });

  if (pathTracer) {
    pathTracer.updateLights();
    pathTracer.updateEnvironment();
    pathTracer.updateMaterials();
  }
}

document.getElementById('timeOfDay').addEventListener('input', applyTimeOfDay);

// ---------------------------------------------------------------------------
// The lens, and views kept for the film. "Keep view" writes the map as it stands (its kind, seed,
// size and bend, every block and tree, the options) and the view (camera, lens, time of day) to
// film/kept_views.json through the development server (vite.config.js), with a picture beside it;
// restoreKeptView brings one back, for film/capture_footage.js.
// ---------------------------------------------------------------------------
// The angle of view of the camera. With keepsFraming the camera moves along its line of sight so
// that what stands at the target keeps its size: a smaller angle from further away only flattens
// the perspective.
function setLensAngle(degrees, keepsFraming) {
  if (keepsFraming) {
    const distanceRatio = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(degrees) / 2);
    camera.position.sub(controls.target).multiplyScalar(distanceRatio).add(controls.target);
  }
  camera.fov = degrees;
  camera.far = Math.max(1000, 3 * camera.position.distanceTo(controls.target));
  camera.updateProjectionMatrix();
  controls.update();
  document.getElementById('lensAngle').value = degrees;
  document.getElementById('lensAngleText').textContent = Math.round(degrees) + '°';
  if (pathTracingIsOn && pathTracer && pathTracedSceneVersion === sceneVersion) {
    rememberTracedCamera();
    pathTracer.updateCamera();
  }
}
document.getElementById('lensAngle').addEventListener('input', function () {
  setLensAngle(Number(this.value), true);
});
setLensAngle(camera.fov, false);

function describeTile(tile) {
  return tile ? [tile.index, tile.ro, tile.mirrored ? 1 : 0] : null;
}

function describeStandingBlocks() {
  if (mapIsHexagonal) {
    return hexCells.map(function (cell) {
      return describeTile(cell.baseTile);
    });
  }
  return grid.map(function (column) {
    return column.map(function (cell) {
      return describeTile(cell.chosen);
    });
  });
}

function describeKeptView() {
  const roundedTo = function (value, decimalCount) {
    return Number(value.toFixed(decimalCount));
  };
  const trees = scene.children.filter(function (object) {
    return object.generated === true;
  }).map(function (treeGroup) {
    return [treeGroup.userData.pineSize, roundedTo(treeGroup.position.x, 3), roundedTo(treeGroup.position.y, 3), roundedTo(treeGroup.position.z, 3)];
  });
  return {
    mapKind: mapIsHexagonal ? quadMapKind : 'square',
    seed: mapIsHexagonal ? hexMapSeed : currentSeed,
    columnCount: cols,
    rowCount: rows,
    hexRingCount: hexRingCount,
    quadCount: mapIsHexagonal ? hexMap.cells.length : cols * rows,
    bentGridShift: { amplitudeMetres: bentGridShift.amplitudeMetres, wavelengthMetres: bentGridShift.wavelengthMetres },
    options: { openEdge: openEdge, trees: showTrees, water: ruleOptions.useLandscapeBlocks, favorPavilion: favorTwoStoreyPavilion },
    camera: {
      position: camera.position.toArray().map(function (value) { return roundedTo(value, 3); }),
      target: controls.target.toArray().map(function (value) { return roundedTo(value, 3); }),
      angleOfViewDegrees: camera.fov,
    },
    timeOfDayHours: Number(document.getElementById('timeOfDay').value),
    schemeInfo: document.getElementById('schemeInfo').textContent,
    blocks: describeStandingBlocks(),
    trees: trees,
  };
}

function showSchemeStatus(text) {
  document.getElementById('schemeStatus').textContent = text;
}
function showKeptViewCount(reply) {
  showSchemeStatus(reply.count + ' kept for the film' + (reply.count > 0 ? ' (the last: ' + reply.lastSchemeInfo + ')' : ''));
}
function askKeptViewServer(body) {
  return fetch('/film/kept-views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (response) {
      if (!response.ok) {
        throw new Error('status ' + response.status);
      }
      return response.json();
    })
    .then(showKeptViewCount)
    .catch(function (error) {
      showSchemeStatus('Not kept: the development server did not answer (' + error.message + ').');
    });
}
function sendKeptView(pictureDataUrl) {
  askKeptViewServer({ action: 'keep', view: describeKeptView(), picture: pictureDataUrl });
}
// A scheme saved as a file the browser hands over, and loaded from one: the same description
// the film's kept views use, so that either brings the map, its blocks and trees, the light and
// the view back exactly
document.getElementById('saveSchemeButton').addEventListener('click', function () {
  const scheme = describeKeptView();
  const name = 'scheme_' + scheme.mapKind + '_' + scheme.seed;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(scheme)], { type: 'application/json' }));
  link.download = name + '.json';
  link.click();
  URL.revokeObjectURL(link.href);
  showSchemeStatus('Saved as ' + name + '.json, in the downloads.');
});
document.getElementById('loadSchemeButton').addEventListener('click', function () {
  document.getElementById('loadSchemeInput').click();
});
document.getElementById('loadSchemeInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const scheme = JSON.parse(reader.result);
      restoreKeptView(scheme);
      showSchemeStatus('Loaded ' + file.name + ': ' + (scheme.schemeInfo || scheme.mapKind + ' map, seed ' + scheme.seed) + '.');
    } catch (error) {
      showSchemeStatus('Not a scheme: ' + error.message);
    }
  };
  reader.readAsText(file);
  this.value = '';
});

function tileFromDescription(description) {
  return description ? createOrientedTile(description[0], description[1], description[2] === 1) : null;
}

// Brings a kept view back: the map from its seed, then every block and tree as they stood (they
// differ from the seed's where the map was changed by hand), the light and the camera
function restoreKeptView(keptView) {
  openEdge = keptView.options.openEdge;
  showTrees = keptView.options.trees;
  ruleOptions.useLandscapeBlocks = keptView.options.water;
  favorTwoStoreyPavilion = keptView.options.favorPavilion;
  document.getElementById('rows').value = keptView.rowCount;
  document.getElementById('cols').value = keptView.columnCount;
  if (playModeIsOn) {
    leavePlayMode();
  }
  if (keptView.mapKind === 'square') {
    if (mapIsHexagonal) {
      leaveHexMap();
    }
    generateWithSeed(keptView.seed);
    if (JSON.stringify(describeStandingBlocks()) !== JSON.stringify(keptView.blocks)) {
      scene.children.filter(function (object) {
        return object.generatedBlock === true;
      }).forEach(function (object) {
        scene.remove(object);
        disposeOwnGround(object);
      });
      grid = keptView.blocks.map(function (column, i) {
        return column.map(function (description, j) {
          const cell = new Cell(i, j, []);
          cell.chosen = tileFromDescription(description);
          cell.collapsed = cell.chosen !== null;
          return cell;
        });
      });
      unsolved = [];
      collapseOrder = [];
      grid.forEach(function (column) {
        column.forEach(placeBlockInScene);
      });
      applyTerrainRelief();
      smoothRoofsAcrossBlocks();
    }
  } else {
    hexRingCount = keptView.hexRingCount || hexRingCount;
    bentGridShift.amplitudeMetres = keptView.bentGridShift.amplitudeMetres;
    bentGridShift.wavelengthMetres = keptView.bentGridShift.wavelengthMetres;
    showBentGridShift();
    startQuadMapOfKind(keptView.mapKind, keptView.seed);
    if (JSON.stringify(describeStandingBlocks()) !== JSON.stringify(keptView.blocks)) {
      hexCells.forEach(function (cell, cellIndex) {
        cell.baseTile = tileFromDescription(keptView.blocks[cellIndex]);
      });
      rebuildHexCells();
    }
    hexTreeOfCell.clear();
  }
  removeAllPinesFromScene(scene);
  if (showTrees) {
    keptView.trees.forEach(function (tree) {
      const pine = new PineTree(tree[0], tree[1], tree[3]);
      pine.treeGroup.position.y = tree[2];
      pine.addToScene(scene);
    });
  }
  refreshConflictMarkers();
  conflictMarkers.forEach(function (marker) {
    marker.visible = false;
  });
  document.getElementById('timeOfDay').value = keptView.timeOfDayHours;
  applyTimeOfDay();
  camera.position.fromArray(keptView.camera.position);
  controls.target.fromArray(keptView.camera.target);
  setLensAngle(keptView.camera.angleOfViewDegrees, false);
  markSceneChanged();
}

// ---------------------------------------------------------------------------
// For the film: with ?film in the address, film/capture_footage.js drives the page through these.
// ---------------------------------------------------------------------------
if (location.search.includes('film')) {
  controls.enableDamping = false;
  const hiddenCellLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd8dccf, transparent: true, opacity: 0.55 }));
  hiddenCellLines.frustumCulled = false;
  scene.add(hiddenCellLines);
  window.film = {
    // a hexagonal map of a chosen seed (the interface only makes random ones)
    startHexMap: function (seed) {
      startQuadMapOfKind('hexagonal', seed);
      return document.getElementById('schemeInfo').textContent;
    },
    // ---- diagrams: blocks alone on white, seen from far off with a very long lens (isometric) ----
    diagramStyle: function () {
      scene.background = new THREE.Color(0xffffff);
      scene.backgroundIntensity = 1;
      emptyCellOutlines.visible = false;
      return true;
    },
    // the red wall between two blocks that may not join, clear enough for a still
    showConflictWalls: function (wallOpacity) {
      conflictWallMaterial.opacity = wallOpacity;
      conflictEdgeMaterial.opacity = 1;
      conflictMarkers.forEach(function (marker) {
        marker.visible = true;
      });
      return conflictMarkers.length;
    },
    // only these blocks on the square map: [[column, row, blockIndex, quarterTurns, mirrored 0|1], ...]
    showBlocks: function (blockList) {
      if (playModeIsOn) {
        leavePlayMode();
      }
      clearAllBlocks();
      blockList.forEach(function (entry) {
        setCellTile(grid[entry[0]][entry[1]], createOrientedTile(entry[2], entry[3], entry[4] === 1));
      });
      emptyCellOutlines.visible = false;
      return conflictMarkers.length;
    },
    // the turn of a block that puts a given edge label on a given side (0 up, 1 right, 2 down, 3 left)
    findOrientation: function (blockIndex, side, edgeLabel) {
      for (let mirrored = 0; mirrored < 2; mirrored++) {
        for (let turns = 0; turns < 4; turns++) {
          if (createOrientedTile(blockIndex, turns, mirrored === 1).edges[side] === edgeLabel) {
            return [turns, mirrored];
          }
        }
      }
      return null;
    },
    // turns of two blocks that let the first one's right side meet the second one's left side
    // with a roof on the shared edge (not flat ground or water): [turnsA, mirroredA, turnsB, mirroredB]
    joinOrientations: function (blockIndexA, blockIndexB) {
      for (let mirroredA = 0; mirroredA < 2; mirroredA++) {
        for (let turnsA = 0; turnsA < 4; turnsA++) {
          const edgeA = createOrientedTile(blockIndexA, turnsA, mirroredA === 1).edges[1];
          if (!/[1-9UPDCT]/.test(edgeA)) {
            continue;
          }
          for (let mirroredB = 0; mirroredB < 2; mirroredB++) {
            for (let turnsB = 0; turnsB < 4; turnsB++) {
              if (compareEdge(createOrientedTile(blockIndexB, turnsB, mirroredB === 1).edges[3], edgeA)) {
                return [turnsA, mirroredA, turnsB, mirroredB];
              }
            }
          }
        }
      }
      return null;
    },
    // takes the open ground away, so that only the buildings stand on the white
    removeOpenGround: function () {
      let removedCount = 0;
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const cell = grid[i][j];
          if (cell.chosen && cell.chosen.index === 0 && cell.sceneObject) {
            scene.remove(cell.sceneObject);
            cell.sceneObject = null;
            removedCount++;
          }
        }
      }
      markSceneChanged();
      return removedCount;
    },
    // a view from a direction (azimuth round the vertical, elevation above the ground, degrees) so far
    // off that the lines stay parallel; viewHeight is the height of the picture at the target, in metres
    parallelView: function (targetX, targetY, targetZ, azimuthDegrees, elevationDegrees, viewHeight) {
      const distance = 900;
      const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
      const elevation = THREE.MathUtils.degToRad(elevationDegrees);
      controls.target.set(targetX, targetY, targetZ);
      camera.position.set(
        targetX + distance * Math.cos(elevation) * Math.cos(azimuth),
        targetY + distance * Math.sin(elevation),
        targetZ + distance * Math.cos(elevation) * Math.sin(azimuth));
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(viewHeight / 2 / distance));
      camera.near = distance - 300;
      camera.far = distance + 300;
      camera.updateProjectionMatrix();
      controls.update();
      return true;
    },
    // ---- a larger hexagonal map, shaped by hand through the points ----
    setHexRingCount: function (ringCount) {
      hexRingCount = ringCount;
      return true;
    },
    hexPoints: function () {
      return hexMap.points.map(function (point) {
        return [Number(point.x.toFixed(2)), Number(point.z.toFixed(2)), point.isOnBoundary ? 1 : 0];
      });
    },
    // sets the levels of several points at once ([[pointIndex, level], ...]) and solves; when no
    // blocks fit, the points go back to what they were and the reason is returned
    setHexPointLevels: function (entries) {
      const levelsBefore = hexPointLevels.slice();
      entries.forEach(function (entry) {
        hexPointLevels[entry[0]] = entry[1];
      });
      const result = solveHexMap(function (index) {
        return hexPointLevels[index];
      }, hexCells.map(function (cell) {
        return cell.solvedTile;
      }));
      if (!result.tiles) {
        hexPointLevels = levelsBefore;
        return result.failure;
      }
      showHexSolution(result.tiles);
      return 'ok';
    },
    // raises points that stand in the middle of building (every point around them is raised) to
    // the pavilion level, at most pavilionCount of them and no two nearer than minimumSpacing metres
    raiseSurroundedHexPoints: function (pavilionCount, minimumSpacing) {
        const pointsAround = hexMap.points.map(function () {
          return new Set();
        });
        hexMap.cells.forEach(function (cell) {
          cell.corners.forEach(function (pointIndex) {
            cell.corners.forEach(function (otherPoint) {
              pointsAround[pointIndex].add(otherPoint);
            });
          });
        });
        const raised = [];
        for (let pointIndex = 0; pointIndex < hexMap.points.length && raised.length < pavilionCount; pointIndex++) {
          const point = hexMap.points[pointIndex];
          const isSurrounded = hexPointLevels[pointIndex] === 1 && Array.from(pointsAround[pointIndex]).every(function (otherPoint) {
            return hexPointLevels[otherPoint] >= 1;
          });
          const isFarFromOthers = raised.every(function (other) {
            return Math.hypot(other.x - point.x, other.z - point.z) >= minimumSpacing;
          });
          if (!isSurrounded || !isFarFromOthers) {
            continue;
          }
          if (window.film.setHexPointLevels([[pointIndex, 2]]) === 'ok') {
            raised.push(point);
          }
        }
        return raised.length;
    },
    hexCellCorners: function () {
      return hexMap.cells.map(function (cell) {
        return cell.corners;
      });
    },
    hexPointLevelList: function () {
      return hexPointLevels.slice();
    },
    startQuadMap: function (kind, seed) {
      startQuadMapOfKind(kind, seed);
      return document.getElementById('schemeInfo').textContent;
    },
    describeView: function () {
      return describeKeptView();
    },
    restoreKeptView: function (keptView) {
      restoreKeptView(keptView);
      return document.getElementById('schemeInfo').textContent;
    },
    // a longer lens (a smaller angle) from further away flattens the perspective
    setFieldOfView: function (degrees) {
      setLensAngle(degrees, false);
      return true;
    },
    view: function (x, y, z, targetX, targetY, targetZ) {
      camera.position.set(x, y, z);
      controls.target.set(targetX, targetY, targetZ);
      controls.update();
      return true;
    },
    hideInterface: function () {
      ['toolbar', 'editor', 'settings'].forEach(function (id) {
        document.getElementById(id).style.display = 'none';
      });
      pointMarker.visible = false;
      hoverOutline.visible = false;
      selectionOutline.visible = false;
      emptyCellOutlines.visible = false;
      return true;
    },
    // the collapse of the current square map, replayed: the first count decided cells shown
    collapseLength: function () {
      return collapseOrder.length;
    },
    showCollapseStep: function (count) {
      const shown = new Set(collapseOrder.slice(0, count));
      const forced = new Set();
      const linePoints = [];
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const cell = grid[i][j];
          const isForced = !collapseOrder.includes(cell);
          const isShown = isForced || shown.has(cell);
          if (isForced) {
            forced.add(cell);
          }
          if (cell.sceneObject) {
            cell.sceneObject.visible = isShown;
          }
          if (!isShown) {
            const left = cellCenterX(i) - cellSize / 2;
            const near = cellCenterZ(j) - cellSize / 2;
            linePoints.push(left, 0.05, near, left + cellSize, 0.05, near, left + cellSize, 0.05, near, left + cellSize, 0.05, near + cellSize,
              left + cellSize, 0.05, near + cellSize, left, 0.05, near + cellSize, left, 0.05, near + cellSize, left, 0.05, near);
          }
        }
      }
      hiddenCellLines.geometry.dispose();
      hiddenCellLines.geometry = new THREE.BufferGeometry();
      hiddenCellLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
      scene.children.forEach(function (object) {
        if (object.generated === true) {
          object.visible = count >= collapseOrder.length;
        }
      });
      markSceneChanged();
      return forced.size;
    },
    setTimeOfDay: function (hour) {
      document.getElementById('timeOfDay').value = hour;
      applyTimeOfDay();
      return true;
    },
    pathTracedSamples: function () {
      return pathTracer && pathTracedSceneVersion === sceneVersion && !pathTracerIsLoading ? pathTracer.samples : 0;
    },
    // play mode: set point levels directly and solve, like a sequence of clicks
    setPointLevels: function (entries) {
      entries.forEach(function (entry) {
        pointLevels[pointIndex(entry[0], entry[1])] = entry[2];
      });
      const result = solvePlayGrid();
      if (result.grid) {
        showPlayGrid(result.grid);
      }
      return result.failure || 'ok';
    },
    hexInnerPoints: function () {
      return hexMap.points.map(function (point, index) {
        return { index: index, distance: Math.hypot(point.x, point.z), isOnBoundary: point.isOnBoundary };
      }).filter(function (entry) {
        return !entry.isOnBoundary;
      }).sort(function (first, second) {
        return first.distance - second.distance;
      }).map(function (entry) {
        return entry.index;
      });
    },
    changeHexPoint: function (pointIndex, levelStep) {
      changeHexPointLevel(pointIndex, levelStep);
      return true;
    },
    // a catalogue: every block of the palette on its own cell, with open ground between
    showCatalogue: function (blockIndices) {
      clearAllBlocks();
      let position = 0;
      blockIndices.forEach(function (blockIndex) {
        const column = 1 + 2 * (position % 5);
        const row = 1 + 2 * Math.floor(position / 5);
        setCellTile(grid[column][row], createOrientedTile(blockIndex, 0, false));
        position++;
      });
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          if (!grid[i][j].chosen) {
            grid[i][j].chosen = tiles[0];
            placeBlockInScene(grid[i][j]);
          }
        }
      }
      applyTerrainRelief();
      conflictMarkers.forEach(function (marker) {
        marker.visible = false;
      });
      emptyCellOutlines.visible = false;
      return true;
    },
  };
}
