import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

let buildingBlocks = [];
let cols = 7;
let rows = 7;
let grid = [];
let unsolved = [];






class Tile {
  constructor(index, num, edges) {
    this.index = index;
    this.ro = num;
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
for (let p = 0; p < tiles.length; p++) {

  tiles[p].analyze(tiles);
}

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
// Function to generate a random seed
function generateRandomSeed() {
  const seed = Math.random().toString(); // Example seed
  updateRandomSeedDisplay(seed);
  return seed;
}

// Function to update the UI with the random seed
function updateRandomSeedDisplay(seed) {
  document.getElementById('randomSeedDisplay').innerText = seed;
}

// Example usage
const seed = generateRandomSeed();




// Create scene, camera, and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(cols * 8 , 15, rows * 8 );
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.needsUpdate = true;
renderer.toneMappingExposure = 0.5;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;



//scene add background color
scene.background = new THREE.Color(0x0000ff);


//add a directional light
const directionalLight = new THREE.DirectionalLight(0xffffee, 2);
directionalLight.position.set(-100, 100, 100); // Adjust the position
directionalLight.target.position.set(0, 0, 0); // Target position (where the light is pointing)
directionalLight.castShadow = true;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 500;
directionalLight.shadow.camera.left = -80; // Adjust as needed
directionalLight.shadow.camera.right = 80; // Adjust as needed
directionalLight.shadow.camera.top = 80; // Adjust as needed
directionalLight.shadow.camera.bottom = -80; // Adjust as needed
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2024;
//set the shadow darker
directionalLight.shadow.darkness = 0.3;
directionalLight.shadow.bias = 0.001;
scene.add(directionalLight);
scene.add(directionalLight.target); // Important: add the target to the scene
// const cameraHelper = new THREE.CameraHelper(directionalLight.shadow.camera);
// scene.add(cameraHelper);


const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Create an AxesHelper with a given size
const axesHelper = new THREE.AxesHelper(50);

// Add it to the scene
scene.add(axesHelper);

// Add environmental light


const cubeTextureLoader = new THREE.CubeTextureLoader();
const environmentMapTexture = cubeTextureLoader.load([
  './cubeTexture/posx.jpg',
  './cubeTexture/negx.jpg',
  './cubeTexture/posy.jpg',
  './cubeTexture/negy.jpg',
  './cubeTexture/posz.jpg',
  './cubeTexture/negz.jpg',
]);
scene.environment = environmentMapTexture;
scene.background = environmentMapTexture;
const manager = new THREE.LoadingManager();

manager.onLoad = function() {
  // Called when all resources are loaded
  initializeScene();
};

function initializeScene() {

  startOver();

}


manager.itemStart('buildingBlocks');

// Initial load
loadBuildingBlocks();

// Add regeneration button
document.getElementById('apply').addEventListener('click', function() {
  // Read the values from the input fields
  let newRows = parseInt(document.getElementById('rows').value);
  let newCols = parseInt(document.getElementById('cols').value);

  // Check for valid input
  if (newRows > 0 && newCols > 0) {
    // Update the rows and cols variables
    rows = newRows;
    cols = newCols;

    // Clear the current scene
    clearScene();

    // Regenerate the grid with new rows and cols
    startOver();
  } else {
    alert('Please enter valid numbers for rows and columns.');
  }
});
document.getElementById('regenerate').addEventListener('click', regenerate);

// //add a large plane down below at y = -10 to catch shadows
const planeGeometry = new THREE.PlaneGeometry(10000, 10000);
const planeMaterial = new THREE.MeshStandardMaterial({
  color: 0xaaaaaa,
  side: THREE.DoubleSide,
});
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
plane.receiveShadow = true;
plane.rotation.x = Math.PI / 2;
plane.position.y = -0.5;
scene.add(plane);


function regenerate() {
  clearScene();
  startOver();
}

function reverseString(s) {
  return s.split('').reverse().join('');
}

function compareEdge(a, b) {
  //this is sensitive to efficiency and not stategized fully
  if ((a === "UUU" && b === "DDD") ||
      (a === "DDD" && b === "UUU") ||
      (a === "C3C" && b === "232") ||
      (a === "232" && b === "C3C") ||
      (a === "232" && b === "C32") ||
      (a === "C32" && b === "232") ||
      (a === "C34" && b === "432") ||
      (a === "432" && b === "C34") ||
      (a === "43C" && b === "234") ||
      (a === "234" && b === "43C") ||
      (a === "PPP" && b === "UUU") ||
      (a === "UUU" && b === "PPP")) {
    return true;
  }
  if ((a === "DDD" && b === "DDD") ||
      (a === "PPP" && b === "PPP") ||
      (a === "UUU" && b === "UUU")) {
    return false;
  }
  return a === reverseString(b);
}

function startOver() {
  unsolved = [];
  grid = [];
  generateRandomSeed() ;

  // Create cell for each spot on the grid
  for (let i = 0; i < cols; i++) {
    grid.push([]);
    for (let j = 0; j < rows; j++) {
      grid[i].push(new Cell(i, j, tiles));
      unsolved.push(grid[i][j]);
    }
  }

  if(Math.random() < 0.4){
  let randomCell = grid[Math.floor(cols / 3)][Math.floor(rows / 3)]
  console.log('tower',randomCell.i, randomCell.j)
  randomCell.chosen = tiles[23];
  randomCell.collapsed = true;
  randomCell.checkNeighbors(grid);
  let index = unsolved.indexOf(randomCell);
if (index > -1) {
  unsolved.splice(index, 1);
}}
 
  if(Math.random() < 0.4){
    let randomCell = grid[cols-1][rows-1];
    console.log('pond',randomCell.i, randomCell.j)
    randomCell.chosen = tiles[3];
    randomCell.collapsed = true;
    randomCell.checkNeighbors(grid);
    let index = unsolved.indexOf(randomCell);
  if (index > -1) {
    unsolved.splice(index, 1);
  }}
        
    
      //else if (i === 0 || i === cols - 1 || j === 0 || j === rows - 1) {
      //   grid[i].push(new Cell(i, j, tiles));
      //   grid[i][j].chosen = tiles[0];
      //   grid[i][j].collapsed = true;}
      

  collapse(unsolved, grid);
}

function collapse(unsolved, grid) {
  while (unsolved.length > 0) {
    unsolved.sort((a, b) => a.options.length - b.options.length);
    if (unsolved[0].options.length === 0) {
      startOver();
      break;
    } else {
      let chosen = unsolved[0].options[Math.floor(Math.random() * unsolved[0].options.length)];
      unsolved[0].chosen = chosen;
      unsolved[0].collapsed = true;
      unsolved[0].checkNeighbors(grid);
      unsolved.shift();
    }
  }

  if (unsolved.length === 0) {
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        // Get the chosen building block
        let chosenBlock = buildingBlocks[grid[i][j].chosen.index];
        chosenBlock.receiveShadow = true;
        // Clone the building block
        let house = chosenBlock.clone();
         // Make the object visible
        house.visible = true;
        house.castShadow = true; // this building will cast shadows
        house.receiveShadow = true; // this building will receive shadows
        // other code to position and add the building to the scene



        // Set position (adjusted for coordinate system difference)
        house.position.set(i*6 , 0, j * 6);

        // Set scale
        house.scale.set(1, 1, -1);

        // Set rotation (adjusted for coordinate system difference)
        house.rotation.set(0, grid[i][j].chosen.ro * Math.PI / 2 , 0);

       
        // Add the house to the scene
        house.generatedBlock = true;
        scene.add(house);
      }
    }
  }
  
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
  // Get a list of objects to remove
  const objectsToRemove = scene.children.filter((object) => object.generatedBlock === true);

  // Remove each object from the scene
  objectsToRemove.forEach((object) => {
    scene.remove(object);
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
  let loader = new GLTFLoader();
  loader.load('./20230812_refactor.glb', function (gltf){
    gltf.scene.children.forEach((child) => {
        child.visible = false;
        // Store building blocks for future reference
        buildingBlocks[parseInt(child.name)] = child;
      });
    console.log('buildingBlocks: ', buildingBlocks)
    scene.add(gltf.scene);
    console.log(gltf.scene);
    manager.itemEnd('buildingBlocks');
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        // Enable casting and receiving shadows for the mesh
        child.castShadow = true;
        child.receiveShadow = true;
    
        // If you want to modify material properties, you can do so here
        // For example, if the material should be transparent
        if (child.material.transparent) {
          child.material.transparent = true;
          // Other material properties can be set here if needed
        }
      }
    });
    
  ;
});
}

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

