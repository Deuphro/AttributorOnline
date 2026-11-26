# **<span style="color:#9b59b6">Attributor Online</span>**
**<span style="color:#2ecc71">Chemical Formula Attribution in Mass Spectrometry — Directly in Your Browser.</span>**

---

<span style="color:#e67e22">**Attributor**</span> is a **scientific web platform** for **molecular formula attribution** from mass spectra. It combines:
- A **high-performance compute engine** written in **Rust** and compiled to **WebAssembly** (*Attribrustor*),
- **Off-main-thread processing** for heavy computations,
- A **visual, interactive data-flow interface** for building and exploring processing pipelines.

✨ **Everything runs in your browser** — no installation required. Import your data, assemble your pipeline, and explore results in real time.

---

## <span style="color:#9b59b6">✨ Key Features</span>

---

### <span style="color:#2ecc71">🔍 Exhaustive Attribution</span>
- **Mixed-radix sieve**: Enumerates **every possible combination** of your element groups within a **ppm tolerance window** (no sampling, no heuristics).
- **Log-probability ranking**: Keeps the **best distinct readings per peak**, sorted by statistical likelihood.

---

### <span style="color:#e67e22">📊 Peak Picking</span>
- **0D Persistent Homology**: Identifies which points survive the classifier line.
- **Statistical Half-Height Width Test**: Removes broad, non-peak structures using **ppm-based median width** comparison.

---

### <span style="color:#9b59b6">🔗 Measurement Network</span>
- **Peak Linking**: Connects peaks whose gaps match reference masses.
- **Minimum Spanning Forest**: Cuts the weight curve, merges trees by **stoichiometric difference**, and propagates formulas from selected roots.

---

### <span style="color:#2ecc71">🎯 Hough Pattern Detection</span>
- Every pair of peaks **votes for the slope** of the line they define in the **(mass, defect) plane**.
- **Ridges** (elemental signatures) are extracted using **Otsu’s method**.

---

### <span style="color:#e67e22">📏 Mass Calibration</span>
- Fits a **2D error surface** over *m/z* and intensity using the attribution’s **ppm errors**.
- Applies calibration to **all linked spectra**.

---

### <span style="color:#9b59b6">🧪 Formula-Based Kendrick Analysis</span>
- **Rescales** every linked spectrum around a typed formula.
- Reports results as **mass defect**.
- **Homologous series collapse** for simplified visualization.

---

### <span style="color:#2ecc71">⚗️ Mass & Isotopic Calculator</span>
- **Monoisotopic mass**, **average mass**, *m/z*, and **full isotopic envelope**.
- **Per-isotope pinning** for precise analysis.

---
---
### <span style="color:#e67e22">🔄 Isotopic Funnel & Re-Inspection</span>
- Pairs every proposed reading with its **M+1 satellite**.
- Measures `d = measured/natural − 1`.
- Marks healthy components using a **2D Gaussian Mixture Model** (fitted via EM).
- **Re-matches peaks** to the formula with the best `d`.

---
---
### <span style="color:#9b59b6">📂 Formula Collections & Clustering</span>
- **Live, editable, exportable** set of attributed formulas.
- **Clustering** via:
  - *k-means*,
  - Spectral partitioning,
  - EM Gaussian Mixtures (**BIC-chosen** or fixed *k*).
- Optional **PCA rotation** for multidimensional analysis.

---
---
### <span style="color:#2ecc71">🧮 3D Stoichiometric Analysis</span>
- Reads attributed collections as **integer vectors** over their elements.
- **Ordered patterns** build a **cumulative integer lattice**.
- Formulas are **quotiented into stoichiometric classes**.
- Fits mass distributions (**Weßlau**, **Flory–Schulz**, **Schulz–Zimm**).

---
---
### <span style="color:#e67e22">🖥️ Large-Data Rendering</span>
- **Interactive WebGL plots** for:
  - Spectra,
  - Kendrick axes,
  - Calibration surfaces,
  - Hough plane,
  - van Krevelen spaces,
  - 3D stoichiometric clouds.
- **Smooth performance** even with large datasets (where DOM rendering would fail).

---
---
### <span style="color:#9b59b6">🛠️ Risk-Free Experimentation</span>
- **Full undo/redo history**: Revert or replay any action.
- **Parameter tuning**: Compare scenarios side-by-side.

---
---
### <span style="color:#2ecc71">💾 Portable Sessions</span>
- **Export/import** the entire pipeline as **JSON**.
- **Session versioning** for reproducibility.

---
---
### <span style="color:#e67e22">💬 Collaborative Chat</span>
- **Chat node**: Joins a **WebSocket room** for real-time discussion with other users viewing the same session.

---

---

## <span style="color:#9b59b6">📚 Documentation</span>
- **In-app technical documentation** (node catalog, node reference, compute layer conventions, memory layouts) is available on the **homepage**.
- A **desktop version** for offline use is **under development**.

---
---
## <span style="color:#2ecc71">🚀 Getting Started</span>

### <span style="color:#e67e22">📥 Installation</span>
- **No installation required!** Attributor runs entirely in your browser.
- **Recommended**: Use a **modern browser** (Chrome, Firefox, Edge, Safari) for optimal performance.

---
---
### <span style="color:#9b59b6">🎯 Example Workflow</span>
1. **Import Your Data**: Upload a mass spectrum file (`.mzML`, `.csv`, etc.).
2. **Build Your Pipeline**:
   - Add a **"Peak Picking"** node to detect peaks.
   - Add an **"Exhaustive Attribution"** node to generate formulas.
   - Link nodes to create a **data-flow pipeline**.
3. **Visualize Results**:
   - Explore attributed formulas in an **interactive 3D space**.
   - Export results as **CSV** or **JSON**.

---
---
## <span style="color:#2ecc71">🤝 Contributing</span>
We welcome contributions! Here’s how you can help:
- **Report bugs** or suggest features via [GitHub Issues](#).
- **Develop**: The backend is written in **Rust** (compiled to WASM), and the frontend uses **JavaScript/TypeScript**.
- **Test**: Try Attributor on your datasets and share feedback.

---
---
## <span style="color:#e67e22">📜 License</span>
This project is licensed under the **[MIT License](#)**.

---
---
## <span style="color:#9b59b6">🔗 Links</span>
- **[Try Attributor Online](https://attributor.fr)**
- **[GitHub Repository](https://github.com/Deuphro/AttributorOnline)**
- **[Documentation](https://doc.attributor.fr)**

---
---
### <span style="color:#2ecc71">🌟 Badges</span>
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Rust](https://img.shields.io/badge/Rust-1.70+-orange)
![WebAssembly](https://img.shields.io/badge/WebAssembly-WASM-purple)
![Status: Active](https://img.shields.io/badge/Status-Active-green)