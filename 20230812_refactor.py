import bpy
import random
import mathutils
import math

cols = 8
rows = 8
grid = []
unsolved = []
#random.seed(0)

building_collection = bpy.data.collections.get("building")
# Check if the building collection exists
#if building_collection:
    # Hide the building collection
#    building_collection.hide_viewport = True
objs_to_delete = [obj for obj in bpy.context.scene.objects if building_collection not in obj.users_collection]
bpy.ops.object.select_all(action='DESELECT') # Deselect all objects
for obj in objs_to_delete:
    obj.select_set(True) # Select objects outside the building collection
bpy.ops.object.delete() # Delete selected objects

scheme_collection = bpy.data.collections.get("scheme")
if scheme_collection is None:
    scheme_collection = bpy.data.collections.new("scheme")
    bpy.context.scene.collection.children.link(scheme_collection)

class Tile:
    def __init__(self, index, num, edges):
        self.index = index
        self.ro = num
        self.edges = edges
        self.up = []
        self.right = []
        self.down = []
        self.left = []
    def analyze(self, tiles):       
        for i in range(len(tiles)):          
            # UP
            if compareEdge(tiles[i].edges[2], self.edges[0]) :
                self.up.append(tiles[i])
            # RIGHT
            if compareEdge(tiles[i].edges[3], self.edges[1]) :
                self.right.append(tiles[i])          
            # DOWN
            if compareEdge(tiles[i].edges[0], self.edges[2]) :
                self.down.append(tiles[i])         
            # LEFT
            if compareEdge(tiles[i].edges[1], self.edges[3]):
                self.left.append(tiles[i])
    def rotate(self, num) :
        #Rotate edges
        newEdges = self.edges.copy()
        for i in range(4) :
            newEdges[i] = self.edges[(i - num + 4) % 4]
        return Tile(self.index, num, newEdges)
    
class Cell:
    def __init__(self, i, j, tiles):
        self.i = i
        self.j = j
        self.collapsed = False
        self.options = tiles.copy()
        
        #self.chosen = null
    def checkNeighbors(self,grid):
  
        if self.j< rows -1:
            up = grid[self.i][self.j + 1]
            if up.collapsed == False:
                up.options = checkValid(up.options, self.chosen.up)
        if self.i < cols - 1:
            right = grid[self.i + 1][self.j]      
            if right.collapsed == False:
                right.options=checkValid(right.options, self.chosen.right)
        if self.j >0 :
            down = grid[self.i][self.j-1]      
            if down.collapsed == False:
                down.options=checkValid(down.options, self.chosen.down) 
        if self.i > 0:
            left = grid[self.i -1][self.j]
            if left.collapsed == False:
                left.options = checkValid(left.options, self.chosen.left)        

def reverseString(s):
  return s[::-1]

def compareEdge(a, b):
    if (a == "UUU" and b == "DDD") :
        return True
    elif (a == "DDD" and b == "UUU") :
        return True
    elif (a == "DDD" and b == "DDD") :
        return False
    # elif (a == "UUU" and b == "UUU") :
    #     return False
#    elif (a == "C3C" and b == "C3C") :
#        return False
    elif (a == "C3C" and b == "232") :
        return True
    elif (a == "232" and b == "C3C") :
        return True
    elif (a == "232" and b == "C32") :
        return True
    #elif (a == "232" and b == "222") :
        #return True
    #elif (a == "222" and b == "232") :
        #return True
    elif (a == "C32" and b == "232") :
        return True
#    elif (a == "C34" and b == "43C") :
#        return False
#    elif (a == "43C" and b == "C34") :
#        return False
    elif (a == "C34" and b == "432") :
        return True
    elif (a == "432" and b == "C34") :
        return True
    elif (a == "43C" and b == "234") :
        return True
    elif (a == "234" and b == "43C") :
        return True
#    elif (a == "23C" and b == "C32") :
#        return False
#    elif (a == "C32" and b == "23C") :
#        return False
    elif (a == "PPP" and b == "UUU") :
        return True
    elif (a == "UUU" and b == "PPP") :
        return True
    else :
        return a == reverseString(b)
    
def startOver():
    unsolved = [];
    grid = [];
    
    
  # Create cell for each spot on the grid
    for i in range(cols): 
        grid.append([])
        for j in range(rows): 
            grid[i].append(Cell(i, j, tiles))         
    for i in range(cols):   
        for j in range(rows):   
            if i==3 and j==3:
                grid[i][j].chosen = tiles[23]
                grid[i][j].collapsed = True
                grid[i][j].checkNeighbors(grid)
            elif i == 0 or i == cols-1 or j == 0 or j == rows-1:
                grid[i][j].chosen = tiles[0]
                grid[i][j].collapsed = True
                grid[i][j].checkNeighbors(grid)
#            elif i == 2 and j == 2:
#                grid[i][j].chosen = tiles[24]
#                grid[i][j].collapsed = True
#                grid[i][j].checkNeighbors(grid)
            else:
              unsolved.append(grid[i][j])
    collapse(unsolved,grid)
    
def collapse(unsolved,grid):
    while len(unsolved) > 0:
        unsolved.sort(key=lambda x: len(x.options), reverse=False)
        if len(unsolved[0].options) == 0: 
            startOver()
            break
        else:
            #collapse
            chosen = random.choice(unsolved[0].options);
            unsolved[0].chosen = chosen
            unsolved[0].collapsed = True
            unsolved[0].checkNeighbors(grid)
            unsolved.pop(0);
    if len(unsolved) ==0:
        for i in range(cols):
            for j in range(rows):    
                #blender building
                mesh_data = bpy.data.meshes[str(grid[i][j].chosen.index)]
                house = bpy.data.objects.new('house', mesh_data)
                house.location = (i * 6, j * 6 ,0)
                house.scale = (1,1,1)
                house.rotation_mode = 'XYZ'
                house.rotation_euler = (0,0,-grid[i][j].chosen.ro* math.pi/2 )
                scheme_collection.objects.link(house)    
    return
            
def checkValid(arr, valid):
    for i in range(len(arr)-1, -1, -1):
        element = arr[i]
        if element not in valid:
            arr.pop(i)
    return arr

# Create and label the tiles
tiles = [
Tile(0, 0, ["000", "000", "000", "000"]),
Tile(1, 0, ["DDD", "DDD", "DDD", "DDD"]),
Tile(2, 0, ["C3C", "C3C", "C3C", "C3C"]),
Tile(3, 0, ["NNN", "NNN", "NNN", "NNN"]),
Tile(4, 0, ["C3C", "C3C", "C3C", "C3C"]),
Tile(5, 0, ["NNN", "NNN", "NNN", "NNN"]),

Tile(6, 0, ["232", "DDD", "232", "DDD"]),

Tile(7, 0, ["012", "UUU", "210", "000"]),
Tile(8, 0, ["012", "PPP", "210", "000"]),
Tile(9, 0, ["012", "210", "000", "000"]),
Tile(10, 0, ["UUU", "UUU", "210", "012"]),
Tile(11, 0, ["PPP", "PPP", "210", "012"]),
Tile(12, 0, ["PPP", "UUU", "210", "012"]),
Tile(13, 0, ["UUU", "PPP", "210", "012"]),
Tile(14, 0, ["234", "444", "432", "DDD"]),
Tile(15, 0, ["234", "432", "DDD", "DDD"]),
Tile(16, 0, ["444", "444", "43C", "C34"]),
Tile(17, 0, ["23C", "C3C", "C32", "DDD"]),
Tile(18, 0, ["DDD", "232", "DDD", "DDD"]),
Tile(19, 0, ["DDD", "232", "DDD", "DDD"]),
Tile(20, 0, ["234", "43C", "C32", "DDD"]),
Tile(21, 0, ["432", "DDD", "23C", "C34"]),
Tile(22, 0, ["DDD", "DDD", "23C", "C32"]),
Tile(23, 0, ["2T4", "4T2", "DDD", "DDD"]),

Tile(24, 0, ["N00", "000", "000", "00N"]),
Tile(25, 0, ["NNN", "N00", "00N", "NNN"]),
Tile(26, 0, ["N00", "000", "00N", "NNN"]),
Tile(27, 0, ["N00", "000", "00N", "NBN"]),
Tile(28, 0, ["N00", "00N", "N00", "00N"]),
Tile(29, 0, ["N00", "00N", "N00", "00N"]),
Tile(30, 0, ["00N", "NBN", "NNN", "N00"]),
Tile(31, 0, ["N00", "00N", "NNN", "NBN"])]

#  add rotate tiles 
tiles.append(tiles[6].rotate(1))
# rotate tiles, add all 3 other directions  
for i in range(7,32):
    for j in range(1,4):
        tiles.append(tiles[i].rotate(j))
        
for p in range(len(tiles)):
 
    tiles[p].analyze(tiles)


startOver() # does everything

