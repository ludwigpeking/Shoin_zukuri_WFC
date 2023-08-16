//I try to create a procedural 3D tree with three.js. the constructor should be: new PineTree(height, x, z), remember in three.js, the coordinate is y-up

//draw method:
// a trunk spawns from the ground, goes up the length, parameter * height * randomness, diameter is parameter2*height * randomness, then at the top, it becomes two branches, that does horizontal, the y axis rotation is random. but the two branch should rotate in opposite direction. the two branches has randomly distributed diameters, squared diameter of branch1 plus squared diameter of branch2 equals squared diameter of the trunk * 80%. the branch with larger diameter should turn from horizontal to upward sooner. the turn should be curvy. after all the weight of these branches should be balanced around the trunk they spawn from. when each branch reaches the end, it should recur new spawing of two branches, following the same rule. but when the branch become very small, like its diameter is smaller than 0.05. it does not spawn branches but grow a blob of leaves represented as a sphere, which should have green translucent material. the branches should be dark blow and opaque. the trunk should be dark brown and opaque. 
import * as THREE from 'three';

class PineTree {
    constructor(height, x, z, expansion = 0.5, slenderness = 50 , trunkRatio = 0.3) {
        this.height = height; //assumed total height of the tree, mostly 1.5m to 20m
        this.x = x;
        this.z = z;
        this.expansion = expansion; //branch horizontal expansion, 0.5 is normal
        this.slenderness = slenderness; //height thickness ratio, 50-80 is normal
        this.trunkRatio = trunkRatio; //trunk height ratio, 0.2-0.4 is normal

        this.woodMaterial = new THREE.MeshBasicMaterial({color: 0x654321}); // dark brown
        this.leafMaterial = new THREE.MeshBasicMaterial({color: 0x00FF00, transparent: true, opacity: 0.7}); // translucent green

        this.treeGroup = new THREE.Group();
        this.treeGroup.position.set(this.x, 0, this.z);

        this.generateTrunk();
    }

    generateTrunk() {

        //trunk height is 0.3 * height  * expansion and normal distribution
        const trunkHeight = this.trunkRatio * this.height * normalRandom(0.15)  //0.3 is the average trunk height ratio
        const trunkDiameter = this.height / 50 * normalRandom(0.15);
        const trunkGeometry = new THREE.CylinderGeometry(trunkDiameter/2, trunkDiameter/2, trunkHeight);
        const trunkMesh = new THREE.Mesh(trunkGeometry, this.woodMaterial);
        trunkMesh.position.y = trunkHeight/2;  // Adjust so trunk begins at y=0
        this.treeGroup.add(trunkMesh);
        // Generate branches at the top of the trunk
        this.generateBranches(this.x, trunkHeight, this.z, trunkDiameter, trunkHeight);
    }

    generateBranches(x, y, z, parentDiameter, parentLength) {
        if (parentDiameter < 0.05) {
            const leafGeometry = new THREE.SphereGeometry(parentDiameter*10, 4, 4);
            const leafMesh = new THREE.Mesh(leafGeometry, this.leafMaterial);
            leafMesh.position.set(x, y, z);
            this.treeGroup.add(leafMesh);
            return;
        }

        // Calculate diameters based on parent's diameter
        const branch1Diameter = Math.sqrt(0.8 * parentDiameter * parentDiameter * Math.random());
        const branch2Diameter = Math.sqrt(0.8 * parentDiameter * parentDiameter - branch1Diameter * branch1Diameter);

        // Random y-axis rotation
        const rotation1 = Math.random() * Math.PI;
        const rotation2 = -rotation1;  // Opposite direction

        // Create branches and position them
        // (For simplicity, just creating straight branches here. Curve logic can be added using Three.js curve or spline functionalities.)
        const length1 = branch1Diameter * this.slenderness * 0.5 * normalRandom(0.5);
        const shift1 = length1 * this.expansion * normalRandom(0.5);

        const prod = length1 * shift1 * branch1Diameter * branch1Diameter;
        // prod = length2 * shift2 * brach2Diameter * branch2Diameter;
        const length2 = prod / (shift1 * branch2Diameter * branch2Diameter);
        const shift2 = prod / (length1 * branch2Diameter * branch2Diameter);

        const angle1 = Math.atan(shift1 / length1);
        const angle2 = Math.atan(shift2 / length2);
        
        const branch1Geometry = new THREE.CylinderGeometry(branch1Diameter/2, branch1Diameter/2, length1);
        const branch1Mesh = new THREE.Mesh(branch1Geometry, this.woodMaterial);
  

        const branch2Geometry = new THREE.CylinderGeometry(branch2Diameter/2, branch2Diameter/2, length2);
        const branch2Mesh = new THREE.Mesh(branch2Geometry, this.woodMaterial);
        
        // Adjust position based on angle and length
branch1Mesh.position.y = y + parentLength + (length1 / 2) * Math.cos(angle1);
branch1Mesh.position.x = x + (length1 / 2) * Math.sin(angle1) * Math.sin(rotation1);
branch1Mesh.position.z = z + (length1 / 2) * Math.sin(angle1) * Math.cos(rotation1);

branch2Mesh.position.y = y + parentLength + (length2 / 2) * Math.cos(angle2);
branch2Mesh.position.x = x + (length2 / 2) * Math.sin(angle2) * Math.sin(rotation2);
branch2Mesh.position.z = z + (length2 / 2) * Math.sin(angle2) * Math.cos(rotation2);


        this.treeGroup.add(branch1Mesh);
        this.treeGroup.add(branch2Mesh);

        const tipX1 = x + length1 * Math.sin(angle1) * Math.sin(rotation1);
        const tipY1 = y + parentLength + length1 * Math.cos(angle1);
        const tipZ1 = z + length1 * Math.sin(angle1) * Math.cos(rotation1);
        
        const tipX2 = x + length2 * Math.sin(angle2) * Math.sin(rotation2);
        const tipY2 = y + parentLength + length2 * Math.cos(angle2);
        const tipZ2 = z + length2 * Math.sin(angle2) * Math.cos(rotation2);
        
        
        // Recur for child branches
        this.generateBranches(tipX1, tipY1, tipZ1, branch1Diameter, length1);
        this.generateBranches(tipX2, tipY2, tipZ2, branch2Diameter, length2);
}

    addToScene(scene) {
        scene.add(this.treeGroup);
    }
}

function normalRandom(standardDeviation) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return 1 + z0 * standardDeviation;
}

export default PineTree;