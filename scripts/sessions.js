const SESSION_FORMAT = "attributor-session"
const SESSION_VERSION = 1
import {serializeFormatValue,recreateFormatValue} from "./formats.js"

function isObject(value) {
    return value !== null && typeof value === "object"
}

function registrationOf(caster) {
    return caster?.events?.registrationId
}

/* L'ÉTAT D'ENCODAGE, et la raison de son existence.

   Un encodage de session décrit un GRAPHE, pas un arbre. Le tableau
   périodique, par exemple, est le MÊME objet dans les 440 Formula d'une
   sortie d'attribution — et cet encodage-ci le réécrivait à l'identique 440
   fois, soit 55 Mo pour une seule vague. Deux vagues, et `JSON.stringify`
   demandait plus que V8 ne peut allouer: « allocation size overflow ».

   Le `WeakSet` d'avant ne retenait que les ANCÊTRES, donc il détectait
   les cycles et rien d'autre. Un objet partagé n'était pas un cycle, il
   était réécrit. D'où les deux structures:
     - `ancestors` : le cycle, qui reste une erreur franche;
     - `encodings` : la mémoire de ce qui a déjà été écrit, pour le nommer.

   `shared` est la table des valeurs partagées du document, dans l'ordre où
   elles ont été vues une deuxième fois, et `sharedIndex` retrouve l'encodage
   à partir de l'IDENTITÉ de l'objet déjà écrit — c'est ce qui permet, à la
   fin, de remplacer aussi la première occurrence par sa référence et de ne
   garder qu'une seule copie. */
function newEncodeState() {
    return {
        ancestors: new WeakSet(),
        encodings: new WeakMap(),
        ids: new WeakMap(),
        shared: [],
        sharedIndex: new Map()
    }
}

function encodeValue(value, state = newEncodeState()) {
    if (value === undefined) {
        return {type: "undefined"}
    }
    if (typeof value === "bigint") {
        return {type: "bigint", value: value.toString()}
    }
    if (!isObject(value)) {
        return value
    }
    if (value instanceof Node) {
        return {type: "dom"}
    }
    if (value instanceof Event) {
        return {type: "event", name: value.type}
    }
    const serializedFormat=serializeFormatValue(value)
    if(serializedFormat){
        return {type:"format",value:encodeValue(serializedFormat,state)}
    }
    const registrationId = registrationOf(value)
    if (registrationId) {
        return {type: "registration", id: registrationId}
    }
    if (state.ancestors.has(value)) {
        throw new TypeError("Session data contains an unsupported circular value")
    }
    /* DÉJÀ VU, ET PAS COMME ANCÊTRE: c'est un objet partagé. */
    const id = state.ids.get(value)
    if (id !== undefined) {
        return {type: "ref", id}
    }
    const written = state.encodings.get(value)
    if (written !== undefined) {
        const assigned = state.shared.length
        state.shared.push(written)
        state.sharedIndex.set(written, assigned)
        state.ids.set(value, assigned)
        return {type: "ref", id: assigned}
    }
    state.ancestors.add(value)

    let result
    if (value instanceof Map) {
        result = {
            type: "map",
            entries: [...value].map(([key, entryValue]) => [
                encodeValue(key, state),
                encodeValue(entryValue, state)
            ])
        }
    } else if (value instanceof Set) {
        result = {
            type: "set",
            values: [...value].map(entry => encodeValue(entry, state))
        }
    } else if (Array.isArray(value)) {
        result = value.map(entry => encodeValue(entry, state))
    } else {
        result = {}
        for (const [key, entryValue] of Object.entries(value)) {
            result[key] = encodeValue(entryValue, state)
        }
    }

    state.ancestors.delete(value)
    state.encodings.set(value, result)
    return result
}

/* LA SECONDE PASSE, et elle est courte.

   À la première, un objet partagé est écrit ENTIEREMENT une fois, puis
   référencé partout ailleurs — donc il existe deux copies dans l'encodage: la
   copie en ligne et celle de `shared`. Cette passe remplace la copie en ligne
   par sa référence, sur le seul critère de l'identité (`sharedIndex`), et il
   ne reste qu'un exemplaire.

   Elle ne peut pas être faite pendant l'encodage: on ne sait pas qu'un objet
   est partagé qu'au moment de le RÉ-rencontrer, et sa première copie est
   déjà partie. Elle ne coûte qu'une traversée de ce qui est déjà en
   mémoire — aucune chaîne n'est construite, donc rien ne peut exploser. */
function inlineSharedToReferences(encoded, sharedIndex) {
    if (!isObject(encoded)) {
        return encoded
    }
    const shared = sharedIndex.get(encoded)
    if (shared !== undefined) {
        return {type: "ref", id: shared}
    }
    if (Array.isArray(encoded)) {
        return encoded.map(entry => inlineSharedToReferences(entry, sharedIndex))
    }
    const result = {}
    for (const [key, entryValue] of Object.entries(encoded)) {
        result[key] = inlineSharedToReferences(entryValue, sharedIndex)
    }
    return result
}

/* La même passe, mais sur les ENFANTS d'une valeur partagée et pas sur elle.

   Sans cette nuance, `refs[i]` se remplacerait par sa propre référence et la
   lecture bouclerait à l'infini. La valeur partagée EST la référence: c'est
   elle qui doit rester écrite dans la table. */
function inlineSharedChildren(value, sharedIndex) {
    if (!isObject(value)) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map(entry => inlineSharedToReferences(entry, sharedIndex))
    }
    const result = {}
    for (const [key, entryValue] of Object.entries(value)) {
        result[key] = inlineSharedToReferences(entryValue, sharedIndex)
    }
    return result
}

/* La même distinction, à la lecture: un `{type:"ref"}` se relit par la table
   `document.refs`, et le résultat est MÉMORISÉ — sinon chaque référence
   reconstruirait sa propre copie du tableau périodique, et l'identité que la
   sauvegarde vient d'établir serait perdue à la relecture. */
function newDecodeState(document) {
    return {
        refs: document?.refs ?? [],
        decoded: new Map()
    }
}

function decodeValue(value, registrations, state = newDecodeState()) {
    if (!isObject(value)) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map(entry => decodeValue(entry, registrations, state))
    }
    if (value.type === "undefined") {
        return undefined
    }
    if (value.type === "bigint") {
        return BigInt(value.value)
    }
    /* LA RÉFÉRENCE. Elle est résolue UNE fois par id et mémorisée, donc tous
       ceux qui pointaient sur le même objet retrouvent le même objet — le
       tableau périodique reste UN tableau, et non une copie par Formula. */
    if (value.type === "ref") {
        if (state.decoded.has(value.id)) {
            return state.decoded.get(value.id)
        }
        const referenced = decodeValue(state.refs[value.id], registrations, state)
        state.decoded.set(value.id, referenced)
        return referenced
    }
    if(value.type === "format"){
        return recreateFormatValue(decodeValue(value.value,registrations,state))
    }
    if (value.type === "registration") {
        return registrations.get(value.id)
    }
    if (value.type === "map") {
        return new Map(value.entries.map(([key, entryValue]) => [
            decodeValue(key, registrations, state),
            decodeValue(entryValue, registrations, state)
        ]))
    }
    if (value.type === "set") {
        return new Set(value.values.map(entry => decodeValue(entry, registrations, state)))
    }
    if (value.type === "dom" || value.type === "event") {
        return undefined
    }

    const result = {}
    for (const [key, entryValue] of Object.entries(value)) {
        result[key] = decodeValue(entryValue, registrations, state)
    }
    return result
}

function runtimeShape(value, state = newDecodeState()) {
    if (!isObject(value)) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map(entry => runtimeShape(entry, state))
    }
    /* Une référence se lit par sa FORME, pas par sa valeur: c'est la forme
       qu'on donne à la fabrique d'un nœud, et la donnée reviendra intacte par
       `decodeValue` juste après. */
    if (value.type === "ref") {
        return runtimeShape(state.refs[value.id], state)
    }
    if (value.type === "map") {
        return new Map()
    }
    if (value.type === "set") {
        return new Set()
    }
    if (value.type === "undefined" || value.type === "registration") {
        return undefined
    }
    //dom/event values decode to undefined (see decodeValue), so the shape given
    //to node factories has to match
    if (value.type === "dom" || value.type === "event") {
        return undefined
    }
    if (value.type === "bigint") {
        return BigInt(value.value)
    }
    if(value.type === "format"){
        return recreateFormatValue(runtimeShape(value.value,state))
    }

    const result = {}
    for (const [key, entryValue] of Object.entries(value)) {
        result[key] = runtimeShape(entryValue, state)
    }
    return result
}

function getRegistrations(app) {
    if (!app?.channel?.casters || !app.channel.names) {
        throw new TypeError("save expects an App with a Channel")
    }
    return [...app.channel.casters].map(([id, caster]) => ({
        id,
        registrationName: caster.events?.registrationName,
        label: caster.events?.label ?? caster.title ?? caster.events?.registrationName,
        type: caster.constructor?.name ?? "Object",
        caster
    }))
}

function serializeNode(node, state) {
    const registration = state.registrationsByObject.get(node)
    return {
        id: registration.id,
        registrationName: registration.registrationName,
        label: registration.label,
        type: registration.type,
        title: node.title,
        inputs: encodeValue(node.inputs, state.encoding),
        outputs: encodeValue(node.outputs, state.encoding),
        position: encodeValue(node.parameters?.position ?? {x: 10, y: 10}, state.encoding),
        //a node the user dragged by hand is pinned: the arrangement flows
        //around it. Optional, so a session saved before the pins existed still
        //opens - it just comes back with every node free to move
        pinned: !!node.parameters?.pinned,
        state: encodeValue(node.serializeState?.(), state.encoding),
        status: node.status
    }
}

function serializeFlow(flow, state) {
    const registration = state.registrationsByObject.get(flow)
    const nodes = [...flow.nodeSet].map(node => serializeNode(node, state))
    const links = flow.linkList
        .filter(link => link.inputNode && link.outputNode)
        .map(link => ({
            inputNode: registrationOf(link.inputNode),
            inputIndex: Number(link.inputAnchor.id),
            outputNode: registrationOf(link.outputNode),
            outputIndex: Number(link.outputAnchor.id)
        }))

    return {
        id: registration.id,
        registrationName: registration.registrationName,
        label: registration.label,
        type: registration.type,
        title: flow.title,
        parameters: encodeValue(flow.parameters, state.encoding),
        nodes,
        links
    }
}

function save(app, options = {}) {
    const registrations = getRegistrations(app)
    /* UN SEUL état d'encodage pour tout le document. Les nœuds sont encodés
       l'un après l'autre, et c'est précisément ce qui rend la mémoire
       nécessaire: le tableau périodique du nœud 1 doit encore être connu au
       nœud 4, et non réécrit. */
    const encoding = newEncodeState()
    const state = {
        registrationsByObject: new WeakMap(
            registrations.map(registration => [registration.caster, registration])
        ),
        encoding
    }
    const flows = registrations
        .filter(registration => registration.caster?.nodeSet instanceof Set)
        .map(registration => serializeFlow(registration.caster, state))

    const document = {
        format: SESSION_FORMAT,
        version: SESSION_VERSION,
        app: {
            parameters: encodeValue(app.parameters, encoding)
        },
        channel: {
            nextId: app.channel.nextId,
            registrations: registrations.map(({caster, ...registration}) => registration)
        },
        flows
    }

    /* La seconde passe: chaque copie EN LIGNE d'une valeur partagée devient sa
       référence. Elle travaille sur l'encodage déjà construit, donc elle ne
       construit aucune chaîne — c'est `JSON.stringify` plus bas qui aurait
       explosé, pas elle.

       Les `refs` sont dédoublonnées POUR LEURS PROPRES CONTENUS, et ce n'est
       pas un détail: une valeur partagée peut en contenir une autre, et sa
       copie interne serait réécrite en entier dans le fichier. Ils sont
       calculés AVANT la substitution générale, et attachés après — sinon la
       passe remplacerait `refs[i]` par sa propre référence, ce qui ne
       finirait qu'en boucle infinie à la lecture. */
    const refs = encoding.shared
        .map(value => inlineSharedChildren(value, encoding.sharedIndex))
    const deduped = inlineSharedToReferences(document, encoding.sharedIndex)
    /* Pas de `refs` du tout quand il n'y a rien de partagé: un fichier sans
       cette clé reste un fichier parfaitement valable, et c'est ce que sont
       tous ceux écrits avant. */
    if (refs.length > 0) {
        deduped.refs = refs
    }
    return JSON.stringify(deduped, null, options.pretty === false ? 0 : (options.indent ?? 2))
}

function findFactory(factories, type, fallback) {
    if (typeof factories === "function") {
        return factories
    }
    return factories?.[type] ?? factories?.default ?? fallback
}

function clearRestorableFlows(app) {
    for (const flow of app.channel.casters.values()) {
        if (!(flow?.nodeSet instanceof Set)) {
            continue
        }
        for (const node of [...flow.nodeSet]) {
            node.suicide?.()
        }
        flow.linkList?.forEach(link => link.node?.().remove())
        flow.linkList = []
    }
}

function importSession(serialized, options = {}) {
    const document = typeof serialized === "string"
        ? JSON.parse(serialized)
        : serialized

    if (document?.format !== SESSION_FORMAT) {
        throw new TypeError("Unsupported session format")
    }
    if (document.version !== SESSION_VERSION) {
        throw new RangeError(`Unsupported session version: ${document.version}`)
    }
    if (typeof options.createApp !== "function") {
        throw new TypeError("importSession requires options.createApp")
    }

    const app = options.createApp()
    const channel = app.channel
    const registrations = new Map()
    /* UN état de lecture pour TOUT le document, comme à l'écriture: c'est lui
       qui résout les {type:"ref"} et qui garde une seule instance par valeur
       partagée. Un état par nœud reconstruirait le tableau périodique à chaque
       nœud — le défaut qu'on vient de réparer, en version minuscule. */
    const decoding = newDecodeState(document)
    clearRestorableFlows(app)

    for (const flowData of document.flows) {
        let flow = channel.get(flowData.registrationName)
        if (!flow && typeof options.createFlow === "function") {
            flow = options.createFlow(flowData, app)
            channel.register(flowData.registrationName, flow, flowData.label)
        }
        if (!flow) {
            throw new Error(`Cannot restore flow: ${flowData.registrationName}`)
        }
        registrations.set(flowData.id, flow)
    }

    for (const flowData of document.flows) {
        const flow = registrations.get(flowData.id)
        const nodes = new Map()
        for (const nodeData of flowData.nodes) {
            const createNode = findFactory(options.createNode, nodeData.type)
            if (typeof createNode !== "function") {
                throw new TypeError(`No node factory for type: ${nodeData.type}`)
            }
            const node = createNode({
                data: {
                    ...nodeData,
                    inputs: runtimeShape(nodeData.inputs, decoding),
                    outputs: runtimeShape(nodeData.outputs, decoding),
                    position: decodeValue(nodeData.position, registrations, decoding)
                },
                app,
                flow,
                channel
            })
            channel.register(nodeData.registrationName, node, nodeData.label)
            nodes.set(nodeData.id, node)
            registrations.set(nodeData.id, node)
            node.restoreState?.(decodeValue(nodeData.state, registrations, decoding))
        }

        for (const nodeData of flowData.nodes) {
            const node = nodes.get(nodeData.id)
            //only a file that DESCRIBES a node's shape may set it. A node that
            //builds its own inputs and outputs (a source, a trimmer) is
            //constructed with them, and writing undefined over that leaves a node
            //whose parent links have nothing to iterate
            if (nodeData.inputs !== undefined) {
                node.inputs = decodeValue(nodeData.inputs, registrations, decoding)
            }
            if (nodeData.outputs !== undefined) {
                node.outputs = decodeValue(nodeData.outputs, registrations, decoding)
            }
            // Sessions saved before the merge, in chronological order of what
            // they could have contained:
            //  - a slope input plus two outputs (the oldest homology node)
            //  - two outputs, the second carrying the input indices for a
            //    separate Anti-Radio node
            // All of them become ONE PeakPickingNode with one input and one
            // output. The extra slots are dropped rather than restored: the
            // indices are recomputed from the profile on every resolve, and a
            // stale copy would let the width filter measure the wrong peaks.
            if (node.constructor.name === "PeakPickingNode") {
                node.inputs = [new Map()]
                node.outputs = [[]]
            }
            // A separate Anti-Radio node is now a PeakPickingNode, so the link
            // that fed it the indices (output 1 of the old homology node) must
            // NOT be restored: both nodes would then resolve against each other
            // and the merged node would filter twice.
            if (nodeData.type === "AntiRadioNode") {
                node.mergedAway = true
            }
            if (node.parameters) {
                node.parameters.position = decodeValue(nodeData.position, registrations, decoding)
                // pinned = the user placed this node by hand, so the automatic
                // arrangement flows around it. Absent in older files, which
                // simply come back with every node free to move
                if (nodeData.pinned !== undefined) {
                    node.parameters.pinned = nodeData.pinned
                }
            }
            if (nodeData.status !== undefined) {
                node.status = nodeData.status
            }
            node.restoreAfterImport?.()
        }

        for (const linkData of flowData.links) {
            const inputNode = nodes.get(linkData.inputNode)
            const outputNode = nodes.get(linkData.outputNode)
            if (!inputNode || !outputNode) {
                throw new Error("Cannot restore link: node not found")
            }
            //a link to or from a node the merge absorbed is dropped, along with
            //the node: keeping the cable would leave a peak-picking node reading
            //from another peak-picking node
            if (inputNode.mergedAway || outputNode.mergedAway) continue
            if (typeof options.createLink !== "function") {
                throw new TypeError("importSession requires options.createLink")
            }
            options.createLink({
                flow,
                inputNode,
                inputIndex: linkData.inputIndex,
                outputNode,
                outputIndex: linkData.outputIndex
            })
        }

        //merged, never replaced: the live field is an object the Field class holds
        //by reference, so assigning over flow.parameters would strand the drawing
        //flags on an object nobody reads from any more
        const { field, ...rest } = decodeValue(flowData.parameters, registrations, decoding) ?? {}
        Object.assign(flow.parameters, rest)
    }

    if (document.app?.parameters) {
        app.parameters = decodeValue(document.app.parameters, registrations, decoding)
    }

    app.channel.nextId = Math.max(
        app.channel.nextId,
        document.channel.nextId ?? app.channel.nextId
    )
    app.channel.setupOnAir?.()
    return app
}

export {save, importSession, importSession as import}
