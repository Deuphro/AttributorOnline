import {PointGrid,affineFromBounds,scanNearest} from "./plot2d-hit.js"
const N=1000000
//exactement ce que fait plot2d-gl.js: deux plans remplis a la main, puis
//adoptees par seal(). C'est le chemin qui cassait.
const coordsU=new Float64Array(N)
const coordsV=new Float64Array(N)
let state=12345>>>0
const next=()=>{
    state^=state<<13; state>>>=0
    state^=state>>>17
    state^=state<<5; state>>>=0
    return state/4294967296
}
for(let i=0;i<N;i++){ coordsU[i]=next()*1000; coordsV[i]=next()*500 }
const t0=Date.now()
const grid=new PointGrid()
grid.seal(N,[0,N],coordsU,coordsV)
const build=Date.now()-t0
console.log(`build: ${build} ms, points=${grid.count}, mem=${(grid.memoryBytes()/1048576).toFixed(1)} Mo`)
//l'etendue a-t-elle ete lue dans les plans ?
console.log(`extent: u[${grid.extent.minU.toFixed(3)},${grid.extent.maxU.toFixed(3)}] v[${grid.extent.minV.toFixed(3)},${grid.extent.maxV.toFixed(3)}] inverseU=${grid._inverseU.toFixed(4)}`)
//une requete doit repondre, et vite
const proj=affineFromBounds({left:0,right:1000,top:500,bottom:0},800,400)
let hits=0
//performance.now() est en millisecondes fractionnaires: Date.now() ne
//donnerait que 0.0 us et trancherait la question par defaut
const t1=performance.now()
for(let k=0;k<100000;k++){
    const hit=grid.nearest(next()*800,next()*400,proj,9)
    if(hit) hits++
}
const query=(performance.now()-t1)/100000*1000
console.log(`requete: ${query.toFixed(2)} us, ${hits}/100000 touche(s)`)
//et le scan doitpondre pareil sur un sous-ensemble
const small=new PointGrid()
small.seal(5,[0,5],coordsU.subarray(0,5),coordsV.subarray(0,5))
const probe=referenceToPixelOf(proj,coordsU[3],coordsV[3])
console.log(`scan petit-N: ${scanNearest(small._coordsU,small._coordsV,5,probe.x,probe.y,proj,9)} (attendu 3)`)
function referenceToPixelOf(p,u,v){ return {x:p.u0+u*p.sx,y:p.v0+v*p.sy} }
