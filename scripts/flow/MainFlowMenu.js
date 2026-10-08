import {Menu} from "./Menu.js"
import {Command,Node,NodeWithAccordion,Operation,nodeRestoreData} from "../core/index.js"
import {
    AttributionNode,
    CalibrationNode,
    ChatNode,
    DelimitedTextNode,
    FKMDNode,
    FormulaCollectionNode,
    NodeWithAccordionGraph,
    NodeWithRightAccordionGraph,
    PeakPickingNode,
    SimpleXYPlotNode,
    ThermoRawNode,
    TrimmerNode
} from "../nodes/index.js"

export class MainFlowMenu extends Menu{
    constructor(configObject,title,origin,destination){
        super(configObject,title,origin,destination)
        this.events={
            broadcast:{},
            listen:{
                arrangeFlow(e){
                    origin.channel.get("mainFlow")?.arrangeNodes()
                },
                selectAllNodes(e){
                    origin.channel.get("mainFlow")?.selectAll()
                },
                clearNodeSelection(e){
                    origin.channel.get("mainFlow")?.clearSelection()
                },
                copySelectionAsPattern(e){
                    const flow=origin.channel.get("mainFlow")
                    const pattern=flow?.patternFromSelection(e.detail.msg?.name)
                    if(!pattern){
                        origin.notice?.("Nothing to save","Select one or more nodes first.")
                        return
                    }
                    origin.patterns.set(pattern.name,pattern)
                    origin.savePreferencesSoon?.()
                    origin.notice?.(
                        "Pattern saved",
                        `"${pattern.name}" holds ${pattern.nodes.length} node(s). `+
                        "Paste it from the Flow menu, in this session or another one."
                    )
                },
                pastePattern(e){
                    const name=e.detail.msg?.name
                    const pattern=origin.patterns.get(name)
                    if(!pattern){
                        origin.notice?.("No such pattern",`"${name}" was never saved.`)
                        return
                    }
                    const flow=origin.channel.get("mainFlow")
                    const created=flow?.instantiatePattern(pattern,{
                        x:40,y:40
                    })??[]
                    if(created.length){
                        flow.selectOnly(created[0])
                        flow.revealNode(created[0])
                    }
                },
                deletePattern(e){
                    const name=e.detail.msg?.name
                    if(origin.patterns.delete(name)){
                        origin.savePreferencesSoon?.()
                    }
                },
                createNode(e){
                    const {title,type,source} = e.detail.msg
                    let node
                    switch (type) {
                        case "trimmer": {
                            node = new TrimmerNode(title, origin, origin.channel.get("mainFlow"), {x:180,y:10})
                            break
                        }
                        case "fkmd": {
                            node = new FKMDNode(title, origin, origin.channel.get("mainFlow"), {x:180,y:10})
                            break
                        }
                        case "chat": {
                            node = new ChatNode(title, origin, origin.channel.get("mainFlow"), {x:180,y:10})
                            break
                        }
                        case "formulaCollection": {
                            node = new FormulaCollectionNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        }
                        case "attribution": {
                            node = new AttributionNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        }
                        case "delimitedText":
                            node = new DelimitedTextNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "thermoRaw": {
                            node = new ThermoRawNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            if(source){
                                node.parameters.source=source
                                node.updateLabel(source.fileName)
                                node.loadRawFile().then(()=>node.renderAccordion?.())
                            }
                            break
                        }
                        case "random": {
                            const inputs = []
                            const outputs = []
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                outputs.push([0])
                            }
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                inputs.push([0])
                            }
                            node = new Node(
                                title,
                                inputs,
                                outputs,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                        }
                        case "randomAccordion": {
                            const inputs = []
                            const outputs = []
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                outputs.push([0])
                            }
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                inputs.push([0])
                            }
                            node = new NodeWithAccordion(
                                title,
                                inputs,
                                outputs,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                        }
                        case "randomAccordionGraph":
                            const inputs = []
                            const outputs = []
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                outputs.push([0])
                            }
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                inputs.push([0])
                            }
                            node = new NodeWithAccordionGraph(
                                title,
                                inputs,
                                outputs,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                        case "rightAccordionGraph":
                            node = new NodeWithRightAccordionGraph(
                                title,
                                [],
                                [],
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "simpleXYPlot":
                            node = new SimpleXYPlotNode(
                                title,
                                [[]],
                                [],
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "calibration":
                            node = new CalibrationNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "operation":
                            node = new Operation(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "peakPicking":
                            node = new PeakPickingNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        default:
                            node = new Node(
                                title,
                                [],
                                [],
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                    }
                    origin.channel.register("node", node, node.title)
                    const flow=origin.channel.get("mainFlow")
                    flow?.linkNewNode(node)
                    flow?.autoLayout()
                    if(type === "delimitedText" && source){
                        node.parameters.source={labels:["x","y"],...node.parameters.source,...source}
                        node.setColumnLabels?.(node.parameters.source.labels)
                        node.updateLabel(node.parameters.source.fileName)
                        node.startResolve().then(()=>node.renderAccordion())
                    }
                    if(!origin.history.replaying){
                        const nodeData=nodeRestoreData(node)
                        origin.history.record(new Command({
                            label:`Create node ${node.title}`,
                            undo:()=>node.suicide({skipHistory:true}),
                            redo:()=>{
                                node=createNodeForHistory(origin,origin.channel.get("mainFlow"),nodeData)
                                flow?.linkNewNode(node)
                                flow?.autoLayout()
                                node.refreshFromLinks?.()
                                flow?.revealNode(node)
                            }
                        }))
                    }
                    flow?.revealNode(node)
                }
            }
        }
    }
    afterToggle(){
        const open=[...this.container.querySelectorAll(".parent.open")]
        document.body.classList.toggle("menu-open",open.length>0)
    }
}