import {Node,Operation,NodeWithAccordion} from "../core/index.js"
import {
    AttributionNode,
    CalibrationNode,
    ChatNode,
    DataCollectionImportNode,
    DelimitedTextNode,
    BrukerBafNode,
    FKMDNode,
    FormulaCollectionNode,
    SankeyNode,
    HoughTransformNode,
    MassCalculatorNode,
    NodeWithAccordionGraph,
    NodeWithRightAccordionGraph,
    PeakPickingNode,
    SimpleXYPlotNode,
    StoichiometricAnalysisNode,
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
        BrukerBafNode,
        Operation,
        PeakPickingNode,
        TrimmerNode,
        FKMDNode,
        FormulaCollectionNode,
        SankeyNode,
        AttributionNode,
        ChatNode,
        CalibrationNode,
        MassCalculatorNode,
        HoughTransformNode,
        DataCollectionImportNode,
        StoichiometricAnalysisNode
    })
    for(const NodeType of [
        DelimitedTextNode,
        ThermoRawNode,
        BrukerBafNode,
        Operation,
        PeakPickingNode,
        TrimmerNode,
        FKMDNode,
        ChatNode,
        FormulaCollectionNode,
        AttributionNode,
        CalibrationNode,
        MassCalculatorNode,
        HoughTransformNode,
        DataCollectionImportNode,
        StoichiometricAnalysisNode
    ]){
        SELF_SHAPED_NODES.add(NodeType)
    }
}