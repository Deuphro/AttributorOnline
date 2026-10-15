/* forest-worker.js — le moteur de force du graphe forestier, par SESSIONS.

   UN WORKER, UNE SESSION PAR ARBRE: `init` ouvre la session (semis des
   positions, biais, plafond de tours) et chaque message porte son `initId`.

   LE WORKER EST TIRÉ, JAMAIS POUSSÉ — et c'est le contrat entier: il ne
   calcule QUE sur un `resume` (`steps` pas de `frStep`), puis il répond.
   Pas de rAF ici, pas de boucle autonome: `stop` n'a rien à annuler, une
   session muette ne consomme rien, et le thread principal reste maître du
   rythme d'animation.

   TOUTE DEMANDE REÇOIT UNE RÉPONSE, même pour une session déjà libérée et
   même en cas d'exception: une promesse sans réponse figerait la boucle
   d'animation côté nœud, pour toujours.

   LES POSITIONS SONT COPIÉES, PAS TRANSFÉRÉES: transférer le buffer le
   DÉTACHE côté worker — la session perdrait ses propres positions dès la
   première réponse, et les tours suivants calculeraient sur un buffer vide. */
import {frStep,seedPositions,massBiasOf,defectBiasOf,errorBiasOf,depthBiasOf,layoutTemperature,FOREST_SETTLE_RATIO,FOREST_VISCOSITY,FOREST_LAYOUT_DEFAULTS} from "./forest.js"

const sessions=new Map()

function reply(initId,type,data){
    self.postMessage({type,initId,...data})
}

/* OUVRE LA SESSION: tout ce que `createAnimatedLayout` préparait côté nœud
   (semis, biais, plafond de tours) est calculé une seule fois, au `init`. */
function openSession(data){
    const graph=data.graph??{vertices:[],links:[]}
    const params=data.params??{}
    const vertices=graph.vertices??[]
    const links=graph.links??[]
    const count=vertices.length
    const ideal=params.ideal??FOREST_LAYOUT_DEFAULTS.ideal
    const byIndex=new Map(vertices.map((vertex,index)=>[vertex.index,index]))
    const rootLocalIndex=vertices.findIndex(vertex=>vertex.index===graph.rootIndex)
    const positions=new Float64Array(count*2)
    if(count) seedPositions(positions,graph,count,ideal,rootLocalIndex)
    return {
        graph,
        count,
        ideal,
        byIndex,
        rootLocalIndex,
        positions,
        velo:new Float64Array(count*2),
        iteration:0,
        /* LE PLAFOND EST CELUI DE L'ANIMÉ, PAS CELUI DU MODE STATIQUE:
           `iterations` (1e9 par défaut) n'est qu'un garde-fou, l'arrêt réel
           étant le seuil `FOREST_SETTLE_RATIO`. Plafonner à `layoutRoundsFor`
           (1 200 tours) aurait fait REPARTIR la session de zéro toutes les
           1 200 étapes — donc RECHAUFFER la température de `tempStart` à
           `tempEnd` à chaque boucle: l'animation « relancée » à intervalle
           régulier. Sur `main`, ce plafond n'était jamais atteint. */
        totalIterations:Math.max(1,Math.trunc(params.iterations??FOREST_LAYOUT_DEFAULTS.iterations)),
        worst:links.reduce((n,link)=>Math.max(n,Number(link.weight)||0),0)||1,
        repulsion:params.repulsion??FOREST_LAYOUT_DEFAULTS.repulsion,
        restBase:params.restBase??FOREST_LAYOUT_DEFAULTS.restBase,
        restSpan:params.restSpan??FOREST_LAYOUT_DEFAULTS.restSpan,
        fac:params.fac??FOREST_LAYOUT_DEFAULTS.fac,
        /* LA TEMPÉRATURE COMME DANS `createAnimatedLayout`: `tempStart` vaut
           la moitié de `ideal` quand il n'y en a pas. */
        tempStart:Number.isFinite(params.tempStart)?params.tempStart:ideal*0.5,
        tempEnd:Number.isFinite(params.tempEnd)?params.tempEnd:FOREST_LAYOUT_DEFAULTS.tempEnd,
        viscosity:params.viscosity??FOREST_VISCOSITY,
        springExponent:params.springExponent??FOREST_LAYOUT_DEFAULTS.springExponent,
        massBias:massBiasOf(vertices),
        massForce:params.massForce??FOREST_LAYOUT_DEFAULTS.massForce,
        defectBias:defectBiasOf(vertices),
        defectForce:params.defectForce??FOREST_LAYOUT_DEFAULTS.defectForce,
        errorBias:errorBiasOf(vertices,links),
        errorForce:params.errorForce??FOREST_LAYOUT_DEFAULTS.errorForce,
        depthBias:depthBiasOf(vertices,links,graph.rootIndex),
        depthForce:params.depthForce??FOREST_LAYOUT_DEFAULTS.depthForce
    }
}
/* N PAS DE `frStep`, LA MÊME PHYSIQUE QU'EN THREAD PRINCIPAL: mêmes
   arguments, même arrêt au seuil `FOREST_SETTLE_RATIO`, même décroissance
   de température — `layoutTemperature` est importée, pas recopiée. */
function runSteps(session,steps){
    if(session.count<=1||session.totalIterations<=0) return {maxSpeed:0,done:true}
    /* LE PLAFOND REPART: une session arrivée au bout de ses tours repart de
       zéro avec sa vitesse conservée — le graphe respire au lieu de se figer.
       C'est ici que vit le `iteration=0` dont le commentaire du nœud parlait. */
    if(session.iteration>=session.totalIterations) session.iteration=0
    let maxSpeed=0
    let done=false
    for(let step=0;step<steps;step++){
        const round=session.iteration++
        if(round>=session.totalIterations){ done=true; break }
        maxSpeed=frStep(session.positions,session.velo,session.graph,session.byIndex,{
            k:session.ideal,
            worst:session.worst,
            repulsion:session.repulsion,
            restBase:session.restBase,
            restSpan:session.restSpan,
            fac:session.fac,
            rootLocalIndex:session.rootLocalIndex,
            temperature:layoutTemperature(round,session.tempStart,session.tempEnd),
            viscosity:session.viscosity,
            springExponent:session.springExponent,
            massBias:session.massBias,
            massForce:session.massForce,
            defectBias:session.defectBias,
            defectForce:session.defectForce,
            errorBias:session.errorBias,
            errorForce:session.errorForce,
            depthBias:session.depthBias,
            depthForce:session.depthForce
        })
        if(maxSpeed<session.ideal*FOREST_SETTLE_RATIO){ done=true; break }
    }
    return {maxSpeed,done}
}

self.onmessage=(e)=>{
    const {type,initId}=e.data??{}
    try{
        if(type==="init"){
            const session=openSession(e.data)
            sessions.set(initId,session)
            reply(initId,"positions",{
                positions:session.positions,
                iteration:0,
                maxSpeed:0,
                totalIterations:session.totalIterations,
                done:session.count<=1
            })
        }else if(type==="resume"){
            const session=sessions.get(initId)
            if(!session){
                /* SESSION DÉJÀ LIBÉRÉE: on répond quand même, sans positions —
                   le nœud garde alors ses dernières et n'avance plus. */
                reply(initId,"positions",{done:true})
                return
            }
            const steps=Math.max(1,Math.trunc(Number(e.data.steps))||1)
            const {maxSpeed,done}=runSteps(session,steps)
            reply(initId,"positions",{
                positions:session.positions,
                iteration:session.iteration,
                maxSpeed,
                totalIterations:session.totalIterations,
                done
            })
        }else if(type==="pause"){
            /* RIEN À FAIRE, ET C'EST LE MODÈLE TIRÉ QUI LE DIT: une session ne
               calcule que sur `resume`, donc « en attente » EST son état de
               repos. Le message reste dans le protocole pour que `pause` du
               nœud soit explicite — la session, elle, reste ouverte. */
        }else if(type==="stop"){
            sessions.delete(initId)
        }
    }catch(error){
        reply(initId,"positions",{error:String(error?.message??error)})
    }
}

self.onerror=(error)=>{
    console.error('[forest-worker] error:',error)
}