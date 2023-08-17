//I try to create a procedural 3D tree with three.js. the constructor should be: new PineTree(height, x, z), remember in three.js, the coordinate is y-up

//draw method:
// a trunk spawns from the ground, goes up the length, parameter * height * randomness, diameter is parameter2*height * randomness, then at the top, it becomes two branches, that does horizontal, the y axis rotation is random. but the two branch should rotate in opposite direction. the two branches has randomly distributed diameters, squared diameter of branch1 plus squared diameter of branch2 equals squared diameter of the trunk * 80%. the branch with larger diameter should turn from horizontal to upward sooner. the turn should be curvy. after all the weight of these branches should be balanced around the trunk they spawn from. when each branch reaches the end, it should recur new spawing of two branches, following the same rule. but when the branch become very small, like its diameter is smaller than 0.05. it does not spawn branches but grow a blob of leaves represented as a sphere, which should have green translucent material. the branches should be dark blow and opaque. the trunk should be dark brown and opaque. 
import * as THREE from 'three';

class PineTree {
    constructor(height, x, z, expansion = 1, slenderness = 30 , trunkRatio = 0.2) {
        // console.log("tree total height", height, "tree x", x, "tree z", z, "expansion", expansion, "slenderness", slenderness, "trunkRatio", trunkRatio)
        this.height = height; //assumed total height of the tree, mostly 1.5m to 20m
        this.x = x;
        this.z = z;
        this.expansion = expansion; //branch horizontal expansion, 0.5 is normal
        this.slenderness = slenderness; //height thickness ratio, 50-80 is normal
        this.trunkRatio = trunkRatio; //trunk height ratio, 0.2-0.4 is normal

        this.woodMaterial = new THREE.MeshBasicMaterial({color: 0x332211}); // dark brown
        this.leafMaterial = new THREE.MeshPhongMaterial({
            color: 0x337711,
            // shininess: 10,
            // specular: 0x447722,
            // emissive: 0x112200
        });
        
        this.treeGroup = new THREE.Group();
        this.treeGroup.position.set(this.x, 0, this.z);
        this.level = 0;
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
        // console.log("trunk height: " + trunkHeight.toFixed(2) + " trunk diameter: " + trunkDiameter.toFixed(2))
        this.level += 1;
        // Generate branches at the top of the trunk
        this.generateBranches(0, trunkHeight, 0, trunkDiameter, trunkHeight);

       
    }

    generateBranches(startX, startY, startZ, parentDiameter, parentLength) {
        if (parentDiameter < 0.1) {
            const leafGeometry = new THREE.SphereGeometry(parentDiameter*30, 6, 6);
            const leafMesh = new THREE.Mesh(leafGeometry, this.leafMaterial);
            leafMesh.position.set(startX, startY, startZ);
            leafMesh.scale.set(1, 0.3, 1);
            this.treeGroup.add(leafMesh);
            return;
        } else {

            let pivot1 = new THREE.Object3D();
            let pivot2 = new THREE.Object3D();
            
            // Add the pivots to the tree group
            this.treeGroup.add(pivot1);
            this.treeGroup.add(pivot2);
            // Set the position of the pivots
            pivot1.position.set(startX, startY, startZ);
            pivot2.position.set(startX, startY, startZ);
        
            // Calculate diameters based on parent's diameter
            const d1 = Math.sqrt(0.9 * parentDiameter * parentDiameter * (Math.random()));
            // const d1 = Math.sqrt(0.9 * parentDiameter * parentDiameter /2);
            const d2 = Math.sqrt(0.9 * parentDiameter * parentDiameter - d1 * d1);
        
            // Random y-axis rotation
            const rotationY1 = Math.random() * Math.PI;
            const rotationY2 = rotationY1;  // Opposite direction
            const l1 = d1 * this.slenderness * 0.5 ;
            const s1 = l1 * this.expansion ;
            // const l1 = d1 * this.slenderness * 0.5 * normalRandom(0.1);
            // const s1 = l1 * this.expansion * normalRandom(0.1);
        
            const prod = l1 * s1 * d1 * d1;
            const l2 = Math.sqrt(prod/(d2 * this.expansion));
            
            const s2 = d1 *d1 * l1 * s1 / (d2 * d2 * l2);
            // console.log(" d1 ", d1, " d2 ", d2, " l1 ", l1, " l2 ", l2, " s1 ", s1, " s2 ", prod)
            const rotationZ1 = Math.atan(s1 / l1); 
            const rotationZ2 = -Math.atan (s2 / l2);
            
            let changingWoodMaterial = new THREE.MeshBasicMaterial({color: 0x654321}); // dark brown
            let hsl = new THREE.Color(this.woodMaterial.color.getHex()).getHSL({});
            hsl.h = hsl.h+  this.level * 0.02;
            // console.log(hsl);
            let newColor = new THREE.Color().setHSL(hsl.h, 100, hsl.l);
            changingWoodMaterial.color = newColor;    
            const branch1Geometry = new THREE.CylinderGeometry(d1/2, d1/2, l1);
            const branch1Mesh = new THREE.Mesh(branch1Geometry, changingWoodMaterial);
            const branch2Geometry = new THREE.CylinderGeometry(d2/2, d2/2, l2);
            const branch2Mesh = new THREE.Mesh(branch2Geometry, changingWoodMaterial);
            
            // Adjust the position of the branches within their respective pivots
            branch1Mesh.position.y = l1 / 2;
            // console.log("branch1Mesh original position", branch1Mesh.position )
            branch2Mesh.position.y = l2 / 2;
            
            // Add the branches to their respective pivots
            pivot1.add(branch1Mesh);
            // console.log("branch1Mesh relative position in pivot", branch1Mesh.position )
            // console.log("pivot position", pivot1.position);
            pivot2.add(branch2Mesh);
            
            // Apply rotations to the pivots
            pivot1.rotation.z = rotationZ1;
            pivot1.rotation.y = rotationY1;
            
            pivot2.rotation.z = rotationZ2;
            pivot2.rotation.y = rotationY2;
            
            // Calculate the world coordinates for the tips of the branches
            let tipLocalPosition1 = new THREE.Vector3(0, l1, 0);
            
            let tipLocalPosition2 = new THREE.Vector3(0, l2, 0);

            pivot1.updateMatrixWorld();
            let tipWorldPosition1 = tipLocalPosition1.applyMatrix4(pivot1.matrixWorld);

            pivot2.updateMatrixWorld();
            let tipWorldPosition2 = tipLocalPosition2.applyMatrix4(pivot2.matrixWorld);

            this.level += 1;

            // console.log(" level: " + this.level)
            // console.log(" branch 1 start point:" + startX.toFixed(2) +", "+ startY.toFixed(2) +", "+ startZ.toFixed(2)+", " + " branch1 length: " + l1.toFixed(2) + " branch1 diameter: " + d1.toFixed(2)  + " branch1 tip position: " + tipWorldPosition1.x.toFixed(2) +", " + tipWorldPosition1.y.toFixed(2) +", " + tipWorldPosition1.z.toFixed(2));
            // console.log("branch 2 start point:" + startX.toFixed(2) +", "+ startY.toFixed(2) +", "+ startZ.toFixed(2) +", "+ " branch2 length: " + l2.toFixed(2) + " branch2 diameter: " + d2.toFixed(2)  + " branch2 tip position: " + tipWorldPosition2.x.toFixed(2) +", " + tipWorldPosition2.y.toFixed(2) +", " + tipWorldPosition2.z.toFixed(2));
            
            // Recursively generate branches
            this.generateBranches(tipWorldPosition1.x, tipWorldPosition1.y, tipWorldPosition1.z, d1, l1);
            this.generateBranches(tipWorldPosition2.x, tipWorldPosition2.y, tipWorldPosition2.z, d2, l2);
        
        }
    }
    
    addToScene(scene) {
        scene.add(this.treeGroup);
        this.treeGroup.generated = true;
    }
}

function normalRandom(standardDeviation) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return 1 + z0 * standardDeviation;
}

export default PineTree;