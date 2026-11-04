import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Formula, Stoichiometry, FormulaCollection} from "../chemistry.js"
import {CE} from "../util.js"
import {SOCKET} from "../socketTypes.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"

/* -------------------------------------------------------------------------
   SankeyNode — Sankey diagram for formula collections.

   LEVEL 1 (left): spectrum targets (individual formulas), sorted by
   ascending mass by default. Molecule labels are not drawn (the name is
   available on hover): they crowded the column.
   LEVEL 2 (right): partition groups by the elements present
   (e.g. C6H12O6, CH4, C2H5OH → group "CHO").

   Each formula links to its element group. The flow thickness is the
   formula's mass (configurable). The flows are real ribbons: their width is
   stacked along the nodes, so they do not overlap.

   Input : SOCKET.FORMULA_COLLECTION, multiplexed. Every parent wired to the
           anchor is read, and each output may carry one collection or an
           array of collections (FormulaCollection, {name, formulas|entries|
           items}, array of formulas…).
   Output: SOCKET.FORMULA_COLLECTION (pass-through of ALL collections)

   The graph is a D3 SVG drawn directly in the central window content (no
   WebGL context). The right panel holds the settings.
   ------------------------------------------------------------------------- */

export class SankeyNode extends NodeWithRightAccordionGraph {
    static menuTitle = "Sankey"
    static socketTypes = {
        inputs: [SOCKET.FORMULA_COLLECTION],
        outputs: [SOCKET.FORMULA_COLLECTION]
    }

    constructor(title, inputs, outputs, origin, destinationFlow, position = {x: 180, y: 10}) {
        super(title, inputs, outputs, origin, destinationFlow, position)
        this.parameters = {
            ...this.parameters,
            sortMode: "mass",
            sortOrder: "asc",
            groupMode: "elements",
            linkValue: "mass"
        }
        this.svg = null
        this.graphHost = null
        this.sankeyData = null
        this.lastCollections = null
        this._redrawFrame = null
        this._sizeRetries = 0
    }

    createGraph(dialog, label) {
        return null
    }

    registered(e) {
        super.registered(e)
        if (this.accordion) {
            this.renderAccordion()
        }
        this.drawSankey()
    }

    /* Refresh on open: a link created afterwards triggers no global resolve,
       so the diagram would otherwise keep its previous state. */
    reveal() {
        this.refreshFromLinks()
        super.reveal()
    }

    /* ---------------------------------------------------------------------
       READING THE MULTIPLEXED INPUT

       Flow.parentSynapse fills ONE Map<parent, outputs[]> with EVERY link
       landing on the anchor: a hundred cables on one input behave like one.
       Each parent may publish several outputs, and each output may itself be
       a single collection or an ARRAY of collections (this is what
       FormulaCollectionNode and AttributionNode do).

       So we walk the Map parent by parent, output by output, and descend
       recursively through arrays/objects until a collection is recognized.
       The accepted shapes are the same as FormulaCollectionNode's reader —
       a Formula/Stoichiometry alone, an array of formulas, a
       {name, formulas|entries|items} object, and a real FormulaCollection —
       so that anything readable upstream is readable here.

       `seen` avoids counting the same collection twice when several cables
       connect the same parent to the same input (the output is then repeated
       in the `values` array).
       --------------------------------------------------------------------- */
    collectCollections() {
        const collections = []
        const seen = new Set()
        for (const input of this.inputs) {
            if (!(input instanceof Map)) continue
            for (const [parent, values] of input) {
                const parentName = parent?.events?.registrationName ?? parent?.title ?? "collection"
                for (const output of values ?? []) {
                    this.collectFromOutput(output, parentName, collections, seen)
                }
            }
        }
        this.lastCollections = collections
        return collections
    }

    collectFromOutput(value, parentName, collections, seen, depth = 0) {
        if (value == null || depth > 16) return
        if (!this.remember(value, seen)) return

        if (value instanceof FormulaCollection) {
            const collection = this.asCollection(value, parentName)
            if (collection) collections.push(collection)
            return
        }
        if (value instanceof Formula || value instanceof Stoichiometry) {
            const collection = this.asCollection(value, parentName)
            if (collection) collections.push(collection)
            return
        }
        if (Array.isArray(value)) {
            if (this.isFormulaList(value)) {
                const collection = this.asCollection(value, parentName)
                if (collection) collections.push(collection)
                return
            }
            for (const child of value) {
                this.collectFromOutput(child, parentName, collections, seen, depth + 1)
            }
            return
        }
        if (value instanceof Map) {
            for (const child of value.values()) {
                this.collectFromOutput(child, parentName, collections, seen, depth + 1)
            }
            return
        }
        if (typeof value === "object") {
            const formulas = value.formulas ?? value.entries ?? value.items
            if (Array.isArray(formulas)) {
                const collection = this.asCollection(value, parentName)
                if (collection) collections.push(collection)
                return
            }
            if (value.formula != null || value.notation != null || value.key != null) {
                const collection = this.asCollection(value, parentName)
                if (collection) collections.push(collection)
                return
            }
            const proto = Object.getPrototypeOf(value)
            if (proto === Object.prototype || proto === null) {
                for (const child of Object.values(value)) {
                    if (child && typeof child === "object") {
                        this.collectFromOutput(child, parentName, collections, seen, depth + 1)
                    }
                }
            }
        }
    }

    remember(value, seen) {
        if (!value || typeof value !== "object") return true
        if (seen.has(value)) return false
        seen.add(value)
        return true
    }

    isFormulaList(entries) {
        return entries.length > 0 && entries.every(entry => {
            if (entry instanceof Formula || entry instanceof Stoichiometry) return true
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
            if (entry instanceof FormulaCollection) return false
            if (Array.isArray(entry.formulas) || Array.isArray(entry.entries) || Array.isArray(entry.items)) {
                return false
            }
            return entry.formula != null || entry.notation != null || entry.key != null
        })
    }

    asCollection(item, parentName = "collection") {
        if (!item) return null
        if (item instanceof FormulaCollection) {
            const formulas = [...item.entries].map(entry => this.flatFormula(entry)).filter(Boolean)
            return formulas.length
                ? {name: item.name ?? parentName, formulas}
                : null
        }
        if (Array.isArray(item)) {
            const formulas = item.map(entry => this.flatFormula(entry)).filter(Boolean)
            return formulas.length ? {name: parentName, formulas} : null
        }
        if (typeof item === "object") {
            const formulas = item.formulas ?? item.entries ?? item.items
            if (Array.isArray(formulas)) {
                const flat = formulas.map(entry => this.flatFormula(entry)).filter(Boolean)
                return flat.length
                    ? {name: item.name ?? item.title ?? parentName, formulas: flat}
                    : null
            }
            if (item.formula != null || item.notation != null || item.key != null) {
                const formula = this.flatFormula(item)
                return formula
                    ? {name: item.name ?? parentName, formulas: [formula]}
                    : null
            }
        }
        return null
    }

    numberOr(...values) {
        for (const value of values) {
            const number = Number(value)
            if (Number.isFinite(number)) return number
        }
        return 0
    }

    /* `Number(undefined)` is NaN, and `NaN ?? 0` is NaN: the old
       `Number(x) ?? y` therefore NEVER fell back to the second term. An entry
       without `mass` produced a NaN mass, a NaN thickness scale and a graph
       with invisible flows. */
    flatFormula(entry) {
        if (entry == null) return null
        const nested = (entry.formula instanceof Formula || entry.formula instanceof Stoichiometry)
            ? entry.formula
            : null
        if (entry instanceof Stoichiometry || entry instanceof Formula || nested) {
            const formula = nested ?? entry
            return {
                key: entry.key ?? formula.key ?? String(formula),
                notation: entry.notation ?? String(formula),
                mz: this.numberOr(entry.mz, entry.mass, formula.mz, formula.mass),
                mass: this.numberOr(entry.mass, entry.mz, formula.mass, formula.mz),
                charge: this.numberOr(entry.charge, formula.charge),
                molecule: entry.molecule ?? formula.root?.moleculeKey ?? formula.moleculeKey ?? null,
                intensity: 0,
                note: entry.note ?? ""
            }
        }
        return {
            key: String(entry.key ?? entry.notation ?? entry),
            notation: String(entry.notation ?? entry.key ?? entry),
            mz: this.numberOr(entry.mz, entry.mass),
            mass: this.numberOr(entry.mass, entry.mz),
            charge: this.numberOr(entry.charge),
            molecule: entry.molecule ?? null,
            intensity: this.numberOr(entry.intensity),
            note: entry.note ?? ""
        }
    }

    elementsOf(formula) {
        if (formula instanceof Stoichiometry || formula instanceof Formula) {
            const comp = formula.composition
            if (comp instanceof Map && comp.size) {
                return [...comp.keys()].map(el => el.symbol).sort()
            }
        }
        const notation = formula.notation || formula.key || ""
        const symbols = new Set()
        for (const m of notation.matchAll(/[A-Z][a-z]?/g)) {
            symbols.add(m[0])
        }
        return [...symbols].sort()
    }

    groupKey(elements) {
        return elements.join("")
    }

    /* The nature of the group is a SETTING, and it must be read here.
       The old version always built the "elements present" key, so the
       "Each formula separately" selector changed nothing. */
    groupDescriptor(formula) {
        if (this.parameters.groupMode === "formula") {
            const label = formula.notation || formula.key || "?"
            return {key: `formula:${label}`, name: label, elements: this.elementsOf(formula)}
        }
        const elements = this.elementsOf(formula)
        const key = this.groupKey(elements)
        return {key, name: key, elements}
    }

    buildSankeyData(collections) {
        if (!collections.length) return null

        const level0Nodes = []
        const level1Map = new Map()

        let formulaIndex = 0
        for (const coll of collections) {
            for (const formula of coll.formulas) {
                if (!formula) continue
                const descriptor = this.groupDescriptor(formula)

                let groupNode = level1Map.get(descriptor.key)
                if (!groupNode) {
                    groupNode = {
                        id: `group:${descriptor.key}`,
                        name: descriptor.name,
                        level: 1,
                        elements: descriptor.elements,
                        formulas: [],
                        totalValue: 0
                    }
                    level1Map.set(descriptor.key, groupNode)
                }

                const node = {
                    id: `formula:${formulaIndex++}`,
                    name: formula.notation || formula.key || `f${formulaIndex}`,
                    level: 0,
                    collection: coll.name,
                    formula,
                    elements: descriptor.elements,
                    groupKey: descriptor.key,
                    value: this.linkValueFor(formula),
                    mass: formula.mass || 0,
                    intensity: formula.intensity || 0
                }
                level0Nodes.push(node)
                groupNode.formulas.push(node)
            }
        }

        if (!level0Nodes.length) return null

        const sorted = this.sortFormulas(level0Nodes)

        /* A collection whose masses are missing (or zero) produced
           zero-thickness flows: an empty graph even though formulas exist.
           We fall back to one unit per formula to keep the diagram readable. */
        const totalValue = sorted.reduce((sum, node) => sum + Math.max(0, node.value || 0), 0)
        if (totalValue <= 0) {
            for (const node of sorted) node.value = 1
        }

        const level1Nodes = [...level1Map.values()]
        for (const group of level1Nodes) group.totalValue = 0

        const links = []
        for (const node of sorted) {
            const group = level1Map.get(node.groupKey)
            if (!group) continue
            group.totalValue += node.value
            links.push({
                source: node,
                target: group,
                value: node.value,
                name: node.name
            })
        }

        level1Nodes.sort((a, b) => b.totalValue - a.totalValue)
        const total = level1Nodes.reduce((sum, group) => sum + Math.max(0, group.totalValue || 0), 0)
        for (const group of level1Nodes) {
            group.share = total > 0 ? Math.max(0, group.totalValue || 0) / total : 0
        }
        for (const node of sorted) {
            node.share = total > 0 ? Math.max(0, node.value || 0) / total : 0
            node.groupName = level1Map.get(node.groupKey)?.name ?? ""
        }

        return {
            nodes: [...sorted, ...level1Nodes],
            links,
            level1Nodes,
            level0Nodes: sorted,
            collectionCount: collections.length
        }
    }

    /* Scale both columns to an IDENTICAL, CONTIGUOUS height.
       There is no 2 px minimum and no gutter: with many formulas the nodes
       become thinner than a pixel, but every slice touches its neighbour, so
       the column reads as one bar and each block's height is exactly its
       share. The vertical scale `ky` is shared by both columns, so ribbon
       thickness is identical on each side. */
    layoutSankey(data, width, height) {
        const margin = {top: 44, right: 10, bottom: 14, left: 10}
        const available = Math.max(1, height - margin.top - margin.bottom)
        const nodeWidth = Math.min(200, Math.max(90, width * 0.22))

        const level0 = data.level0Nodes
        const level1 = data.level1Nodes
        const sum0 = level0.reduce((sum, node) => sum + Math.max(0, node.value || 0), 0)
        const sum1 = level1.reduce((sum, node) => sum + Math.max(0, node.totalValue || 0), 0)
        const sum = Math.max(sum0, sum1, 1)
        const ky = available / sum

        const leftX = margin.left
        const rightX1 = width - margin.right
        const rightX0 = rightX1 - nodeWidth

        const placeColumn = (nodes, valueKey, x0, x1) => {
            let y = margin.top
            for (const node of nodes) {
                const nodeHeight = Math.max(0, (node[valueKey] || 0) * ky)
                node.x0 = x0
                node.x1 = x1
                node.y0 = y
                node.y1 = y + nodeHeight
                node._outOffset = y
                node._inOffset = y
                y = node.y1
            }
        }

        placeColumn(level0, "value", leftX, leftX + nodeWidth)
        placeColumn(level1, "totalValue", rightX0, rightX1)

        for (const link of data.links) {
            const thickness = Math.max(0, link.value * ky)
            link.width = thickness
            link.y0 = link.source._outOffset + thickness / 2
            link.y1 = link.target._inOffset + thickness / 2
            link.source._outOffset += thickness
            link.target._inOffset += thickness
        }

        data.width = width
        data.height = height
        data.margin = margin
        data.nodeWidth = nodeWidth
        data.level0X0 = leftX
        data.level0X1 = leftX + nodeWidth
        data.level1X0 = rightX0
        data.level1X1 = rightX1
        return data
    }

    linkValueFor(formula) {
        const mode = this.parameters.linkValue || "mass"
        let value
        if (mode === "count") value = 1
        else if (mode === "intensity") value = formula.intensity
        else value = formula.mass
        value = Number(value)
        return Number.isFinite(value) && value > 0 ? value : 0
    }

    sortFormulas(nodes) {
        const mode = this.parameters.sortMode || "mass"
        const order = this.parameters.sortOrder || "asc"
        const dir = order === "desc" ? -1 : 1
        return [...nodes].sort((a, b) => {
            let va, vb
            if (mode === "mass") {
                va = a.mass || 0
                vb = b.mass || 0
            } else if (mode === "intensity") {
                va = a.intensity || 0
                vb = b.intensity || 0
            } else {
                va = (a.name || "").toLowerCase()
                vb = (b.name || "").toLowerCase()
                return va < vb ? -dir : va > vb ? dir : 0
            }
            return va < vb ? -dir : va > vb ? dir : 0
        })
    }

    /* ---------------------------------------------------------------------
       DRAWING
       --------------------------------------------------------------------- */
    ensureGraphHost(content) {
        if (this.graphHost && this.graphHost.parentElement === content) {
            return this.graphHost
        }
        content.replaceChildren()
        const host = CE("div", {
            style: {
                position: "relative",
                width: "100%",
                height: "100%",
                overflow: "hidden"
            }
        }, [])
        /* The app's ResizeObserver and Dialog.notifyContentResized() look for
           this hook: without it, resizing or unfolding the window left the SVG
           at its original size. */
        host.handleResize = () => this.scheduleRedraw()
        this.graphHost = host
        content.append(host)
        return host
    }

    scheduleRedraw() {
        if (this._redrawFrame) return
        this._redrawFrame = requestAnimationFrame(() => {
            this._redrawFrame = null
            this.drawSankey()
        })
    }

    drawSankey() {
        const content = this.graphDialog?.DOMelt?.content
        if (!content) return
        const host = this.ensureGraphHost(content)
        if (!host) return

        const width = Math.floor(host.clientWidth)
        const height = Math.floor(host.clientHeight)
        /* A folded (or not-yet-measured) content is 0×0: retry for a few
           frames, then wait for a real resize. */
        if (width < 40 || height < 40) {
            if (this._sizeRetries < 5) {
                this._sizeRetries++
                this.scheduleRedraw()
            }
            return
        }
        this._sizeRetries = 0

        if (!this.sankeyData) {
            this.drawEmptyState(host)
            return
        }

        try {
            this.layoutSankey(this.sankeyData, width, height)
            this.renderSankey(host, this.sankeyData)
        } catch (error) {
            console.error("[Sankey] draw failed", error)
            this.drawEmptyState(host, error)
        }
    }

    renderSankey(host, data) {
        const width = data.width
        const height = data.height
        const margin = data.margin

        host.replaceChildren()
        const svg = d3.select(host)
            .append("svg")
            .attr("width", width)
            .attr("height", height)
            .attr("viewBox", `0 0 ${width} ${height}`)
            .style("width", "100%")
            .style("height", "100%")
            .style("font-family", "sans-serif")
            .style("font-size", "11px")

        this.svg = svg.node()

        svg.append("text")
            .attr("x", margin.left)
            .attr("y", 18)
            .attr("font-weight", "bold")
            .attr("fill", "#333")
            .text(`Sankey — ${data.collectionCount} collection(s), ${data.level0Nodes.length} target(s) → ${data.level1Nodes.length} group(s)`)

        svg.append("text")
            .attr("x", data.level0X0)
            .attr("y", margin.top - 8)
            .attr("fill", "#666")
            .text("Targets")

        svg.append("text")
            .attr("x", data.level1X1)
            .attr("y", margin.top - 8)
            .attr("text-anchor", "end")
            .attr("fill", "#666")
            .text("Groups")

        const groupColors = d3.scaleOrdinal()
            .domain(data.level1Nodes.map(node => node.id))
            .range(d3.schemeCategory10)

        /* The ribbons: their thickness is the flow's, and their stacking
           order along the nodes comes from layoutSankey. */
        svg.append("g")
            .attr("class", "links")
            .selectAll("path")
            .data(data.links)
            .join("path")
            .attr("fill", link => groupColors(link.target.id))
            .attr("fill-opacity", 0.45)
            .attr("stroke", "none")
            .attr("d", link => this.sankeyLinkPath(link))
            .append("title")
            .text(link => `${link.source.name} → ${link.target.name} (${this.formatValue(link.value)})`)

        /* Target column: no molecule label (it crowded the column); the name
           and mass remain in the tooltip. */
        const node0 = svg.append("g")
            .attr("class", "nodes level0")
            .selectAll("g")
            .data(data.level0Nodes)
            .join("g")
            .style("cursor", "pointer")

        node0.append("rect")
            .attr("x", node => node.x0)
            .attr("y", node => node.y0)
            .attr("width", node => Math.max(0.5, node.x1 - node.x0))
            .attr("height", node => Math.max(0, node.y1 - node.y0))
            .attr("fill", "#5a8fbf")
            .attr("stroke", "#333")
            .attr("stroke-width", 0.5)
            .attr("rx", 2)
            /* The tooltip is attached to the RECT, not the group: browsers show
               a <title> for the element under the cursor, and the thin bars are
               now unlabelled, so this is the only way to read them. */
            .append("title")
            .text(node => [
                node.name,
                node.collection,
                node.groupName ? `group: ${node.groupName} (${this.formatPercent(node.share)})` : null,
                `m/z ${(node.mass || 0).toFixed(3)}`,
                `value: ${this.formatValue(node.value)}`
            ].filter(Boolean).join("\n"))

        /* Group column: the label stays, with a contrasting text colour
           (black on light colours, white on dark ones). */
        const node1 = svg.append("g")
            .attr("class", "nodes level1")
            .selectAll("g")
            .data(data.level1Nodes)
            .join("g")
            .style("cursor", "pointer")

        node1.append("rect")
            .attr("x", node => node.x0)
            .attr("y", node => node.y0)
            .attr("width", node => Math.max(0.5, node.x1 - node.x0))
            .attr("height", node => Math.max(0, node.y1 - node.y0))
            .attr("fill", node => groupColors(node.id))
            .attr("stroke", "#333")
            .attr("stroke-width", 0.5)
            .attr("rx", 2)

        node1.append("title")
            .text(node => `${node.name} — ${node.formulas.length} formula(s) — ${this.formatPercent(node.share)}`)

        node1.append("text")
            .attr("x", node => node.x0 + 8)
            .attr("y", node => (node.y0 + node.y1) / 2)
            .attr("dominant-baseline", "central")
            .attr("fill", node => this.textColorFor(groupColors(node.id)))
            .attr("font-size", "11px")
            .attr("font-weight", "bold")
            .text(node => this.groupLabel(node))
    }

    /* Sankey ribbon: two Bezier curves with the flow's thickness between
       them, instead of a simple stroke centred on the nodes. */
    sankeyLinkPath(link) {
        const x0 = link.source.x1
        const x1 = link.target.x0
        const xi = d3.interpolateNumber(x0, x1)
        const x2 = xi(0.5)
        const x3 = xi(0.5)
        const y0 = link.y0
        const y1 = link.y1
        const half = Math.max(0, link.width || 0) / 2
        return `M${x0},${y0 - half} C${x2},${y0 - half} ${x3},${y1 - half} ${x1},${y1 - half}`
            + ` L${x1},${y1 + half} C${x3},${y1 + half} ${x2},${y0 + half} ${x0},${y0 + half} Z`
    }

    textColorFor(color) {
        const parsed = d3.color(color)
        if (!parsed) return "#111"
        const rgb = parsed.rgb()
        const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
        return luminance > 0.55 ? "#111" : "#fff"
    }

    formatValue(value) {
        if (this.parameters.linkValue === "count") return String(Math.round(value))
        return value.toFixed(2)
    }

    formatPercent(share) {
        const percent = Math.max(0, Number(share) || 0) * 100
        if (percent > 0 && percent < 0.1) return "<0.1%"
        return percent >= 10 ? `${percent.toFixed(0)}%` : `${percent.toFixed(1)}%`
    }

    /* The percentage is added INSIDE the same label, and the name is
       truncated by as much: on a narrow bar, the name gives way, never the
       percentage. */
    groupLabel(node) {
        const suffix = ` (${this.formatPercent(node.share)})`
        const budget = Math.max(1, Math.floor((node.x1 - node.x0) / 7) - suffix.length)
        return this.shorten(node.name, budget) + suffix
    }

    drawEmptyState(host, error = null) {
        if (!host) return
        host.replaceChildren()
        const box = CE("div", {
            style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
                height: "100%",
                minHeight: "200px",
                padding: "20px",
                color: "#666",
                fontStyle: "italic",
                textAlign: "center"
            }
        }, [])
        box.append(CE("div", {}, ["This node has nothing to plot. Connect a formula collection to its input, then resolve."]))
        const collections = this.lastCollections
        if (collections) {
            const formulas = collections.reduce((sum, collection) => sum + collection.formulas.length, 0)
            box.append(CE("div", {style: {fontSize: "0.85em", fontStyle: "normal"}}, [
                `${collections.length} collection(s), ${formulas} formula(s) received.`
            ]))
        }
        if (error) {
            box.append(CE("div", {style: {fontSize: "0.85em", color: "#b00", fontStyle: "normal"}}, [
                `Draw error: ${error.message ?? error}`
            ]))
        }
        host.append(box)
    }

    shorten(text, max) {
        const value = String(text ?? "")
        if (max <= 1) return ""
        return value.length > max ? value.slice(0, Math.max(1, max - 1)) + "…" : value
    }

    /* ---------------------------------------------------------------------
       RIGHT PANEL
       --------------------------------------------------------------------- */
    renderAccordion() {
        const content = this.accordion?.DOMelt?.content
        if (!content) return
        content.replaceChildren()

        content.append(CE("div", {
            style: { fontWeight: "bold", fontSize: "1.1em", marginBottom: "8px", color: "#333" }
        }, ["Sankey — settings"]))

        content.append(CE("div", { style: { fontWeight: "bold", marginTop: "8px" } }, ["Target sort (level 1)"]))

        const sortGroup = CE("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [])
        sortGroup.append(CE("span", {}, ["Criterion: "]))
        const sortSel = CE("select", {
            style: { flex: "1" },
            onchange: (e) => { this.parameters.sortMode = e.target.value; this.resolve() }
        }, [])
        const sortModes = ["mass", "intensity", "name"]
        for (const mode of sortModes) {
            sortSel.append(CE("option", { value: mode }, [mode === "mass" ? "Mass" : mode === "intensity" ? "Intensity" : "Name"]))
        }
        sortSel.value = this.parameters.sortMode
        sortGroup.append(sortSel)

        const orderSel = CE("select", {
            style: { width: "70px" },
            onchange: (e) => { this.parameters.sortOrder = e.target.value; this.resolve() }
        }, [])
        orderSel.append(CE("option", { value: "asc" }, ["Ascending"]))
        orderSel.append(CE("option", { value: "desc" }, ["Descending"]))
        orderSel.value = this.parameters.sortOrder
        sortGroup.append(orderSel)
        content.append(sortGroup)

        content.append(CE("div", { style: { fontWeight: "bold", marginTop: "12px" } }, ["Groups (subsequent levels)"]))

        const groupGroup = CE("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [])
        groupGroup.append(CE("span", {}, ["Mode: "]))
        const groupSel = CE("select", {
            style: { flex: "1" },
            onchange: (e) => { this.parameters.groupMode = e.target.value; this.resolve() }
        }, [])
        groupSel.append(CE("option", { value: "elements" }, ["Elements present (e.g. CHO)"]))
        groupSel.append(CE("option", { value: "formula" }, ["Each formula separately"]))
        groupSel.value = this.parameters.groupMode
        groupGroup.append(groupSel)
        content.append(groupGroup)

        content.append(CE("div", { style: { fontWeight: "bold", marginTop: "12px" } }, ["Flow thickness"]))

        const linkGroup = CE("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [])
        linkGroup.append(CE("span", {}, ["Value: "]))
        const linkSel = CE("select", {
            style: { flex: "1" },
            onchange: (e) => { this.parameters.linkValue = e.target.value; this.resolve() }
        }, [])
        linkSel.append(CE("option", { value: "mass" }, ["Mass"]))
        linkSel.append(CE("option", { value: "count" }, ["Count"]))
        linkSel.append(CE("option", { value: "intensity" }, ["Intensity"]))
        linkSel.value = this.parameters.linkValue
        linkGroup.append(linkSel)
        content.append(linkGroup)

        const redrawBtn = CE("button", {
            style: { marginTop: "10px", padding: "4px 10px", cursor: "pointer" },
            onclick: () => this.resolve()
        }, ["Redraw graph"])
        content.append(redrawBtn)

        const info = CE("div", {
            style: { marginTop: "10px", fontSize: "0.85em", color: "#666", fontStyle: "italic" }
        }, ["Default: targets sorted by ascending mass; groups by elements present."])
        content.append(info)
    }

    async resolve() {
        this.status = "pending"
        const collections = this.collectCollections()
        this.sankeyData = this.buildSankeyData(collections)
        this.drawSankey()
        this.publishOutput()
        this.status = this.sankeyData ? "resolved" : "floating"
    }

    async startResolve() {
        await this.resolve()
    }

    refreshFromLinks() {
        this.destination?.syncInputs(this).then(() => {
            const hasData = this.inputs.some(input => input instanceof Map && input.size > 0)
            if (hasData) {
                this.startResolve()
            } else {
                this.sankeyData = null
                this.status = "floating"
                this.drawSankey()
            }
        })
    }

    publishOutput() {
        const published = []
        for (const collection of this.lastCollections ?? []) {
            published.push({
                name: collection.name,
                formulas: collection.formulas.map(formula => ({
                    key: formula.key,
                    notation: formula.notation,
                    mz: formula.mz,
                    mass: formula.mass,
                    charge: formula.charge,
                    molecule: formula.molecule,
                    intensity: formula.intensity,
                    note: formula.note
                }))
            })
        }
        if (!this.outputs.length) this.outputs.push(null)
        this.outputs[0] = published.length ? published : null
        this.resolveChildren()
    }

    serializeState() {
        return {
            sortMode: this.parameters.sortMode,
            sortOrder: this.parameters.sortOrder,
            groupMode: this.parameters.groupMode,
            linkValue: this.parameters.linkValue
        }
    }

    restoreState(state) {
        if (!state || typeof state !== "object") return
        if (typeof state.sortMode === "string") this.parameters.sortMode = state.sortMode
        if (typeof state.sortOrder === "string") this.parameters.sortOrder = state.sortOrder
        if (typeof state.groupMode === "string") this.parameters.groupMode = state.groupMode
        if (typeof state.linkValue === "string") this.parameters.linkValue = state.linkValue
        this.renderAccordion()
    }

    restoreAfterImport() {
        super.restoreAfterImport()
        this.status = "floating"
        if (this.inputs.some(input => input instanceof Map && input.size > 0)) {
            this.startResolve()
        } else {
            this.drawSankey()
        }
    }

    suicide(options = {}) {
        if (this._redrawFrame) {
            cancelAnimationFrame(this._redrawFrame)
            this._redrawFrame = null
        }
        this.svg = null
        this.graphHost = null
        this.sankeyData = null
        super.suicide(options)
    }
}
