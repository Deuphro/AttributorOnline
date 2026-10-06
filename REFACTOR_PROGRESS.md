# Refactoring Progress - interface.js → Modular Structure

## ✅ Completed
- **scripts/utils/index.js** - Created with all utilities, constants, `buildNode`, `nodeRestoreData`, `createNodeForHistory`, `NODE_CONSTRUCTORS`, `SELF_SHAPED_NODES`, `emptySlots`, `windowFor`

## 📍 Resume Points (line numbers in original interface.js)

| File to Create | Start Line | End Line | Status |
|----------------|------------|----------|--------|
| `scripts/nodes/TrimmerNode.js` | 1571 | 2784 | ⏳ Next |
| `scripts/nodes/FKMDNode.js` | 2806 | 3146 | ⏳ |
| `scripts/nodes/AttributionNode.js` | 3202 | 7109 | ⏳ |
| `scripts/nodes/PeakPickingNode.js` | 7110 | 8179 | ⏳ |
| `scripts/nodes/ChatNode.js` | 8180 | 8526 | ⏳ |
| `scripts/nodes/NodeWithAccordionGraph.js` | 8527 | 8599 | ⏳ |
| `scripts/nodes/NodeWithRightAccordionGraph.js` | 8600 | 8685 | ⏳ |
| `scripts/nodes/VirtualRowList.js` | 8686 | 9056 | ⏳ |
| `scripts/nodes/FormulaCollectionNode.js` | 9057 | 11552 | ⏳ |
| `scripts/nodes/SimpleXYPlotNode.js` | 11553 | 13886 | ⏳ |
| `scripts/ui/Plot2D.js` | 13887 | 14989 | ⏳ |
| `scripts/ui/Plot2DWebGL.js` | 14990 | 15869 | ⏳ |
| `scripts/ui/accordionUtils.js` | (from ui/index.js exports) | | ⏳ |
| `scripts/app/App.js` | 16990 | 18059 | ⏳ |
| `scripts/app/restoreSession.js` | 18066 | 18092 | ⏳ |

## 🔧 Integration Steps (after all files created)
1. Update `scripts/index.js` to export from new modules
2. Update `scripts/nodes/index.js` to include all node classes
3. Update `scripts/ui/index.js` to include Plot2D, Plot2DWebGL, accordionUtils
4. Update `scripts/app/index.js` to include App, restoreSession
5. Update `main.js` to import from new structure
6. Test, then delete `interface.js`

## 💡 Development Strategy During Pause
- **Continue developing in `interface.js`** for now (it's still the active code)
- When ready to resume refactoring: re-read `interface.js` from the resume lines above
- The `utils/index.js` is already committed and can be used immediately
- New features should ideally be added to the new modular files once they're created

## 📝 Notes
- `TrimmerNode` imports: `TRIM_METHODS`, `TRIM_LOW_COLOR`, `TRIM_HIGH_COLOR`, `CURSOR_COLORS`, `TRIM_CURSOR_STROKE`, `TRIM_CURSOR_FIELD_FONT`, `formatCursorValue`, `scaleToggle`, `binsOfHistogram`, `wavesFromInput`, `computePool`, `Wave`, `Plot2DWebGL`, `NodeWithAccordion`, `CE`, `stylize`
- `FKMDNode` imports: `Formula`, `computePool`, `Wave`, `NodeWithAccordion`, `CE`, `stylize`
- `AttributionNode` imports: `SortedPoints`, `buildPlan`, `attributeSpectrum`, `forestStandards`, `forestComponents`, `growForest`, `suggestWeightCut`, `forestGraph`, `forestRoot`, `layoutForests`, `DEFAULT_LINK_TOLERANCE`, `Formula`, `FormulaCollection`, `Wave`, `NodeWithAccordion`, `CE`, `stylize`, `scaleToggle`, `segmentToggle`