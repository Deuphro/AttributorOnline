# Third-Party Licenses

This project uses the following third-party libraries and derived works. Each entry includes the license, copyright holder, and source.

---

## thermorawfile (crates.io)

**Version used:** 0.1.0 (patched for Rust 1.78 compatibility)  
**License:** MIT OR Apache-2.0 (dual-licensed)  
**Author:** David Teschner (theGreatHerrLebert)  
**Source:** https://crates.io/crates/thermorawfile  
**Repository:** https://github.com/theGreatHerrLebert/thermorawfile  

### Usage in this project
- Used via `attribrustor` WASM module to parse Thermo Fisher `.raw` files
- Patched locally (`XOP/thermorawfile-patched/`) to fix `is_none_or` compatibility with Rust 1.78
- Provides `RawFile::from_bytes()`, `centroid_peaks()`, `profile()`, `calibration_at_event()`, `scan_event_byte_offset()`

### License text (MIT)
```
MIT License

Copyright (c) 2026 David Teschner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## unthermo (proteinspector)

**License:** Apache-2.0  
**Author:** Pieter Kelchtermans (proteinspector)  
**Repository:** https://github.com/proteinspector/unthermo  

### Role in this project
The `thermorawfile` crate's binary layout knowledge derives from the Apache-2.0 `unthermo` project. The `thermorawfile` crate includes a `NOTICE` file as required by Apache-2.0.

### License text (Apache-2.0)
```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) the beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from the Work, or non-substantive modifications such as
      formatting or other formatting.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Source form, that is intentionally submitted to
      Licensor for inclusion in the Work by the copyright owner or by
      an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this License, "submitted"
      means any form of electronic, verbal, or written communication sent
      to Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, bulletin board systems,
      and similar communication channels, but excluding communication that
      is conspicuously marked as "private" or "confidential."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently added within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as provided in this License) patent license to make, have
      made, use, offer to sell, sell, import, and otherwise transfer the
      Work, where such license applies only to those patent claims
      licensable by such Contributor that are necessarily infringed by
      their Contribution of the Work alone. If You institute patent
      litigation against any entity (including a cross-claim or counterclaim
      in a lawsuit) alleging that the Work or a Derivative Work of the
      Work constitutes a patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is instituted.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in Source or Object form, with
      or without modifications, and with or without the following
      conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain all copyright, patent, trademark, and
          attribution notices from the Source form of the Work in
          any Derivative Works that You distribute; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in Derivative Works
          that You distribute. You may add Your own attribution notices
          within Derivative Works that You distribute, alongside or as an
          addendum to the NOTICE text from the Work, provided that such
          additional attribution notices cannot be construed as an
          admission of liability or as an admission of any kind.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution submitted to the Licensor for inclusion in the
      Work shall be under the terms and conditions of this License,
      without any additional terms or conditions. Notwithstanding the
      above, nothing herein shall supersede the terms and conditions
      of any separate license agreement You may have with Licensor
      regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use of the Work
      to describe the origin of the Work and does not grant permission
      to use the trade names, trademarks, service marks, or product names
      of the Licensor for any purpose other than to describe the origin of
      the Work.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and Derivative
      Works) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
      KIND, either express or implied, including, but not limited to,
      warranties of MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
      AND NON-INFRINGEMENT. Licensor does not assume any responsibility
      for the use of the Work by any third party.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      shall any Contributor be liable to You for damages, including any
      direct, indirect, incidental, special, exemplary, or consequential
      damages (including lost time, salary, or cost of goods) arising
      out of or related to the use of the Work, even if advised of the
      possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, the acceptance of any warranty or additional
      liability associated with the Work. Such voluntary actions are
      wholly within Your discretion, and You are not required to offer
      such warranty or additional liability. If You do offer such warranty
      or additional liability, the corresponding Contributor is not
      required to offer such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be wrapped with 72-character
      lines.

         Copyright [yyyy] [name of copyright owner]

         Licensed under the Apache License, Version 2.0 (the "License");
         you may not use this file except in compliance with the License.
         You may obtain a copy of the License at

             http://www.apache.org/licenses/LICENSE-2.0

         Unless required by applicable law or agreed to in writing, software
         distributed under the License is distributed on an "AS IS" BASIS,
         WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
         implied. See the License for the specific language governing
         permissions and limitations under the License.
```

---

## OpenTFRaw (Sigilweaver)

**License:** Apache-2.0  
**Author:** Nathan Riley (Sigilweaver)  
**Repository:** https://github.com/Sigilweaver/OpenTFRaw  

### Role in this project
The `thermorawfile` crate acknowledges that its binary layout knowledge derives from OpenTFRaw (Apache-2.0). The reverse-engineered format notes from OpenTFRaw's public corpus analysis were used as a reference.

### License text
Same as Apache-2.0 above.

---

## unfinnigan

**License:** Apache-2.0 (or public domain / permissive)  
**Author:** Gene Selkov  
**Repository:** https://github.com/geneselkov/unfinnigan  

### Role in this project
The `thermorawfile` crate acknowledges that its binary layout knowledge derives from unfinnigan.

### License text
Same as Apache-2.0 above.

---

## Attribution Summary for thermorawfile crate

The `thermorawfile` crate (version 0.1.0) states in its README:

> Dual-licensed under **MIT OR Apache-2.0**. Binary layout knowledge derives from the Apache-2.0 `unthermo` (Apache-2.0, Pieter Kelchtermans / proteinspector), `OpenTFRaw` (Apache-2.0, reverse-engineered from public PRIDE deposits), and `unfinnigan` (Gene Selkov). The v66 scan-event layout, preamble offsets, and frequency↔m/z calibration all agree with those public sources. No Thermo SDK, DLL, or proprietary code is used or linked.

The crate includes a `NOTICE` file as required by Apache-2.0 for the derived works.

---

## This Project's License

The Attributor Online application itself (the JavaScript/TypeScript/Rust code in this repository) is licensed under its own terms. The third-party dependencies above are used as libraries and their licenses apply only to those specific components.

For the main project license, see `LICENSE` (if present) or the project's distribution terms.

---

## ws (WebSocket library)

**Version used:** 8.21.3  
**License:** ISC  
**Author:** Einar Otto Stangvik  
**Source:** https://github.com/websockets/ws  
**Repository:** https://github.com/websockets/ws  

### Usage in this project
- Used in `chat-server.js` for the optional WebSocket chat server (enabled via `ENABLE_CHAT=true`)
- Provides `WebSocket.Server` and `WebSocket` client

### License text (ISC)
```
ISC License

Copyright (c) 2011-2024 Einar Otto Stangvik, et al.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## D3.js (Data-Driven Documents)

**Version used:** 7.x (loaded via CDN from cdn.jsdelivr.net/npm/d3@7/+esm)  
**License:** BSD-3-Clause  
**Author:** Mike Bostock  
**Source:** https://d3js.org  
**Repository:** https://github.com/d3/d3  

### Usage in this project
- Used in `scripts/core/index.js` for data visualization, scales, axes, selections
- Imported as ES module from CDN

### License text (BSD-3-Clause)
```
Copyright (c) 2010-2024 Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of the author nor the names of contributors may be used
  to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

---

## Three.js

**Version used:** Loaded dynamically via CDN constant `THREE_CDN` in `scripts/plot2d-gl.js`  
**License:** MIT  
**Author:** Ricardo Cabello (mrdoob) and contributors  
**Source:** https://threejs.org  
**Repository:** https://github.com/mrdoob/three.js  

### Usage in this project
- Used in `scripts/plot2d-gl.js` for WebGL 3D rendering (optional, loaded on demand)
- The `THREE_CDN` constant points to a CDN URL for the Three.js library

### License text (MIT)
```
The MIT License

Copyright (c) 2010-2024 Ricardo Cabello, mrdoob, and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```