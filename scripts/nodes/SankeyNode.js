import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Formula, Stoichiometry, FormulaCollection} from "../chemistry.js"
import {CE} from "../util.js"
import {SOCKET} from "../socketTypes.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"

/* -------------------------------------------------------------------------
   SankeyNode — diagramme de Sankey pour collections de formules.

   NIVEAU 1 (gauche) : cibles du spectre (formules individuelles), triées par
   masse croissante par défaut. Les étiquettes de molécules ne sont pas
   affichées (le nom reste lisible au survol) : elles encombraient la colonne.
   NIVEAU 2 (droite) : groupes de partition par éléments présents
   (ex: C6H12O6, CH4, C2H5OH → groupe "CHO").

   Chaque formule relie son groupe élémentaire. L'épaisseur du flot vaut la
   masse de la formule (configurable). Les flots sont de vrais rubans : leur
   épaisseur est empilée le long des nœuds, donc ils ne se chevauchent pas.

   Entrée  : SOCKET.FORMULA_COLLECTION  (instance ou littéral {name, formulas})
   Sortie  : SOCKET.FORMULA_COLLECTION  (pass-through des collections reçues)

   Le graphe est un SVG D3 dessiné directement dans le contenu de la fenêtre
   centrale (pas de contexte WebGL). Le panneau droit porte les réglages.
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

    /* Rafraîchir à l'ouverture : un lien créé après coup ne déclenche aucune
       resolve globale, donc le diagramme resterait sur son état précédent. */
    reveal() {
        this.refreshFromLinks()
        super.reveal()
    }

    /* ---------------------------------------------------------------------
       LECTURE DE L'ENTRÉE

       La forme documentée est Map<parent, outputs[]> où chaque output est un
       tableau de collections. Le parcours est récursif et tolérant : il descend
       jusqu'à ce qui est lisible, quelle que soit la profondeur réelle. Un
       parcours à profondeur fixe était le défaut principal : il prenait un
       tableau d'outputs pour une collection, ne trouvait jamais `.formulas`,
       et le diagramme restait vide sans aucun diagnostic.
       --------------------------------------------------------------------- */
    collectCollections() {
        const collections = []
        for (const input of this.inputs) {
            this.walkInput(input, item => {
                const collection = this.asCollection(item)
                if (collection) collections.push(collection)
            })
        }
        this.lastCollections = collections
        return collections
    }

    walkInput(value, visit, depth = 0) {
        if (value == null || depth > 8) return
        if (value instanceof FormulaCollection
            || value instanceof Formula
            || value instanceof Stoichiometry) {
            visit(value)
            return
        }
        if (Array.isArray(value)) {
            const formulaList = value.length > 0 && value.every(entry =>
                entry && typeof entry === "object"
                && !Array.isArray(entry)
                && !(entry instanceof FormulaCollection)
                && !(entry instanceof Formula)
                && !(entry instanceof Stoichiometry)
                && !Array.isArray(entry.formulas)
                && (entry.notation != null || entry.key != null || entry.formula != null))
            if (formulaList) {
                visit(value)
                return
            }
            for (const child of value) this.walkInput(child, visit, depth + 1)
            return
        }
        if (value instanceof Map) {
            for (const child of value.values()) this.walkInput(child, visit, depth + 1)
            return
        }
        if (typeof value === "object") visit(value)
    }

    asCollection(item) {
        if (!item) return null
        if (item instanceof FormulaCollection) {
            return {
                name: item.name ?? "collection",
                formulas: [...item.entries].map(entry => this.flatFormula(entry)).filter(Boolean)
            }
        }
        if (Array.isArray(item)) {
            const formulas = item.map(entry => this.flatFormula(entry)).filter(Boolean)
            return formulas.length ? {name: "collection", formulas} : null
        }
        if (item.formula || item.notation || item.key) {
            const formula = this.flatFormula(item)
            return formula ? {name: item.name ?? "formule", formulas: [formula]} : null
        }
        if (Array.isArray(item.formulas)) {
            return {
                name: item.name ?? item.title ?? "sans nom",
                formulas: item.formulas.map(entry => this.flatFormula(entry)).filter(Boolean)
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

    /* `Number(undefined)` vaut NaN, et `NaN ?? 0` vaut NaN : l'ancien
       `Number(x) ?? y` ne retombait donc JAMAIS sur le second terme. Une entrée
       sans `mass` produisait une masse NaN, une échelle d'épaisseur NaN et un
       graphe aux flots invisibles. */
    flatFormula(entry) {
        if (entry == null) return null
        if (entry instanceof Stoichiometry || entry instanceof Formula) {
            return {
                key: entry.key ?? String(entry),
                notation: String(entry),
                mz: this.numberOr(entry.mz, entry.mass),
                mass: this.numberOr(entry.mass, entry.mz),
                charge: this.numberOr(entry.charge),
                molecule: entry.root?.moleculeKey ?? entry.moleculeKey ?? null,
                intensity: 0,
                note: ""
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

    /* La nature du groupe est un RÉGLAGE, et elle doit être lue ici.
       L'ancienne version construisait toujours la clé « éléments présents »,
       donc le sélecteur « Chaque formule isolée » ne changeait rien. */
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

        /* Une collection dont les masses sont absentes (ou nulles) donnait des
           flots d'épaisseur zéro : un graphe vide alors qu'il y a des formules.
           On retombe sur une unité par formule pour garder un diagramme lisible. */
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

        return {
            nodes: [...sorted, ...level1Nodes],
            links,
            level1Nodes,
            level0Nodes: sorted
        }
    }

    /* Met les deux colonnes à l'échelle d'une hauteur IDENTIQUE.
       Aucun minimum de 2 px par nœud : avec beaucoup de formules, les nœuds
       deviennent plus fins qu'un pixel, mais tout rentre dans la fenêtre au lieu
       de déborder sous le bas. L'échelle verticale `ky` est commune aux deux
       colonnes (mêmes épaisseurs de rubans de chaque côté), puis chaque colonne
       répartit l'espace restant dans ses propres gouttières. */
    layoutSankey(data, width, height) {
        const margin = {top: 44, right: 10, bottom: 14, left: 10}
        const available = Math.max(1, height - margin.top - margin.bottom)
        const nodeWidth = Math.min(200, Math.max(90, width * 0.22))

        const level0 = data.level0Nodes
        const level1 = data.level1Nodes
        const sum0 = level0.reduce((sum, node) => sum + Math.max(0, node.value || 0), 0)
        const sum1 = level1.reduce((sum, node) => sum + Math.max(0, node.totalValue || 0), 0)
        const sum = Math.max(sum0, sum1, 1)

        const gapFor = count => count > 1 ? Math.min(6, available / (count * 3)) : 0
        const kyCandidates = []
        if (level0.length && sum0 > 0) kyCandidates.push((available - gapFor(level0.length) * (level0.length - 1)) / sum0)
        if (level1.length && sum1 > 0) kyCandidates.push((available - gapFor(level1.length) * (level1.length - 1)) / sum1)
        let ky = kyCandidates.length ? Math.min(...kyCandidates) : available / sum
        if (!Number.isFinite(ky) || ky <= 0) ky = available / sum

        const leftX = margin.left
        const rightX1 = width - margin.right
        const rightX0 = rightX1 - nodeWidth

        const placeColumn = (nodes, valueKey, x0, x1) => {
            const padCount = Math.max(0, nodes.length - 1)
            const columnSum = nodes.reduce((total, node) => total + Math.max(0, node[valueKey] || 0), 0)
            const nodeSpan = columnSum * ky
            const pad = padCount > 0 ? Math.max(0, (available - nodeSpan) / padCount) : 0
            let y = margin.top
            for (const node of nodes) {
                const nodeHeight = Math.max(0, (node[valueKey] || 0) * ky)
                node.x0 = x0
                node.x1 = x1
                node.y0 = y
                node.y1 = y + nodeHeight
                node._outOffset = y
                node._inOffset = y
                y = node.y1 + pad
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
       DESSIN
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
        /* Le ResizeObserver de l'application et Dialog.notifyContentResized()
           cherchent ce crochet : sans lui, redimensionner ou déplier la fenêtre
           laissait le SVG à sa taille d'origine. */
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
        /* Un contenu replié (ou pas encore mesuré) fait 0×0 : on retente
           quelques frames, puis on attend un vrai redimensionnement. */
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
            .text(`Sankey — ${data.level0Nodes.length} cible(s) → ${data.level1Nodes.length} groupe(s)`)

        svg.append("text")
            .attr("x", data.level0X0)
            .attr("y", margin.top - 8)
            .attr("fill", "#666")
            .text("Cibles")

        svg.append("text")
            .attr("x", data.level1X1)
            .attr("y", margin.top - 8)
            .attr("text-anchor", "end")
            .attr("fill", "#666")
            .text("Groupes")

        const groupColors = d3.scaleOrdinal()
            .domain(data.level1Nodes.map(node => node.id))
            .range(d3.schemeCategory10)

        /* Les rubans : leur épaisseur est celle du flot, et leur ordre
           d'empilement le long des nœuds vient de layoutSankey. */
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

        /* Colonne des cibles : plus d'étiquette de molécule (elle encombrait
           la colonne), le nom et la masse restent dans le tooltip. */
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

        node0.append("title")
            .text(node => `${node.name}\nm/z ${(node.mass || 0).toFixed(3)}`)

        /* Colonne des groupes : l'étiquette reste, avec une couleur de texte
           contrastée (noir sur les couleurs claires, blanc sur les sombres). */
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
            .text(node => `${node.name} — ${node.formulas.length} formule(s)`)

        node1.append("text")
            .attr("x", node => node.x0 + 8)
            .attr("y", node => (node.y0 + node.y1) / 2)
            .attr("dominant-baseline", "central")
            .attr("fill", node => this.textColorFor(groupColors(node.id)))
            .attr("font-size", "11px")
            .attr("font-weight", "bold")
            .text(node => this.shorten(node.name, Math.floor((node.x1 - node.x0) / 7)))
    }

    /* Ruban de Sankey : deux courbes de Bézier et l'épaisseur du flot entre
       elles, au lieu d'un simple trait centré sur les nœuds. */
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
        box.append(CE("div", {}, ["Ce nœud n’a rien à tracer. Reliez une collection de formules à son entrée, puis résolvez."]))
        const collections = this.lastCollections
        if (collections) {
            const formulas = collections.reduce((sum, collection) => sum + collection.formulas.length, 0)
            box.append(CE("div", {style: {fontSize: "0.85em", fontStyle: "normal"}}, [
                `${collections.length} collection(s), ${formulas} formule(s) reçue(s).`
            ]))
        }
        if (error) {
            box.append(CE("div", {style: {fontSize: "0.85em", color: "#b00", fontStyle: "normal"}}, [
                `Erreur de dessin : ${error.message ?? error}`
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
       PANNEAU DROIT
       --------------------------------------------------------------------- */
    renderAccordion() {
        const content = this.accordion?.DOMelt?.content
        if (!content) return
        content.replaceChildren()

        content.append(CE("div", {
            style: { fontWeight: "bold", fontSize: "1.1em", marginBottom: "8px", color: "#333" }
        }, ["Sankey — réglages"]))

        content.append(CE("div", { style: { fontWeight: "bold", marginTop: "8px" } }, ["Classement des cibles (niveau 1)"]))

        const sortGroup = CE("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [])
        sortGroup.append(CE("span", {}, ["Critère: "]))
        const sortSel = CE("select", {
            style: { flex: "1" },
            onchange: (e) => { this.parameters.sortMode = e.target.value; this.resolve() }
        }, [])
        const sortModes = ["mass", "intensity", "name"]
        for (const mode of sortModes) {
            sortSel.append(CE("option", { value: mode }, [mode === "mass" ? "Masse" : mode === "intensity" ? "Intensité" : "Nom"]))
        }
        sortSel.value = this.parameters.sortMode
        sortGroup.append(sortSel)

        const orderSel = CE("select", {
            style: { width: "70px" },
            onchange: (e) => { this.parameters.sortOrder = e.target.value; this.resolve() }
        }, [])
        orderSel.append(CE("option", { value: "asc" }, ["Croissant"]))
        orderSel.append(CE("option", { value: "desc" }, ["Décroissant"]))
        orderSel.value = this.parameters.sortOrder
        sortGroup.append(orderSel)
        content.append(sortGroup)

        content.append(CE("div", { style: { fontWeight: "bold", marginTop: "12px" } }, ["Groupes (niveaux suivants)"]))

        const groupGroup = CE("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [])
        groupGroup.append(CE("span", {}, ["Mode: "]))
        const groupSel = CE("select", {
            style: { flex: "1" },
            onchange: (e) => { this.parameters.groupMode = e.target.value; this.resolve() }
        }, [])
        groupSel.append(CE("option", { value: "elements" }, ["Éléments présents (ex: CHO)"]))
        groupSel.append(CE("option", { value: "formula" }, ["Chaque formule isolée"]))
        groupSel.value = this.parameters.groupMode
        groupGroup.append(groupSel)
        content.append(groupGroup)

        content.append(CE("div", { style: { fontWeight: "bold", marginTop: "12px" } }, ["Épaisseur des flots"]))

        const linkGroup = CE("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [])
        linkGroup.append(CE("span", {}, ["Valeur: "]))
        const linkSel = CE("select", {
            style: { flex: "1" },
            onchange: (e) => { this.parameters.linkValue = e.target.value; this.resolve() }
        }, [])
        linkSel.append(CE("option", { value: "mass" }, ["Masse"]))
        linkSel.append(CE("option", { value: "count" }, ["Nombre"]))
        linkSel.append(CE("option", { value: "intensity" }, ["Intensité"]))
        linkSel.value = this.parameters.linkValue
        linkGroup.append(linkSel)
        content.append(linkGroup)

        const redrawBtn = CE("button", {
            style: { marginTop: "10px", padding: "4px 10px", cursor: "pointer" },
            onclick: () => this.resolve()
        }, ["Redessiner le graphe"])
        content.append(redrawBtn)

        const info = CE("div", {
            style: { marginTop: "10px", fontSize: "0.85em", color: "#666", fontStyle: "italic" }
        }, ["Défaut : cibles classées par masse croissante ; groupes par éléments présents."])
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
