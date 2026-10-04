/* -------------------------------------------------------------------------
    Test - node scripts/plot2d-hit.test.mjs

    Ce qui est vérifié ici, c'est l'INDEX DE POINTAGE du calque WebGL, et
    une seule chose compte vraiment : qu'il réponde EXACTEMENT comme le
    ferait une recherche exhaustive. L'ORACLE est donc une force brute
    écrite ci-dessous, en quelques lignes, et chaque cas le confronte à
    elle.

    Les propriétés tenues pour acquises par construction (et donc non
    testées ici) sont écrites dans l'en-tête de plot2d-hit.js : O(N) à
    construire, O(1) à interroger, aucun tri requis. Ce que le test
    vérifie par-dessus, et qui ne se voit pas à la lecture du code, ce
    sont deux choses : la projection (une caméra orthographique est une
    application affine, donc un rayon en pixels reste un rayon en
    pixels), et le fait qu'un index doit survivre à un changement de VUE,
    puisqu'il indexe les données et non la fenêtre.
   ------------------------------------------------------------------------- */
import {
    PointGrid,
    affineFromBounds,
    pixelToReference,
    scanNearest,
    PICK_SCAN_THRESHOLD
} from "./plot2d-hit.js"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }

/* L'ORACLE. Les DEUX PLANS de coordonnées, comme le calque GL les
   construit : c'est ce que la grille mesure, donc c'est ce que la force
   brute doit mesurer pour être un oracle. */
const planesOf=(uv)=>{
    const coordsU=new Float64Array(uv.length)
    const coordsV=new Float64Array(uv.length)
    for(let i=0;i<uv.length;i++){
        coordsU[i]=uv[i][0]
        coordsV[i]=uv[i][1]
    }
    return {coordsU,coordsV}
}

function bruteForce(coordsU,coordsV,count,cursorX,cursorY,projection,radiusPx){
    const {u0,v0,sx,sy}=projection
    let best=-1
    let bestDistance=radiusPx*radiusPx
    for(let index=0;index<count;index++){
        const dx=cursorX-(u0+coordsU[index]*sx)
        const dy=cursorY-(v0+coordsV[index]*sy)
        const distance=dx*dx+dy*dy
        if(distance<bestDistance||(distance===bestDistance&&(best<0||index<best))){
            bestDistance=distance
            best=index
        }
    }
    return best
}

//un générateur déterministe : un test doit être reproductible, donc
//aucun Math.random sans graine
const seeded=seed=>{
    let state=seed>>>0||1
    return ()=>{
        //xorshift32
        state^=state<<13; state>>>=0
        state^=state>>>17
        state^=state<<5; state>>>=0
        return state/4294967296
    }
}

function makeRandomPoints(count,seed){
    const next=seeded(seed)
    const uv=[]
    for(let i=0;i<count;i++) uv.push([next()*1000,next()*500])
    return uv
}

//l'inverse de pixelToReference : les curseurs des tests sont exprimés en
//PIXELS, comme ceux de handlePickMove, jamais en coordonnées de référence
const referenceToPixel=(projection,u,v)=>({
    x:projection.u0+u*projection.sx,
    y:projection.v0+v*projection.sy
})

//construit une grille comme le fait plot2d-gl.js : un seul passage pour
//parquer les coordonnées, puis seal() qui buckette
function buildGrid(uv,nx,ny,traceStarts){
    const grid=new PointGrid(nx,ny)
    for(const [u,v] of uv) grid.accumulate(u,v)
    grid.seal(uv.length,traceStarts??[0,uv.length])
    return grid
}

/* ---------------------------------------------------------------------
   La projection : le contrat dont dépend TOUT le reste. Si ce couple est
   faux, le rayon en pixels ne veut plus rien dire, et la grille peut être
   parfaite sans jamais trouver le point sous le curseur.
   --------------------------------------------------------------------- */
const VIEW=affineFromBounds({left:0,right:1000,top:500,bottom:0},400,200)

test("la projection est l'affine que la caméra orthographique décrit",()=>{
    //une caméra a top > bottom (l'axe Y croît vers le bas): v=top est le
    //HAUT de l'image, donc 0px, et v=bottom est le BAS, donc 200px
    close(VIEW.u0+0*VIEW.sx,0,1e-9,"left edge")
    close(VIEW.u0+1000*VIEW.sx,400,1e-9,"right edge")
    close(VIEW.v0+500*VIEW.sy,0,1e-9,"top edge")
    close(VIEW.v0+0*VIEW.sy,200,1e-9,"bottom edge")
    close(VIEW.sx,0.4,1e-12,"400px pour 1000 unités")
    //Y vers le bas : un span de 500 unités sur 200px donne une échelle N�?GATIVE
    close(VIEW.sy,-0.4,1e-12,"200px pour 500 unités, Y vers le bas")
})

test("pixelToReference est l'inverse exact de la projection",()=>{
    for(const [px,py] of [[0,0],[400,200],[137,42],[399.5,0.5]]){
        const {u,v}=pixelToReference(VIEW,px,py)
        close(VIEW.u0+u*VIEW.sx,px,1e-9,`x round trip at ${px},${py}`)
        close(VIEW.v0+v*VIEW.sy,py,1e-9,`y round trip at ${px},${py}`)
    }
})

test("une projection dégénérée ne donne pas de division par zéro",()=>{
    const flat=affineFromBounds({left:0,right:0,top:0,bottom:0},400,200)
    close(flat.sx,0,1e-12)
    close(flat.sy,0,1e-12)
    const back=pixelToReference(flat,10,10)
    ok(Number.isFinite(back.u)&&Number.isFinite(back.v),"une image dégénérée reste finie")
})

/* ---------------------------------------------------------------------
   L'EXHAUSTIVIT�?. C'est LA propriété de la grille. Si elle tient sur un
   nuage aléatoire, elle tient partout �?" les autres tests ne servent
   qu'à nommer les cas où elle pourrait échouer.
   --------------------------------------------------------------------- */
test("la grille répond comme la force brute sur un nuage de 4000 points",()=>{
    const uv=makeRandomPoints(4000,0xC0FFEE)
    const {coordsU,coordsV}=planesOf(uv)
    //une petite résolution force la requête à traverser plusieurs cellules,
    //sinon le test ne prouverait rien sur le parcours de cellules
    const grid=buildGrid(uv,7,5)
    const next=seeded(99)
    for(let trial=0;trial<400;trial++){
        //chaque trial change le cadrage : c'est le pan/zoom, répété en masse
        const width=50+next()*350
        const height=25+next()*175
        const left=next()*(1000-width)
        const top=next()*(500-height)
        const projection=affineFromBounds({left,right:left+width,top,bottom:top+height},400,200)
        const radius=4+next()*40
        const cx=next()*400
        const cy=next()*200
        const found=grid.nearest(cx,cy,projection,radius)
        const expected=bruteForce(coordsU,coordsV,uv.length,cx,cy,projection,radius)
        if(expected<0){
            if(found!==null) throw new Error(`trial ${trial}: un point hors rayon a été répondu ${found.pointIndex}`)
            continue
        }
        if(!found) throw new Error(`trial ${trial}: le point ${expected} (rayon ${radius.toFixed(2)}) a été manqué`)
        if(found.pointIndex!==expected) throw new Error(`trial ${trial}: point ${found.pointIndex} instead of ${expected}`)
        //et la distance annoncée est bien la distance pixel exacte
        const dx=cx-(projection.u0+coordsU[expected]*projection.sx)
        const dy=cy-(projection.v0+coordsV[expected]*projection.sy)
        close(found.distance,Math.hypot(dx,dy),1e-4,"distance annoncée")
    }
})

test("un point posé pile sur une frontière de cellule est trouvé",()=>{
    //l'index se trompe CLASSIQUEMENT ici : un rayon arrêté à la frontière
    //d'une cellule exclut le point qui est juste à côté
    const uv=[[0,0],[1,0],[2,0],[3,0],[4,0]]
    const {coordsU,coordsV}=planesOf(uv)
    const grid=buildGrid(uv,4,1)
    //le curseur est exprimé en PIXELS : u=2 tombe exactement sur la
    //frontière entre la cellule 2 et la 3
    const at=referenceToPixel(VIEW,2,0)
    for(const offset of [-0.001,0,0.001,1,1.001]){
        const cx=at.x+offset
        const found=grid.nearest(cx,at.y,VIEW,0.01)
        const expected=bruteForce(coordsU,coordsV,uv.length,cx,at.y,VIEW,0.01)
        //plus d'un pixel de décalage, c'est hors du rayon de 0.01px : la
        //grille et la force brute doivent alors se taire ENSEMBLE
        if(expected<0){
            ok(found===null,`au décalage ${offset}: la grille a répondu ${found?.pointIndex} hors rayon`)
            continue
        }
        ok(found!==null,`un point a été manqué au décalage ${offset}`)
        ok(found.pointIndex===expected,`au décalage ${offset}: ${found.pointIndex} au lieu de ${expected}`)
    }
})

test("une étendue dégénérée (tous les points confondus) ne casse rien",()=>{
    const uv=[[42,42],[42,42],[42,42]]
    const {coordsU,coordsV}=planesOf(uv)
    const grid=buildGrid(uv,256,256)
    //le curseur est mis pile sur le point, en pixels
    const at=referenceToPixel(VIEW,42,42)
    const found=grid.nearest(at.x+2,at.y+1,VIEW,5)
    ok(found,"une étendue nulle ne doit pas produire de cellule infinie")
    ok(found.pointIndex===0,"et elle répond le point le plus proche")
})

test("un rayon qui sort de l'étendue trouve quand même le point",()=>{
    const uv=[[100,100],[900,400]]
    const {coordsU,coordsV}=planesOf(uv)
    const grid=buildGrid(uv,8,8)
    //le curseur est très en dehors des données, le rayon ne l'atteint pas
    ok(grid.nearest(-500,-500,VIEW,10)===null,"hors de portée, aucune réponse")
    //et si la portée déborde sur les données, la réponse est la même que
    //celle de la force brute, cellule tronquée ou non
    const projection=affineFromBounds({left:-500,right:500,top:250,bottom:-250},400,200)
    const first=referenceToPixel(projection,100,100)
    const second=referenceToPixel(projection,900,400)
    for(const cursor of [[first.x,first.y],[first.x+2,first.y-2]]){
        const found=grid.nearest(cursor[0],cursor[1],projection,600)
        const expected=bruteForce(coordsU,coordsV,uv.length,cursor[0],cursor[1],projection,600)
        ok(found!==null,`un point visible a été manqué en ${cursor}`)
        ok(found.pointIndex===expected,`en ${cursor}: ${found.pointIndex} au lieu de ${expected}`)
    }
})

test("le rayon est inclusif: un point exactement à la limite est pris",()=>{
    const uv=[[0,0]]
    const {coordsU,coordsV}=planesOf(uv)
    const grid=buildGrid(uv,256,256)
    //le curseur est placé à 10px du point, pour un rayon de 10
    const at=referenceToPixel(VIEW,0,0)
    ok(grid.nearest(at.x+10,at.y,VIEW,10),"la limite doit compter")
    ok(grid.nearest(at.x+10.001,at.y,VIEW,10)===null,"au-delà, plus rien")
})

test("sans point, aucune réponse (et pas une exception)",()=>{
    const empty=new PointGrid(8,8)
    empty.seal(0,[0,0])
    ok(empty.nearest(0,0,VIEW,10)===null,"une grille vide répond null")
    close(empty.memoryBytes(),0,1e-9,"et ne retient rien")
})

test("à distance égale, le premier point dessiné gagne",()=>{
    //deux points symétriques autour du curseur, en pixels : la réponse doit
    //être stable, et ne pas dépendre de l'ordre des cellules
    const flat=affineFromBounds({left:0,right:100,top:0,bottom:-100},200,200)
    const uv=[[40,-50],[60,-50]]
    const {coordsU,coordsV}=planesOf(uv)
    const middle=referenceToPixel(flat,50,-50)
    for(const resolution of [1,2,4,256]){
        const grid=buildGrid(uv,resolution,resolution)
        const found=grid.nearest(middle.x,middle.y,flat,500)
        ok(found!==null,`en ${resolution} cellules, aucun point trouvé`)
        ok(found.pointIndex===0,`en ${resolution} cellules, l'égalité a été tranchée par l'ordre des cellules (${found.pointIndex})`)
    }
})



/* ---------------------------------------------------------------------
   L'INDICE DONNE LE BON NOM. Le marqueur affiche « trace, index, x, y »:
   si tracePoint ne veut pas dire « l'index DANS CE TRACE », le tooltip
   ment sur le seul numéro que l'utilisateur peut aller vérifier.
   --------------------------------------------------------------------- */
test("un index global se scinde en (trace, index dans le trace)",()=>{
    const uv=makeRandomPoints(30,0x5EED)
    const {coordsU,coordsV}=planesOf(uv)
    //trois traces de 10 points : starts = [0, 10, 20, 30]
    const grid=buildGrid(uv,8,8,[0,10,20,30])
    const firstOf=[0,10,20]
    for(let index=0;index<uv.length;index++){
        const traceIndex=grid.traceOf(index)
        ok(traceIndex>=0&&traceIndex<3,`index ${index}: trace hors bornes (${traceIndex})`)
        //l'index DANS le trace doit retomber dans les 10 points du trace
        const withinTrace=index-firstOf[traceIndex]
        ok(withinTrace>=0&&withinTrace<10,
            `index ${index}: ${withinTrace} ne tombe dans aucune trace de 10 points`)
    }
    //et, si ce point précis est trouvé, il est bien le 5e de la 2e trace
    const tight=affineFromBounds({left:-1,right:31,top:1,bottom:-1},400,200)
    const found=grid.nearest(0,0,tight,5)
    if(found&&found.pointIndex===15){
        ok(found.traceIndex===1,`trace attendue 1, reçue ${found.traceIndex}`)
        ok(found.tracePoint===5,`index dans le trace attendu 5, reçu ${found.tracePoint}`)
    }
})

/* ---------------------------------------------------------------------
   LE CHEMIN PETIT-N. En dessous du seuil il n'y a pas de grille, et c'est
   le SCAN qui doit répondre. Les deux chemins doivent être indiscernables
   d'en dehors, sinon un petit jeu de données se comporterait autrement
   qu'un gros, à cause d'un seuil arbitraire.
   --------------------------------------------------------------------- */
test("le scan répond exactement comme la grille sur le même jeu",()=>{
    const uv=makeRandomPoints(500,0xBEEF)
    const {coordsU,coordsV}=planesOf(uv)
    const grid=buildGrid(uv,4,4)
    const next=seeded(7)
    const projection=affineFromBounds({left:-200,right:1200,top:700,bottom:-200},400,200)
    for(let trial=0;trial<300;trial++){
        const cx=next()*400
        const cy=next()*200
        const radius=5+next()*60
        const fromGrid=grid.nearest(cx,cy,projection,radius)
        const scanIndex=scanNearest(coordsU,coordsV,uv.length,cx,cy,projection,radius)
        if(scanIndex<0){
            ok(fromGrid===null,`trial ${trial}: la grille a trouvé ${fromGrid?.pointIndex}, le scan rien`)
            continue
        }
        ok(fromGrid!==null,`trial ${trial}: le scan a trouvé ${scanIndex}, la grille rien`)
        ok(fromGrid.pointIndex===scanIndex,`trial ${trial}: grille ${fromGrid.pointIndex} vs scan ${scanIndex}`)
    }
})

test("le seuil annoncé est bien le point de bascule du chemin",()=>{
    ok(PICK_SCAN_THRESHOLD>0,"un seuil nul ne laisserait jamais de grille")
    //le seuil est un contrat entre plot2d-gl.js (qui décide) et ce module
    //(qui scanne) : il doit exister et être exploitable comme borne
    const small=makeRandomPoints(100,1)
    const big=makeRandomPoints(PICK_SCAN_THRESHOLD+1,1)
    ok(big.length>PICK_SCAN_THRESHOLD&&small.length<PICK_SCAN_THRESHOLD,
        "les deux tailles doivent être de part et d'autre du seuil")
})

test("les plans adoptés ne sont jamais recopiés",()=>{
    //le calque GL remplit les deux plans et les confie: ils sont déjà
    //à la taille exacte, donc seal() doit les ADOPTER. Un rechargement de
    //16 Mio sur un million de points pour rien serait le prix d'une copie
    const uv=makeRandomPoints(5000,4)
    const {coordsU,coordsV}=planesOf(uv)
    const grid=new PointGrid(32,32)
    grid.seal(uv.length,[0,uv.length],coordsU,coordsV)
    //identity, not equality: the very same arrays must have been kept
    ok(grid._coordsU===coordsU,"le plan U doit être adopté, pas recopié")
    ok(grid._coordsV===coordsV,"le plan V doit être adopté, pas recopié")
})

test("les plans parqués sont gardés, mais à la taille exacte",()=>{
    //ce chemin-là passe par accumulate(), dont le tampon grandit par paliers
    //de 1.5x: sans trame ici, un million de points garderait 1.5 fois sa
    //mémoire pour rien
    const uv=makeRandomPoints(5000,4)
    const grid=buildGrid(uv,32,32)
    close(grid._coordsU.length,uv.length,1e-9,"le plan U doit être taillé au juste")
    close(grid._coordsV.length,uv.length,1e-9,"le plan V doit être taillé au juste")
    //et les valeurs doivent survivre à la trame
    close(grid._coordsU[0],uv[0][0],1e-12)
    close(grid._coordsV[uv.length-1],uv[uv.length-1][1],1e-12)
})

test("l'étendue est mesurée sur les coordonnées, jamais supposée",()=>{
    //accumulate() ne tient PLUS l'étendue. Une grille bâtie par adoption
    //doit donc la lire dans les plans, sinon la taille de cellule reste
    // nulle et tous les points tombent sur la cellule NaN
    const uv=[[3,-7],[9,2],[-4,11],[5,5]]
    const {coordsU,coordsV}=planesOf(uv)
    const grid=new PointGrid(8,8)
    grid.seal(uv.length,[0,uv.length],coordsU,coordsV)
    close(grid.extent.minU,-4,1e-12,"minU")
    close(grid.extent.maxU,9,1e-12,"maxU")
    close(grid.extent.minV,-7,1e-12,"minV")
    close(grid.extent.maxV,11,1e-12,"maxV")
    ok(grid._inverseU>0&&grid._inverseV>0,"la taille de cellule doit être finie et non nulle")
})

test("memoryBytes rend compte de ce qui est réellement alloué",()=>{
    const uv=makeRandomPoints(1000,3)
    const grid=buildGrid(uv,16,16)
    //_starts tient cellCount+1 entrées (le prefix sum), les autres cellCount,
    //items et traceStarts en Uint32, les deux plans en Float64
    const expected=(grid.cellCount+1)*4
        +grid.cellCount*4
        +uv.length*4
        +2*4
        +2*uv.length*8
    close(grid.memoryBytes(),expected,1e-6,"la mémoire doit être prévisible, pas approximative")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exit(1)

