import {CE,DC} from "../util.js"
import {Wave} from "../formats.js"
import {SortedPoints} from "../attribution.js"

/* classifier: a line through the origin, death = slope × birth. Superlevel
   pairs live strictly below the diagonal (death < birth), so the slope is
   clamped into [MIN, MAX], with MAX just below 1. */
export const CLASSIFIER_MIN_SLOPE=1e-12
export const CLASSIFIER_MAX_SLOPE=1-1e-6
export function clampClassifierSlope(value){
    if(Number.isNaN(value)) return CLASSIFIER_MAX_SLOPE
    return Math.min(CLASSIFIER_MAX_SLOPE,Math.max(CLASSIFIER_MIN_SLOPE,value))
}
//6 significant digits: meaningful for slopes just below 1, unlike toFixed(3)
export function formatSlope(value){
    return String(Number(Number(value).toPrecision(6)))
}
//The 3σ convention, and the value the kernel returns when it has no population
//to read a z from. Named because "3" appears as a DEFAULT in three places that
//have to agree, and a literal in each of them is how they drift apart.
export const CONVENTIONAL_Z=3
//slope of a line that keeps every pair with a positive birth (birth ≤ 0
//pairs can never sit under a line through the origin)
export function keepAllSlope(pairs){
    let slope=CLASSIFIER_MIN_SLOPE
    for(const pair of pairs){
        if(!(pair.birth>0)) continue
        const ratio=pair.death/pair.birth
        if(Number.isFinite(ratio)&&ratio>slope) slope=ratio
    }
    return clampClassifierSlope(slope)
}
export function keepAllSlopeFromFlat(births,deaths){
    let slope=CLASSIFIER_MIN_SLOPE
    for(let i=0;i<births.length;i++){
        if(!(births[i]>0)) continue
        const ratio=deaths[i]/births[i]
        if(Number.isFinite(ratio)&&ratio>slope) slope=ratio
    }
    return clampClassifierSlope(slope)
}
//Liang-Barsky: the segment of an infinite line inside the rect, or null
export function clipSegmentToRect(x0,y0,x1,y1,width,height){
    let t0=0
    let t1=1
    const dx=x1-x0
    const dy=y1-y0
    const p=[-dx,dx,-dy,dy]
    const q=[x0,width-x0,y0,height-y0]
    for(let i=0;i<4;i++){
        if(p[i]===0){
            if(q[i]<0) return null
            continue
        }
        const r=q[i]/p[i]
        if(p[i]<0){
            if(r>t1) return null
            if(r>t0) t0=r
        }else{
            if(r<t0) return null
            if(r<t1) t1=r
        }
    }
    return [x0+t0*dx,y0+t0*dy,x0+t1*dx,y0+t1*dy]
}

/* The two decisions the classifier's result carries into the width stage, as
   PURE functions of that result — so the interactive path and the multiplexed
   one cannot answer them differently.

   `publishedPeakY` is the Y column a classified peak is PUBLISHED with: the
   integrated mass when the kernel gave one, the chief's intensity when it did
   not. A stale pkg build that supplies no mass must not look like a peak of
   area zero, hence the explicit fallback.

   `massThroughMask` walks that mass with the anti-radio mask: the filter DROPS
   peaks, so its result is SHORTER than the array it was given, and the mass has
   to be cut by the SAME mask or the two columns stop lining up — the area of
   one peak under the x of another, which is worse than no area at all. `isRadio`
   is that mask (1 = dropped) and it is aligned with the INPUT arrays. */
export function publishedPeakY(classification){
    const keptMass=classification.keptIntegratedMass
    const keptX=classification.keptPointsX
    const hasMass=keptMass&&keptMass.length===keptX.length
        &&keptMass.every(value=>Number.isFinite(value))
    return hasMass?keptMass:classification.keptPointsY
}
export function massThroughMask(keptMass,mask,length){
    if(!keptMass||!mask||keptMass.length!==length) return null
    return Float64Array.from(mask.reduce((acc,dropped,i)=>{
        if(!dropped) acc.push(keptMass[i])
        return acc
    },[]))
}

/* -----------------------------------------------------------------
   Trimmer method registry. Methods are DATA, not code branches: the node
   asks the registry for the list, for the fields to render, and for the
   hint, so adding one later touches nothing in the shell. Where the method
   places the cursors is the KERNEL's job (trim.rs), not the shell's: a
   ratio invented here would silently override it.
   ---------------------------------------------------------------- */
//3 significant digits for a cursor position. toPrecision already switches to
//scientific notation once the exponent reaches the precision, so 100000
//renders as 1.00e+5 with no extra branching, and parseFloat reads it back.
export const formatCursorValue=(value)=>{
    const numeric=Number(value)
    if(!Number.isFinite(numeric)) return ""
    return numeric===0?"0":numeric.toPrecision(3)
}

//A two-state scale switch whose TWO labels are always visible and the active one
//is simply coloured. The previous version rewrote the button text instead, which
//made the control jump and left the user guessing what the other state was
//called. Trimmer and PersistentHomology0D share the shape, not the labels.
export function scaleToggle({get,set,leftLabel,rightLabel,title}){
    //one contiguous control, not two floating buttons: the border and the radius
    //live on the wrapper so the two halves read as a single object
    const wrap=CE("span",{
        title,
        style:{
            display:"inline-flex",
            border:"1px solid rgba(255,255,255,0.18)",
            borderRadius:"4px",
            overflow:"hidden"
        }
    },[])
    const paint=()=>{
        const on=get()
        for(const [button,isOn] of [[left,!on],[right,on]]){
            //the active side carries the accent, the other recedes
            button.style.color=isOn?"#c9e02b":"rgba(255,255,255,0.45)"
            button.style.background=isOn?"rgba(201,224,43,0.14)":"transparent"
        }
    }
    const make=(label,value)=>{
        const button=CE("button",{
            type:"button",
            style:{cursor:"pointer",padding:"2px 7px",borderRadius:"0",border:"none",font:"inherit"}
        },[label])
        button.addEventListener("click",()=>{
            set(value)
            paint()
        })
        return button
    }
    const left=make(leftLabel,false)
    const right=make(rightLabel,true)
    wrap.append(left,right)
    paint()
    wrap.paint=paint
    return wrap
}
/* The SAME control with as many positions as the question has answers, for the
   cases where two is a lie: the collection reader's list can be read as
   formulae, as molecules or as measured peaks, and a two-state switch cannot
   name the third without renaming the other two.

   `get` answers the CURRENT position and `set` takes one of `states`. The
   comparison is `===` on the values, not on a boolean, so the positions must be
   given distinct values — three strings, or three numbers, never two `true`s. */
export function segmentToggle({get,set,states,title}){
    const wrap=CE("span",{
        title,
        style:{
            display:"inline-flex",
            border:"1px solid rgba(255,255,255,0.18)",
            borderRadius:"4px",
            overflow:"hidden"
        }
    },[])
    const paint=()=>{
        const current=get()
        for(const [button,state] of pairs){
            const on=state===current
            //the active position carries the accent, the others recede
            button.style.color=on?"#c9e02b":"rgba(255,255,255,0.45)"
            button.style.background=on?"rgba(201,224,43,0.14)":"transparent"
        }
    }
    const pairs=states.map(({label,value})=>{
        const button=CE("button",{
            type:"button",
            style:{cursor:"pointer",padding:"2px 7px",borderRadius:"0",border:"none",font:"inherit"}
        },[label])
        button.addEventListener("click",()=>{
            set(value)
            paint()
        })
        return [button,value]
    })
    for(const [button] of pairs) wrap.appendChild(button)
    paint()
    wrap.paint=paint
    return wrap
}

/* -----------------------------------------------------------------
   THE INPUT SYNAPSE, READ ONCE.

   `Flow.parentSynapse` leaves Map<parent, Array<Array<Wave>>> on every
   input anchor: one inner array per LINK, each holding the waves its
   output slot carried. Three levels is not a design choice, it is the
   shape the synapse leaves, and reading it at the wrong depth yields a
   value quietly missing one level — so the walk is written once, here.

   Several links may land on the SAME anchor, and ONE link may carry
   SEVERAL waves. To a reader those are the same thing — the multiplex
   this shell is built for — so neither is merged and neither is
   dropped: the caller receives them all, in link order, and decides for
   itself what a value it cannot use means.

   FOUR nodes read that shape (F-KMD, Attribution, Trimmer, Peak
   picking) and four copies of a three-level walk is four places for the
   depth to be wrong in.
   ---------------------------------------------------------------- */
export function wavesFromInput(input){
    const waves=[]
    let skipped=0
    if(input instanceof Map){
        for(const values of input.values()){
            for(const linkOutputs of values instanceof Array?values:[values]){
                for(const value of linkOutputs instanceof Array?linkOutputs:[linkOutputs]){
                    if(value instanceof Wave){
                        waves.push(value)
                    }else{
                        //COUNTED, never dropped: a node that silently forgot
                        //two spectra out of three looks exactly like a node
                        //that worked.
                        skipped++
                    }
                }
            }
        }
    }
    return {waves,skipped}
}

/* The bars a trimHistogram run produced, as the plain objects the frame draws.

   Array.from first: Float64Array.prototype.map returns a Float64Array, NOT an
   array of objects, so mapping the typed array straight through would silently
   produce a buffer of NaN where the bin objects should be — a frame that draws
   nothing and says nothing about why. */
export function binsOfHistogram(histogram){
    return Array.from(histogram.centres)
        .map((value,index)=>({value,count:histogram.counts[index]}))
}

export const TRIM_METHODS={
    passthrough:{
        label:"No trim (pass-through)",
        hint:"The spectrum passes through untouched.",
        fields:[]
    },
    madResidual:{
        label:"k·MAD on moving-average residual",
        hint:"Cuts below the baseline plus k times the noise. k is the rejection multiplier (5 keeps ~99.3% of a Gaussian; 1.96 would be 95%), and the window is the width of the moving average the noise is measured on.",
        //k and window are part of the PUBLISHED method, so they stay editable.
        //k is a multiplier, not a threshold: it means nothing without the sigma
        //it multiplies, which the kernel estimates from the data.
        fields:[
            {key:"k",value:5,min:1,step:0.1,title:"Rejection multiplier on the noise"},
            {key:"window",value:9,min:3,step:2,title:"Width of the moving average the noise is measured on"}
        ]
    },
    intensityThreshold:{
        label:"Intensity threshold",
        hint:"Drops every point below the threshold, which the cursor shows and you can drag. Type a value here to seed that cursor when the method is picked or Guess is pressed.",
        //The field seeds the cursor; the cursor remains what actually trims, so a
        //number typed here is a starting point and nothing more.
        fields:[
            {key:"threshold",value:0.1,min:0,step:"any",
                title:"Intensity under which every point is dropped"}
        ]
    }
}

//Cursor palette, taken from the node chrome rather than invented: lime is the
//app accent, and the two bounds must not collide with the bar gradient, which is
//itself green. Cyan reads as "cut" and magenta as "ceiling" on a dark ground.
export const TRIM_LOW_COLOR="#00d4ff"
export const TRIM_HIGH_COLOR="#ff5fd0"
export const CURSOR_COLORS=[["lowBound",TRIM_LOW_COLOR],["highBound",TRIM_HIGH_COLOR]]
//Labels and lines are deliberately heavier than the rest of the node: the cursor
//IS the control, and on a busy histogram a 1px line disappears into the bars
export const TRIM_CURSOR_STROKE=2.5
export const TRIM_CURSOR_FIELD_FONT="0.95em"

/* The type of every node a session can name, in ONE place. It used to be spelled
   out inside App.importSession, and a list of node types written twice is a list
   that drifts: a type added to one and forgotten in the other would come back as
   a bare Node with no inputs at all, silently. */
export const NODE_CONSTRUCTORS={}

export function nodeRestoreData(node){
    return {
        title:node.title,
        type:node.constructor.name,
        registrationName:node.events?.registrationName,
        //inputs keep their shape only: Maps are rebuilt from the live links by
        //syncInputs (and by resolveFlow), so parent nodes are never deep-cloned
        inputs:node.inputs.map(entry=>entry instanceof Map ? new Map() : DC(entry)),
        outputs:DC(node.outputs),
        position:{...node.parameters.position},
        //the pin travels with the node: an undo that brings a node back must
        //bring back the choice the user made about where it lives
        pinned:!!node.parameters.pinned,
        status:node.status,
        source:node.parameters.source?DC(node.parameters.source):null,
        state:node.serializeState?.()??null
    }
}

export function createNodeForHistory(origin,flow,data){
    const position={...data.position}
    //DC on the shape only: a record must not share its arrays with the node it
    //brings back, or the next resolve would rewrite the history
    const node=buildNode(
        {
            ...data,
            inputs:data.inputs===undefined?undefined:DC(data.inputs),
            outputs:data.outputs===undefined?undefined:DC(data.outputs)
        },
        origin,
        flow
    )
    origin.channel.register(data.registrationName??"node",node,node.title)
    node.parameters.pinned=!!data.pinned
    if(data.source){
        node.parameters.source=DC(data.source)
        node.updateLabel(node.parameters.source.fileName)
        node.startResolve().then(()=>node.renderAccordion?.())
        return node
    }
    if(data.state&&typeof node.restoreState==="function"){
        node.restoreState(data.state)
    }
    if(data.status){
        node.status=data.status
    }
    if(Array.isArray(data.outputs)&&data.outputs.length===node.outputs.length){
        node.outputs=DC(data.outputs)
    }
    node.graph?.drawGraph()
    return node
}

/* THE ONE place that knows how a node class is called.

   Two signatures coexist here: the nodes that build their own inputs and outputs
   take (title, app, flow, position), the rest take the classic
   (title, inputs, outputs, app, flow, position). Calling one the other way does
   not fail politely - `destination` arrives undefined and the constructor dies on
   this.destination.nodeSet, and the whole app goes with it. So the undo command,
   the file import and the reload all come through here rather than each picking
   its own spelling. */
export const SELF_SHAPED_NODES=new Set([
    //ChatNode builds its own (empty) inputs and outputs, so it takes the
    //(title, app, flow, position) signature. Left out of this set, a reload
    //would call it with five arguments and its slots would be the App.
    //ChatNode,
    //one multiplexed input, one output: the collection reader declares its own
    //shape for the same reason, and a session that spelled it out would be
    //describing a socket count the flow decides anyway
    //FormulaCollectionNode,
    //same shape and same reason: the attribution node takes any number of XY
    //waves and renders one attribution list per wave, so its socket count is the
    //flow's business, not the node's
    //AttributionNode
])
/* A file spells a node's shape out. A skeleton only knows how many slots the node
   HAD: what was in them was data, and data is rebuilt by the resolve. A link is
   restored by index, so it is the count that has to survive. */
export const emptySlots=count=>Array.from({length:Math.max(0,Math.trunc(count)||0)},()=>[])
export function buildNode(data,app,flow,constructors=NODE_CONSTRUCTORS){
    const NodeType=constructors[data.type]??constructors.Node
    const position={x:data.position?.x??10,y:data.position?.y??10}
    if(SELF_SHAPED_NODES.has(NodeType)){
        return new NodeType(data.title,app,flow,position)
    }
    return new NodeType(
        data.title,
        data.inputs??emptySlots(data.inputCount),
        data.outputs??emptySlots(data.outputCount),
        app,
        flow,
        position
    )
}

/* LA FENÊTRE DE LA SONDE — trois points à ±0,5 du m/z interrogé.

   C'est le MÊME `attributeSpectrum` que le nœud utilise sur un vrai spectre, avec le
   même plan: la réponse est donc celle que donnerait un pic réel à cette position.
   Seul l'entrée change.

   Les deux points latéraux ne sont pas décoratifs: `nearest` a besoin d'un voisinage
   pour choisir, et rien d'autre ne peut se glisser entre deux points distants de 0,5.
   Le point du MILIEU est l'interrogé — c'est celui dont on lit les formules.

   ELLE EST UNE `function` LIBRE, au niveau du module, et non une méthode. Deux
   raisons, et la première est un bug qui est arrivé:

   1. un corps de classe n'accepte QUE des méthodes. Écrire `function ...` dedans
      est une SyntaxError, et une SyntaxError que `node --check` ne voit PAS: il
      parse le fichier en CommonJS alors qu'il commence par un `import`, s'arrête
      sur cet import, et n'atteint jamais la ligne fautive. Le contrôle honnête est
      `import()`, qui va jusqu'au bout.
   2. elle ne dépend d'aucun état du nœud, donc la mettre dans la classe n'apporterait
      rien et la lierait à `this` sans raison.

   Elle est placée ICI, entre les commentaires d'en-tête et `class
   AttributionNode`, donc hors de toute classe. */
export function windowFor(mass){
    const half=0.5
    return new SortedPoints([mass-half,mass,mass+half],[1,1,1])
}