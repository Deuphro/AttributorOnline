import {Node,Operation,NodeWithAccordion} from "../core/index.js"
import {
    AttributionNode,
    CalibrationNode,
    ChatNode,
    DelimitedTextNode,
    FKMDNode,
    FormulaCollectionNode,
    MassCalculatorNode,
    NodeWithAccordionGraph,
    NodeWithRightAccordionGraph,
    PeakPickingNode,
    SimpleXYPlotNode,
    ThermoRawNode,
    TrimmerNode
} from "../nodes/index.js"
import {NODE_CONSTRUCTORS,SELF_SHAPED_NODES} from "../utils/index.js"

export function registerNodeTypes(){
    Object.assign(NODE_CONSTRUCTORS,{
        Node,
        NodeWithAccordion,
        NodeWithAccordionGraph,
        NodeWithRightAccordionGraph,
        SimpleXYPlotNode,
        DelimitedTextNode,
        ThermoRawNode,
        Operation,
        PeakPickingNode,
        PersistentHomology0DNode:PeakPickingNode,
        AntiRadioNode:PeakPickingNode,
        TrimmerNode,
        FKMDNode,
        FormulaCollectionNode,
        AttributionNode,
        ChatNode,
        CalibrationNode,
        MassCalculatorNode
    })
    for(const NodeType of [
        DelimitedTextNode,
        ThermoRawNode,
        Operation,
        PeakPickingNode,
        TrimmerNode,
        FKMDNode,
        ChatNode,
        FormulaCollectionNode,
        AttributionNode,
        CalibrationNode,
        MassCalculatorNode
    ]){
        SELF_SHAPED_NODES.add(NodeType)
    }
}