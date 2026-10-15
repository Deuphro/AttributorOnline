import * as THREE from "https://unpkg.com/three@0.160.1/build/three.module.js"

export const THREE_CDN_3D="https://unpkg.com/three@0.160.1/build/three.module.js"

/* =====================================================================
   GLSceneLayer — the BACK layer of the 3D sandwich.

   The exact counterpart of GLTraceLayer (plot2d-gl.js), and deliberately
   NOT a subclass or a parameterisation of it. GLTraceLayer is 2D BY
   CONSTRUCTION, and one setting gives it away:

       markerMaterial: depthTest:false, depthWrite:false   (plot2d-gl.js:447)
       lineMaterial:   depthTest:false, depthWrite:false   (plot2d-gl.js:459)

   That is right for a trace layer — every marker must stay visible whatever
   its depth, and a 2D chart has no meaningful depth to occlude. A surface is
   the opposite case: the z-buffer IS the readability. Occlusion off would
   draw the far side of a folded surface through its near side.

   Its other inheritance is a colour space: GLTraceLayer sets
   `outputColorSpace=LinearSRGBColorSpace` so CSS colours reach the framebuffer
   verbatim, exactly like the SVG layer. This layer's colours are computed in
   linear space and lit, so it keeps the default sRGB output and the lighting
   lands where it should.

   What is shared with GLTraceLayer, deliberately copied rather than
   inherited: the canvas-driven constructor, setViewport (a resize is a
   matrix transform and no reallocation), the context-loss listeners, and
   dispose(). What differs: a perspective camera that is never swapped, lights
   that ship with the layer, and content under a `content` group so a whole
   plot can be swapped without touching the lights.
   ===================================================================== */

export const GL3D_DEFAULTS={
    enabled:true,
    pixelRatioCap:2,
    //the cube the camera frames; also the near/far budget
    depth:2000,
    background:0x000000,
    //0 = composite over the panel, exactly like GLTraceLayer; 1 = an opaque
    //stage, which is only wanted when the surface must sit on a known colour
    backgroundAlpha:0,
    //the light rig. Enough for a surface to read as a surface without the
    //plot having to know anything about lighting
    lights:{
        ambient:1.05,
        key:1.35,
        fill:0.45,
        keyPosition:[1.6,2.2,2.8],
        fillPosition:[-2.2,-1.2,-1.6]
    }
}

export class GLSceneLayer{
    constructor(canvas,{pixelRatioCap=2,depth=2000,background=0x000000,backgroundAlpha=0,lights=GL3D_DEFAULTS.lights}={}){
        this.canvas=canvas
        this.pixelRatioCap=Math.max(1,pixelRatioCap)
        this.pixelRatio=1
        this.width=0
        this.height=0
        this.renderer=new THREE.WebGLRenderer({
            canvas,
            antialias:true,
            alpha:true,
            powerPreference:"high-performance"
        })
        /* TRANSPARENT, like GLTraceLayer (plot2d-gl.js:425), and for the same
           reason the 2D layer is: the canvas sits behind the D3/SVG overlay and
           inside a themed panel, so it must composite over whatever that panel
           is rather than paint its own rectangle. Opaque black here produced a
           black box inside a grey application — a plot-shaped hole, and the
           reason a surface could be "black on black" with nothing to compare
           it against.

           `background` stays configurable for the case where an opaque stage is
           actually wanted, but its alpha is what the default follows. */
        this.renderer.setClearColor(background,backgroundAlpha)
        this.renderer.autoClear=true
        this.renderer.outputColorSpace=THREE.SRGBColorSpace
        this.scene=new THREE.Scene()
        //the content group: a plot fills and empties THIS, and never the scene,
        //so the light rig below cannot be disposed by a trace swap
        this.content=new THREE.Group()
        this.scene.add(this.content)
        this.lights=this.buildLights(lights)
        this.scene.add(this.lights)
        //A PERSPECTIVE camera, and there is nothing to swap it with: the layer
        //is born 3D. Plot2DWebGL has to replace glLayer.camera and its own
        //glCamera alias to get any depth at all; here there is no 2D mode.
        //
        //NEAR AND FAR ARE A PLACEHOLDER, not a budget. The scene's scale is
        //unknown here — a Hough surface on [-1,1]^2 and a calibration surface
        //over m/z in the hundreds differ by three orders of magnitude — so they
        //are set from the framing distance by `setDepthRange()` and owned by
        //whoever frames the scene. A fixed near=depth/100 clipped a unit-sized
        //surface whole: it sat inside the near plane, drew nothing at all, and
        //only became visible once the camera was dragged far enough back to
        //clear it — small and long after the user had stopped expecting it.
        this.camera=new THREE.PerspectiveCamera(45,1,0.01,100)
        this.camera.position.set(3,2.4,3)
        this.camera.lookAt(0,0,0)
        this.camera.updateProjectionMatrix()
        this.raycaster=new THREE.Raycaster()
        /* Ces deux écouteurs sont nommés parce qu'ils doivent être RETIRÉS: le
           canvas survit au dispose() tant que l'élément DOM existe, et chaque
           `webglcontextrestored` déclenchait alors le rappel d'une couche
           morte. Même raison que GLTraceLayer. */
        this.onContextRestored=null
        this._onContextLost=event=>event.preventDefault()
        this._onContextRestored=()=>this.onContextRestored?.()
        canvas.addEventListener("webglcontextlost",this._onContextLost,false)
        canvas.addEventListener("webglcontextrestored",this._onContextRestored,false)
        //the objects GLSceneLayer created and must therefore dispose: anything
        //else belongs to the caller and is released by its own trace
        this._owned=[]
    }

    /* The light rig. A MeshPhongMaterial with no light in the scene renders
       PURE BLACK — there is nothing to reflect — which is exactly what a
       surface looks like if it has to bring its own lighting and does not.
       So the rig ships with the layer: one ambient for the floor, one key for
       the shape, one cool fill so a surface turned away from the key is still
       readable. */
    buildLights(spec){
        const group=new THREE.Group()
        group.name="gl3d-lights"
        const ambient=new THREE.AmbientLight(0xffffff,spec.ambient)
        const key=new THREE.DirectionalLight(0xffffff,spec.key)
        key.position.set(...spec.keyPosition)
        const fill=new THREE.DirectionalLight(0x88aacc,spec.fill)
        fill.position.set(...spec.fillPosition)
        group.add(ambient,key,fill)
        return group
    }

    /* A viewport change is a projection matrix update and one setSize: no
       buffer is touched, no geometry rebuilt. */
    setViewport(width,height){
        const w=Math.max(1,Math.round(width))
        const h=Math.max(1,Math.round(height))
        this.width=w
        this.height=h
        const ratio=Math.min(window.devicePixelRatio||1,this.pixelRatioCap)
        if(ratio!==this.pixelRatio){
            this.pixelRatio=ratio
            this.renderer.setPixelRatio(ratio)
        }
        this.renderer.setSize(w,h,false)
        //the CSS box is owned by the caller
        this.canvas.style.width=`${w}px`
        this.canvas.style.height=`${h}px`
        this.camera.aspect=w/h
        this.camera.updateProjectionMatrix()
        return true
    }
    render(){
        this.renderer.render(this.scene,this.camera)
    }
    /* THE DEPTH RANGE FOLLOWS THE FRAMING DISTANCE, never a constant.

       `near` has to sit closer to the camera than the nearest vertex and no
       closer, and `far` further than the scene. Neither is knowable before
       something is framed, and both are wrong by a factor of ~5 for any scene
       that is not the size the constants were written for — which is every
       scene: 1 unit for a Hough grid, hundreds for an m/z surface.

       A near plane too far away does not warn: it clips, silently, and the
       object simply is not there. That is the whole failure mode.

       The ratios are chosen so the scene is comfortably inside at any framing
       distance: near at 1 % of it, far at 100×. Zooming out moves BOTH planes,
       so a distant view stays correct instead of eventually losing its far
       plane. */
    setDepthRange(distance){
        if(!(distance>0)) return false
        const near=Math.max(1e-6,distance*0.01)
        const far=Math.max(near*1000,distance*100)
        if(this.camera.near===near&&this.camera.far===far) return false
        this.camera.near=near
        this.camera.far=far
        this.camera.updateProjectionMatrix()
        return true
    }

    /* Register an object the layer created on the caller's behalf, so
       dispose() can release it even if the caller forgot. Traces still
       dispose their OWN geometry: ownership stays explicit, this is the
       belt to that pair of braces. */
    own(object){
        this._owned.push(object)
        return object
    }
    release(object){
        const index=this._owned.indexOf(object)
        if(index>=0) this._owned.splice(index,1)
    }

    /* One mesh, one hit. `x`/`y` are CSS pixels relative to the canvas.
       Returns the intersection or null — a Raycaster over a 200k-vertex
       surface would be ruinous per mousemove, but it is bounded by the GPU
       and the plot only calls it on a throttled hover. */
    raycast(x,y,objects=this.content.children){
        const rect=this.canvas.getBoundingClientRect()
        if(!(rect.width>0&&rect.height>0)) return null
        const pointer=new THREE.Vector2(
            ((x-rect.left)/rect.width)*2-1,
            -((y-rect.top)/rect.height)*2+1
        )
        this.raycaster.setFromCamera(pointer,this.camera)
        const hits=this.raycaster.intersectObjects(objects,true)
        return hits.length?hits[0]:null
    }

    getStats(){
        return {
            pixelRatio:this.pixelRatio,
            width:this.width,
            height:this.height,
            objects:this.content.children.length,
            drawCalls:this.renderer.info.render.calls,
            triangles:this.renderer.info.render.triangles
        }
    }

    dispose(){
        for(const type of ["webglcontextlost","webglcontextrestored"]){
            this.canvas.removeEventListener(type,type==="webglcontextlost"?this._onContextLost:this._onContextRestored,false)
        }
        this._onContextLost=null
        this._onContextRestored=null
        this.onContextRestored=null
        //the content group is emptied object by object: a Scene.dispose() does
        //not exist in Three, and leaving the geometries behind is exactly the
        //leak this method exists to prevent
        this.content.traverse(child=>{
            child.geometry?.dispose?.()
            const material=child.material
            if(Array.isArray(material)) material.forEach(m=>m.dispose?.())
            else material?.dispose?.()
        })
        this.content.clear()
        for(const object of this._owned){
            object.geometry?.dispose?.()
            object.material?.dispose?.()
        }
        this._owned=[]
        this.lights.clear()
        this.renderer.dispose()
        /* `forceContextLoss()` is not optional, and forgetting it is a leak
           that only shows up much later as someone ELSE's plot going black.

           A browser caps live WebGL contexts (16 in Chrome) and past the cap it
           drops the OLDEST LIVE one, not the oldest unreferenced one. So a
           3D plot whose canvas is merely detached still counts against the
           cap until the garbage collector gets round to it, which for a WebGL
           context can be many plot rebuilds away — and in the meantime the
           victim is whichever plot the user happens to be looking at.

           This releases the slot NOW instead of asking politely. GLTraceLayer
           does exactly this (plot2d-gl.js:1109), and the two layers must agree:
           one releasing eagerly and the other lazily means the cap depends on
           which plot you last touched. */
        this.renderer.forceContextLoss()
    }
}

/* ---------------------------------------------------------------------
   Materials, factored out so a surface and a scatter cannot drift apart on
   the depth settings that make them readable (see the file header).
   --------------------------------------------------------------------- */

/* OPAQUE, and that is not a detail: a transparent mesh is drawn after the
   opaque pass and sorted PER OBJECT, so a folded surface shows its own back
   faces through its front ones. Half-transparent facets are that bug, not
   geometry. Depth test and depth write stay ON, which is the whole reason
   this layer exists separately from GLTraceLayer. */
export function surfaceMaterial({colors=false,shininess=24,specular=0x1a1a1a,opacity=1,side=THREE.DoubleSide}={}){
    return new THREE.MeshPhongMaterial({
        vertexColors:colors,
        side,
        shininess,
        specular,
        opacity,
        transparent:opacity<1,
        depthTest:true,
        depthWrite:opacity>=1
    })
}

/* A scatter cloud: small, always lit, depth tested so a point behind the
   surface is genuinely hidden by it.

   SIZE IN PIXELS, i.e. `sizeAttenuation:false`, and this was the single
   worst default in this file.

   With attenuation on, Three computes `gl_PointSize = size * (height/2) /
   -mvPosition.z` — `size` is then a WORLD size, not a pixel count. At `size:4`
   and three units away, on a 600 px tall canvas, that is 4 * 300 / 3, i.e.
   **400 pixels per point**. A handful of reference points then drew a handful
   of 400 px squares, and what came out was a white plane across the plot with
   the surface behind it — which reads as a rendering fault rather than as a
   unit error, and is exactly what the first screenshot showed.

   Pixels also match the 2D layer, whose marker sizes are already pixels
   (plot2d-gl.js MARKER_VERTEX_SHADER), so `size` means the same thing in both
   plots — and a reference point stays the same size at every zoom, which is
   what you want when the question is "does the surface pass through them". */
export function scatterMaterial({size=3,colors=false,opacity=1}={}){
    return new THREE.PointsMaterial({
        size,
        vertexColors:colors,
        opacity,
        transparent:opacity<1,
        sizeAttenuation:false,
        depthTest:true,
        depthWrite:opacity>=1
    })
}
