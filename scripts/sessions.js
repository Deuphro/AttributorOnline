const SESSION_FORMAT = "attributor-session"
const SESSION_VERSION = 1

function isObject(value) {
    return value !== null && typeof value === "object"
}

function registrationOf(caster) {
    return caster?.events?.registrationId
}

function encodeValue(value, state, seen = new WeakSet()) {
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
    const registrationId = registrationOf(value)
    if (registrationId) {
        return {type: "registration", id: registrationId}
    }
    if (seen.has(value)) {
        throw new TypeError("Session data contains an unsupported circular value")
    }
    seen.add(value)

    let result
    if (value instanceof Map) {
        result = {
            type: "map",
            entries: [...value].map(([key, entryValue]) => [
                encodeValue(key, state, seen),
                encodeValue(entryValue, state, seen)
            ])
        }
    } else if (value instanceof Set) {
        result = {
            type: "set",
            values: [...value].map(entry => encodeValue(entry, state, seen))
        }
    } else if (Array.isArray(value)) {
        result = value.map(entry => encodeValue(entry, state, seen))
    } else {
        result = {}
        for (const [key, entryValue] of Object.entries(value)) {
            result[key] = encodeValue(entryValue, state, seen)
        }
    }

    seen.delete(value)
    return result
}

function decodeValue(value, registrations) {
    if (!isObject(value)) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map(entry => decodeValue(entry, registrations))
    }
    if (value.type === "undefined") {
        return undefined
    }
    if (value.type === "bigint") {
        return BigInt(value.value)
    }
    if (value.type === "registration") {
        return registrations.get(value.id)
    }
    if (value.type === "map") {
        return new Map(value.entries.map(([key, entryValue]) => [
            decodeValue(key, registrations),
            decodeValue(entryValue, registrations)
        ]))
    }
    if (value.type === "set") {
        return new Set(value.values.map(entry => decodeValue(entry, registrations)))
    }
    if (value.type === "dom" || value.type === "event") {
        return undefined
    }

    const result = {}
    for (const [key, entryValue] of Object.entries(value)) {
        result[key] = decodeValue(entryValue, registrations)
    }
    return result
}

function runtimeShape(value) {
    if (!isObject(value)) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map(entry => runtimeShape(entry))
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
    if (value.type === "bigint") {
        return BigInt(value.value)
    }

    const result = {}
    for (const [key, entryValue] of Object.entries(value)) {
        result[key] = runtimeShape(entryValue)
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
        inputs: encodeValue(node.inputs, state),
        outputs: encodeValue(node.outputs, state),
        position: encodeValue(node.parameters?.position ?? {x: 10, y: 10}, state),
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
        parameters: encodeValue(flow.parameters, state),
        nodes,
        links
    }
}

function save(app, options = {}) {
    const registrations = getRegistrations(app)
    const state = {
        registrationsByObject: new WeakMap(
            registrations.map(registration => [registration.caster, registration])
        )
    }
    const flows = registrations
        .filter(registration => registration.caster?.nodeSet instanceof Set)
        .map(registration => serializeFlow(registration.caster, state))

    const document = {
        format: SESSION_FORMAT,
        version: SESSION_VERSION,
        app: {
            parameters: encodeValue(app.parameters, state)
        },
        channel: {
            nextId: app.channel.nextId,
            registrations: registrations.map(({caster, ...registration}) => registration)
        },
        flows
    }

    return JSON.stringify(document, null, options.pretty === false ? 0 : (options.indent ?? 2))
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
                    inputs: runtimeShape(nodeData.inputs),
                    outputs: runtimeShape(nodeData.outputs),
                    position: decodeValue(nodeData.position, registrations)
                },
                app,
                flow,
                channel
            })
            channel.register(nodeData.registrationName, node, nodeData.label)
            nodes.set(nodeData.id, node)
            registrations.set(nodeData.id, node)
        }

        for (const nodeData of flowData.nodes) {
            const node = nodes.get(nodeData.id)
            node.inputs = decodeValue(nodeData.inputs, registrations)
            node.outputs = decodeValue(nodeData.outputs, registrations)
            if (node.parameters) {
                node.parameters.position = decodeValue(nodeData.position, registrations)
            }
            if (nodeData.status !== undefined) {
                node.status = nodeData.status
            }
        }

        for (const linkData of flowData.links) {
            const inputNode = nodes.get(linkData.inputNode)
            const outputNode = nodes.get(linkData.outputNode)
            if (!inputNode || !outputNode) {
                throw new Error("Cannot restore link: node not found")
            }
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

        flow.parameters = decodeValue(flowData.parameters, registrations)
    }

    if (document.app?.parameters) {
        app.parameters = decodeValue(document.app.parameters, registrations)
    }

    app.channel.nextId = Math.max(
        app.channel.nextId,
        document.channel.nextId ?? app.channel.nextId
    )
    app.channel.setupOnAir?.()
    return app
}

export {save, importSession, importSession as import}
