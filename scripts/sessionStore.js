/* -------------------------------------------------------------------------
    sessionStore.js — what survives a reload, and what does not.

    WHY THIS EXISTS
    A Command holds closures, so the undo stack can never be written anywhere:
    the history dies with the tab whatever we do. And the data a flow computes
    (inputs, outputs, the parsed pairs, the Wave) is DERIVED - parentSynapse,
    parseRaw and startResolve rebuild all of it from the links and the source.
    What is left is the thing a user would actually miss: the shape of their
    pipeline and the numbers they tuned. That is what a skeleton is.

    TWO STORES, TWO JOBS
    sessionStorage  the work in progress: per TAB, dies with the tab, so two tabs
                    can never fight over it and nothing has to be namespaced by an
                    id nobody remembers.
    localStorage    what outlives the session - today the panel geometry, a few
                    hundred bytes - and NOTHING else. A stored session would mean
                    either a 5 MB budget shared with every other tab, or base64 in
                    a string, and neither is a good reason.

    WHY NOT localStorage FOR EVERYTHING: a session's data is ~1.8 MB per loaded
    file, which is the whole localStorage quota for a handful of copies, shared
    per origin, written synchronously. A skeleton is a few KB.

    NO CONSENT NEEDED. A service the user explicitly asked for, in their own
    browser, never read by a third party and never sent to the server: the
    ePrivacy "strictly necessary" exemption covers it (see the privacy notice).
    Which is exactly why nothing user-identifiable belongs in here - d3 and three
    come from a CDN, and CDN code runs in this origin, so a localStorage holding
    patient spectra would be one compromised dependency away from a breach.

    The storage object is a PARAMETER, not a global: that is what makes this
    module testable in plain node, unlike the node classes that need a DOM.
   ------------------------------------------------------------------------- */

const SKELETON_KEY="attributor:session"
const PREFERENCES_KEY="attributor:ui"
//bumped on its own when the SHAPE changes. SESSION_VERSION belongs to the
//exported file, which this deliberately stays compatible with.
const SKELETON_VERSION=1
const WRITE_DELAY_MS=400

export function debounce(action,{wait=WRITE_DELAY_MS,storage,name}={}){
    let timer=null
    /* one guarded runner for both the delayed write and the forced one, so a
       full storage is reported the same way whichever way the save happens */
    const run=(args)=>{
        try{
            action(...args)
        }catch(error){
            //a failed autosave must never take the app down with it: the session
            //is still perfectly usable, it will just not survive the next reload
            console.warn(`[sessionStore] could not save ${name??"the session"}:`,error)
        }
    }
    const wrapped=(...args)=>{
        if(timer){
            clearTimeout(timer)
        }
        timer=setTimeout(()=>{
            timer=null
            run(args)
        },wait)
    }
    /* "New session" clears the store, and a timer still pending would put the
       pipeline straight back into it a moment later. Cancelling is therefore
       not a nicety: without it the reset does not stick. */
    wrapped.cancel=()=>{
        if(timer){
            clearTimeout(timer)
            timer=null
        }
    }
    wrapped.flush=(...args)=>{
        wrapped.cancel()
        run(args)
    }
    return wrapped
}

const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value)
const objectProps=(target,source)=>{
    for(const key of Object.keys(source??{})){
        target[key]=source[key]
    }
    return target
}

/* An encoder written for THIS shape, not the session encoder. sessions.js
   serialises live objects - Maps, Waves, class instances, cycles between nodes.
   A skeleton is numbers, strings and nested objects, and running it through the
   session machinery would drag the whole graph in, which is the exact size
   problem this file exists to avoid. */
function encode(value){
    if(value===null){
        return null
    }
    const type=typeof value
    if(type==="number"){
        return Number.isFinite(value)?value:null
    }
    if(type==="string"||type==="boolean"){
        return value
    }
    if(Array.isArray(value)){
        return value.map(encode)
    }
    if(isObject(value)){
        return objectProps({},value)
    }
    //undefined, function, symbol: a setting has no business being one
    return null
}

/* --- the skeleton, in and out ---------------------------------------- */

/* A LIST, never a copy of what the nodes happen to hold. The nodes grow private
   caches - a pasted spectrum, a hovered bin - and a blacklist would quietly
   start persisting them. `raw` travels and `pairs` does not: the pairs are the
   parsed form of the raw text, rebuilt by parseRaw() on the way back. */
function skeletonNode(node){
    const parameters=node.parameters??{}
    //the channel's OWN key, which is what sessions.js resolves a link through -
    //not the readable registrationName, which can be suffixed on a collision
    const id=node.events?.registrationId??null
    const entry={
        type:node.constructor?.name??"Node",
        id,
        title:node.title,
        registrationName:node.events?.registrationName??null,
        //the menu shows the label, not the title: a restored node that lost it
        //would appear as "undefined" in every list
        label:node.events?.label??node.title,
        position:{
            x:node.parameters?.position?.x??10,
            y:node.parameters?.position?.y??10
        },
        pinned:!!node.parameters?.pinned,
        /* Whether the node's panel was folded shut. It lives on the accordion,
           which is a fresh object after a restore, and a fresh accordion is
           open: a user who folded a node did it to get it out of the way, and a
           reload that unfolds it takes that choice back. */
        folded:node.accordion?.parameters?.folded??false,
        /* Where this node's panel sits in its column. It is the user's own
           arrangement of the panels - which one they want in sight, at the
           top - so it travels with the fold state right above it: both are
           choices about how the panel looks, and both are rebuilt from
           scratch after a reload, since an accordion is a fresh object and
           arrives in the order the file lists the nodes in.

           Read from the live DOM, never kept in a field of its own: the DOM
           order IS the arrangement, and a stored copy would be a second
           source of truth to keep in step by hand. */
        panelOrder:node.accordion?.panelOrder?.()??null,
        /* The second column's rank, for the nodes that own a panel on the
           right as well. Same reasoning as the two keys on the way back in:
           the columns are ranked separately. */
        rightPanelOrder:node.accordionRight?.panelOrder?.()??null,
        status:node.status??null,
        /* The SHAPE, not the data: a slot held traces, and traces come back from
           the resolve. What has to survive is how MANY slots there were, because a
           link is restored by index into one of them. */
        inputCount:node.inputs?.length??0,
        outputCount:node.outputs?.length??0,
        state:typeof node.serializeState==="function"?encode(node.serializeState()):null
    }
    if(parameters.source){
        entry.source={
            fileName:parameters.source.fileName??"",
            labels:Array.isArray(parameters.source.labels)?parameters.source.labels:["x","y"],
            lineSeparator:parameters.source.lineSeparator,
            columnSeparator:parameters.source.columnSeparator,
            raw:parameters.source.raw??""
        }
    }
    if(entry.source&&entry.state&&typeof entry.state==="object"&&"source" in entry.state){
        /* A node's serializeState is written for the EXPORTED file, where the
           source belongs: it carries the whole thing, pairs included. Here the
           whitelist above already carries the text, so keeping the state's copy
           would store the raw text twice and the pairs once more - which is the
           size problem this whole file exists to avoid. */
        delete entry.state.source
    }
    return entry
}

export function buildSkeleton(app){
    if(!app?.channel?.casters){
        throw new TypeError("buildSkeleton expects an App with a Channel")
    }
    const flows=[]
    for(const caster of app.channel.casters.values()){
        if(!(caster?.nodeSet instanceof Set)){
            continue
        }
        //the flow's own knobs - the arrangement spacing lives there - minus the
        //runtime drawing flags, which the constructor rebuilds anyway
        const {field,...rest}=caster.parameters??{}
        flows.push({
            registrationName:caster.events?.registrationName??null,
            label:caster.events?.label??caster.title??null,
            parameters:encode(rest),
            nodes:[...caster.nodeSet].map(skeletonNode),
            links:caster.linkList
                .filter(link=>link.inputNode&&link.outputNode)
                .map(link=>({
                    //by the channel's own key, which is what sessions.js looks a
                    //link up with. The DOM's own names read backwards on top of
                    //that: link.inputNode is the node that PRODUCES, it owns the
                    //output anchor
                    inputNode:link.inputNode?.events?.registrationId??null,
                    inputIndex:Number(link.inputAnchor?.id??0),
                    outputNode:link.outputNode?.events?.registrationId??null,
                    outputIndex:Number(link.outputAnchor?.id??0)
                }))
        })
    }
    return {
        format:"attributor-session",
        version:1,
        skeletonVersion:SKELETON_VERSION,
        savedAt:new Date().toISOString(),
        app:{parameters:encode(app.parameters??{})},
        //the channel's counter: importSession reads it, so the nodes that come
        //back keep their channel-N ids and do not collide with the next one
        channel:{nextId:app.channel.nextId},
        flows
    }
}

export function exportSkeleton(app){
    return JSON.stringify(encode(buildSkeleton(app)))
}

export function writeSession(app,storage=globalThis.sessionStorage){
    if(!storage){
        return false
    }
    storage.setItem(SKELETON_KEY,exportSkeleton(app))
    return true
}

/* Anything unreadable means "no saved session", never an exception: a
   half-written entry, a hand-edited value or a version this build does not know
   must all land on the same empty app as a first visit. */
export function parseSkeleton(text){
    if(typeof text!=="string"||!text){
        return null
    }
    let document=null
    try{
        document=JSON.parse(text)
    }catch{
        return null
    }
    if(!isObject(document)||document.format!=="attributor-session"){
        return null
    }
    if(document.skeletonVersion!==SKELETON_VERSION){
        //a shape from another build: dropped rather than guessed at
        return null
    }
    if(!Array.isArray(document.flows)){
        return null
    }
    return document
}

export function readSession(storage=globalThis.sessionStorage){
    if(!storage){
        return null
    }
    return parseSkeleton(storage.getItem(SKELETON_KEY))
}

export function clearSession(storage=globalThis.sessionStorage){
    storage?.removeItem(SKELETON_KEY)
}

export function savePreferences(app,storage=globalThis.localStorage){
    const parameters=app?.parameters??{}
    storage?.setItem(PREFERENCES_KEY,JSON.stringify(encode({
        topContent:parameters.topContent,
        botContent:parameters.botContent,
        leftContent:parameters.leftContent,
        rightContent:parameters.rightContent
    })))
}

export function readPreferences(storage=globalThis.localStorage){
    let document=null
    try{
        document=JSON.parse(storage?.getItem(PREFERENCES_KEY)??"null")
    }catch{
        return null
    }
    return isObject(document)?document:null
}

/* --- the durable copy, and the one destructive gesture ------------------ */

/* The full session, not the skeleton: this is the copy that outlives the tab,
   and it is deliberately the COMPLETE one, data and all. The lifecycle is what
   makes that acceptable rather than merely convenient - a durable copy is never
   overwritten behind the user's back, and "New session" is a hard reset that
   takes it with it, so the data is either there or deliberately gone. */
const LOCAL_SESSION_KEY="attributor:session:local"
/* What an older build called its durable copy. PurgeAll removes it too: a reset
   that leaves one key behind is not a reset. */
const LEGACY_LOCAL_KEY="attributor-session"

export function hasLocalSession(storage=globalThis.localStorage){
    return Boolean(storage?.getItem(LOCAL_SESSION_KEY))
}
export function readLocalSession(storage=globalThis.localStorage){
    return storage?.getItem(LOCAL_SESSION_KEY)??null
}
/* A refused write is the one save failure the user MUST hear about, and the
   reason matters: the budget is a browser limit, not a bug, and there is a way
   out of it that does not involve throwing their work away. */
export function saveLocalSession(json,storage=globalThis.localStorage){
    try{
        storage.setItem(LOCAL_SESSION_KEY,json)
    }catch(error){
        if(error?.name==="QuotaExceededError"||error?.code===22){
            const mb=(json.length/1e6).toFixed(1)
            throw new RangeError(
                `This session needs ${mb} MB and the browser only allows 5 MB per site. `+
                `"Export session" puts it on disk instead, where there is no such limit.`
            )
        }
        throw error
    }
    return {bytes:json.length}
}
export function clearLocalSession(storage=globalThis.localStorage){
    storage?.removeItem(LOCAL_SESSION_KEY)
}
/* A HARD RESET, and the only destructive gesture in the app.

   One button, one meaning: everything this app kept is gone, from everywhere it
   kept it - the tab's skeleton, the durable copy, and the panel geometry. The
   geometry goes with it on purpose. A program that offers to cancel but keep
   some of it makes the reader wonder which of the buttons they are about to
   press, and the answer changes with what happens to be present at the time. */
export function purgeAll({
    session=globalThis.sessionStorage,
    local=globalThis.localStorage
}={}){
    session?.removeItem(SKELETON_KEY)
    local?.removeItem(LOCAL_SESSION_KEY)
    local?.removeItem(PREFERENCES_KEY)
    local?.removeItem(LEGACY_LOCAL_KEY)
    return true
}

/* --- booting from a skeleton ----------------------------------------- */

/* The options for sessions.js, or null when there is nothing to import - which
   is a first visit, not a failure.

   The one real trap is here. sessions.js calls the factory with the FILE data and
   then assigns node.parameters.position from that same object, so the file data
   is what the factory must be given, not the caller's nodeData. The two are kept
   in step by handing the file data over and letting restoreAfterImport() re-parse
   the raw text, because a self-shaped node builds its own inputs and outputs and
   ignores the restored ones. */
export function importOptions(document,hooks={}){
    const isNode=hooks.isNode??(()=>true)
    if(!document){
        return null
    }
    const options={
        createApp:hooks.createApp,
        createNode:({data,app,flow,channel})=>{
            /* How a node class is called is interface.js's business, not this
               file's: it is the one place that knows which classes build their own
               inputs and outputs. Guessing here is what killed a reload with
               `this.destination` undefined, in front of a SimpleXYPlotNode. */
            const node=hooks.buildNode?.(data,app,flow)??null
            if(!node){
                return null
            }
            const source=isObject(data.source)?data.source:null
            if(source){
                node.parameters.source={
                    lineSeparator:source.lineSeparator??"\\r\\n|\\r|\\n",
                    columnSeparator:source.columnSeparator??"\\t|,|\\s",
                    fileName:source.fileName??"",
                    labels:Array.isArray(source.labels)?source.labels:["x","y"],
                    //the pairs start empty ON PURPOSE: they are the parsed form
                    //of raw, and parseRaw() refills them below
                    raw:source.raw??"",
                    pairs:[]
                }
            }
            if(isObject(data.state)){
                node.restoreState?.(data.state)
            }
            node.parameters.pinned=!!data.pinned
            //read back by Node.restoreAfterImport, once the accordion exists
            node.restoredFolded=data.folded===true
            /* The rank of each panel in its column, likewise: a rank belongs to
               the accordion, which only exists once the node is registered. It
               is handed over, not applied — App.applyPanelOrder sorts a whole
               column at the end, because a panel that comes back first cannot
               know how many will follow it.

               TWO keys, because a node can own a panel in EACH column (the
               graph inspector lives on the right): the two columns are ranked
               independently, and one number cannot say "second from the top"
               about both at once. */
            node.restoredPanelOrder={
                left:Number.isInteger(data.panelOrder)?data.panelOrder:null,
                right:Number.isInteger(data.rightPanelOrder)?data.rightPanelOrder:null
            }
            if(data.status){
                node.status=data.status
            }
            return node
        },
        createLink:({flow,inputNode,inputIndex,outputNode,outputIndex})=>{
            if(!inputNode||!outputNode){
                return null
            }
            return flow.createLink(inputNode,inputIndex,outputNode,outputIndex)
        }
    }
    //a skeleton only ever names the flows it came from, so nothing is created on
    //the fly: a flow this build no longer knows would arrive nameless
    options.createFlow=undefined
    return options
}

/* Pairs are the parse of raw, so they are rebuilt from it and nothing else.

   Deliberately NO resolve here. The caller of a reload is about to run
   flow.resolveFlow() over the whole graph, which recomputes every output anyway:
   resolving here as well meant every node ran twice, and a reload of a real
   session paid for it in seconds. Parsing is synchronous and cheap; resolving is
   the flow's business. Returns the node, or null when there was nothing to do. */
export function reparseRestoredSource(node){
    if(typeof node?.parseRaw!=="function"){
        return null
    }
    const raw=node.parameters?.source?.raw??""
    if(!raw){
        return null
    }
    node.parameters.source.pairs=node.parseRaw()
    return node
}

export {SKELETON_KEY,PREFERENCES_KEY,SKELETON_VERSION,objectProps}
