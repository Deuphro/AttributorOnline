/* =====================================================================
    PointGrid — the CPU hit-testing index of the WebGL back layer
    ---------------------------------------------------------------------
    A Plot2DWebGL deliberately knows nothing about individual points: it
    uploads them as flat Float32Array and never allocates one JS object
    per sample (see plot2d-gl.js). Hovering still has to answer "which
    point is under the cursor, and how far is it", so the data needs a
    CPU side structure again — but a flat, allocation-free one, living in
    the very frame the GPU vertices live in.

    THE FRAME
    `u`/`v` are the uploaded coordinates: (log10(value) on a log axis)
    minus the reference origin (see Plot2DWebGL.glReferenceOrigin). The
    camera is orthographic, so u -> pixel is AFFINE. That is what makes
    the pick radius a plain pixel radius on ANY axis type and at ANY
    zoom, with no radius conversion — a d3.quadtree.find(x, y, r) is a
    circular query in DATA space, and a log axis has no such circle.

    THE COORDINATES ARE ITS OWN
    The grid does NOT read the vertex buffer to measure a distance. It
    stores the (u, v) it was given, in Float64: the buffer holds only the
    MARKER points (see _collect), while the hover must also answer about
    the vertices of a drawn line — and those live in linePositions, indexed
    by segment. Reading positions[] would therefore silently measure the
    wrong vertex as soon as a trace has no markers. Owning the coordinates
    also removes the float32 rounding the vertex buffer would impose.

    WHY A GRID, NOT A TREE AND NOT A BINARY SEARCH
      O(N) to build, O(1) to query, and no ordering assumption at all:
      nothing here requires the abscissae to be sorted, which matters
      because a Wave.core is a raw Float64Array a worker is free to
      rewrite (see glSourceIdentity / scheduleUploadCheck). A sorted fast
      path would still need a sortedness DETECTION pass, a fallback for
      the unsorted case, a NaN filter, and its neighbour scan is bounded
      by nothing (a stick spectrum puts 10^4 points on one abscissa).
      The grid needs one single O(N) pass, with no branch and no worst
      case.
      It also never has to be rebuilt on a pan, a zoom or a resize: it
      indexes the DATA extent, not the visible window. Indexing only what
      is visible would force an O(N) re-bucket per gesture and break the
      invariant the whole sandwich is built on (see refreshCamera).

    THE BUILD IS ONE PASS OVER THE DATA
    A counting sort needs the cell size, and the cell size needs the
    extent, and the extent is only known at the END of the walk. The
    coordinates are therefore parked in a growable buffer during the walk
    and bucketed afterwards, inside seal(). The caller walks its arrays
    ONCE — which matters, because the caller is a per-point loop the
    engine already runs once per data change. The buffer is dropped as
    soon as the scatter is over.

    Cell occupancy is deliberately allowed to be uneven: zoomed out, a
    cell holds many points — and there are many points on screen anyway;
    zoomed in, it holds nearly none. A pathological cluster is the single
    case where this is slower than a tree, and it is the case a tree pays
    10x the memory for.
   ===================================================================== */

/* A 256x256 grid is 65536 cells: the work per query is independent of N
   and of the zoom, and the offsets cost 256 KiB whatever the dataset. */
export const PICK_GRID_RESOLUTION=256

/* Below this many points a flat scan beats building and keeping a grid:
   there is nothing to fragment yet, and the scan touches memory that is
   already hot from the upload. */
export const PICK_SCAN_THRESHOLD=20000

/* ---------------------------------------------------------------------
   The reference -> pixel mapping, straight out of the orthographic
   camera bounds. Kept here (and not in plot2d-gl.js) so it can be tested
   without a GL context: this affine pair is what every pick decision is
   expressed in.
   --------------------------------------------------------------------- */
export function affineFromBounds({left,right,top,bottom},width,height){
    const spanX=right-left
    const spanY=bottom-top
    //`!== 0` and NOT `> 0`: a camera normally has top > bottom (the Y axis
    //grows downwards), so spanY is NEGATIVE — a `> 0` guard would silently
    //hand back a null scale, and every pick would then be refused
    const sx=spanX!==0?width/spanX:0
    const sy=spanY!==0?height/spanY:0
    return {u0:-left*sx,v0:-top*sy,sx,sy}
}

export function pixelToReference({u0,v0,sx,sy},px,py){
    return {u:sx?(px-u0)/sx:0,v:sy?(py-v0)/sy:0}
}

/* The below-threshold path: same answer as the grid, no structure. It
   takes the SAME two coordinate planes the grid keeps, so the two paths
   cannot drift apart, and `from` is the first index the caller is allowed
   to answer about. */
export function scanNearest(coordsU,coordsV,count,cursorX,cursorY,projection,radiusPx,from=0){
    const {u0,v0,sx,sy}=projection
    if(!(count>from)||!sx||!sy) return -1
    const radius2=radiusPx*radiusPx
    let best=-1
    let bestDistance=radius2
    for(let index=from;index<count;index++){
        const dx=cursorX-(u0+coordsU[index]*sx)
        const dy=cursorY-(v0+coordsV[index]*sy)
        const distance=dx*dx+dy*dy
        //ties go to the LOWEST point index, i.e. the first-drawn
        //trace/point, so the answer never depends on the cell order
        if(distance<bestDistance||(distance===bestDistance&&(best<0||index<best))){
            bestDistance=distance
            best=index
        }
    }
    return best
}
export class PointGrid{
    constructor(nx=PICK_GRID_RESOLUTION,ny=PICK_GRID_RESOLUTION){
        if(!(nx>0)||!(ny>0)) throw new RangeError("PointGrid needs a positive resolution")
        this.nx=nx|0
        this.ny=ny|0
        this.cellCount=this.nx*this.ny
        this.count=0
        this.traceCount=0
        this.extent=null
        //CSR layout: _starts[cell].._starts[cell+1] is the slice of _items
        //holding that cell. _fill is the per-cell write cursor, and it is
        //what turns the scatter into a counting sort — no comparison sort.
        this._starts=null
        this._fill=null
        this._items=null
        //_traceStarts[t] is the GLOBAL index of the first point of trace t,
        //so a global index splits back into (trace, index within the trace)
        this._traceStarts=null
        this._minU=Infinity
        this._maxU=-Infinity
        this._minV=Infinity
        this._maxV=-Infinity
        this._inverseU=0
        this._inverseV=0
        //THE COORDINATES, kept: accumulate() parks them, seal() buckets them,
        //and nearest() measures the distance with them. They outlive the
        //build — see the header for why the grid cannot read them back from
        //the vertex buffer
        this._coordsU=new Float64Array(0)
        this._coordsV=new Float64Array(0)
        this._pending=0
    }

    /* ---- build: one walk to park, one to bucket ---- */

    //park a point. Growable, so the caller never has to know the point
    //count in advance.
    //NOTE: it deliberately does NOT touch the extent. The extent is derived
    //from the coordinates by seal(), and only there: keeping a second copy
    //of it here meant a caller that filled the planes itself (plot2d-gl.js
    //does) left the extent at Infinity, the cell size came out null, every
    //point landed on cell NaN, and the scatter silently counted nothing.
    accumulate(u,v){
        if(this._pending>=this._coordsU.length){
            const grown=Math.max(1024,Math.ceil(this._coordsU.length*1.5))
            const u2=new Float64Array(grown)
            u2.set(this._coordsU)
            this._coordsU=u2
            const v2=new Float64Array(grown)
            v2.set(this._coordsV)
            this._coordsV=v2
        }
        this._coordsU[this._pending]=u
        this._coordsV[this._pending]=v
        this._pending++
    }

    /* THE extent, read off the coordinates and off nothing else.
       One linear pass, and it replaces the bookkeeping accumulate() used to
       do — so the coordinates are the single source of truth, whichever way
       they got here. */
    _measureExtent(){
        const us=this._coordsU
        const vs=this._coordsV
        let minU=Infinity
        let maxU=-Infinity
        let minV=Infinity
        let maxV=-Infinity
        for(let index=0;index<this.count;index++){
            const u=us[index]
            const v=vs[index]
            if(u<minU) minU=u
            if(u>maxU) maxU=u
            if(v<minV) minV=v
            if(v>maxV) maxV=v
        }
        this._minU=minU
        this._maxU=maxU
        this._minV=minV
        this._maxV=maxV
    }

    /* Sizes every array, counts the cells, prefix-sums them and scatters.
       `total` is how many points the caller parked (it must match, or the
       index would describe a different set than the one drawn) and
       `traceStarts` the per-trace first-index table, length traceCount+1.

       `coordsU`/`coordsV` are OPTIONAL and, when given, ADOPTED rather than
       copied. The caller is walking the data anyway and has to keep those
       two planes for its scan path, so sharing them means the grid never
       holds a second copy of a million coordinates. */
    seal(total,traceStarts,coordsU,coordsV){
        this.count=Math.max(0,total|0)
        this.traceCount=Math.max(0,(traceStarts?traceStarts.length:1)-1)
        this._traceStarts=traceStarts?Uint32Array.from(traceStarts):Uint32Array.of(0,this.count)
        //ADOPTED planes: the caller already built them at the exact size, so
        //they are taken as they are — no copy, and no trim further down
        const adopted=Boolean(coordsU&&coordsV)
        if(adopted){
            this._coordsU=coordsU
            this._coordsV=coordsV
            this._pending=this.count
        }
        if(!(this.count>0)||this._pending<this.count){
            //an empty grid is not an error: a plot with nothing pickable yet
            //simply has nothing to answer, and must return null rather than
            //throw
            this.extent=null
            this._starts=null
            this._fill=null
            this._items=null
            this._coordsU=new Float64Array(0)
            this._coordsV=new Float64Array(0)
            this._pending=0
            return this
        }
        //the extent is measured HERE, from the coordinates that were just
        //adopted or parked — never from a value some other method happened
        //to leave behind
        this._measureExtent()
        this.extent={minU:this._minU,maxU:this._maxU,minV:this._minV,maxV:this._maxV}
        //a degenerate extent (every point on the same abscissa) would give
        //an infinite cell size: the grid then collapses to one column,
        //which is still correct, only coarser
        const spanU=this._maxU-this._minU
        const spanV=this._maxV-this._minV
        this._inverseU=spanU>0?this.nx/spanU:0
        this._inverseV=spanV>0?this.ny/spanV:0
        this._starts=new Uint32Array(this.cellCount+1)
        this._items=new Uint32Array(this.count)
        this._fill=new Uint32Array(this.cellCount)
        //counting sort, step 1: how many points per cell
        for(let index=0;index<this.count;index++){
            this._starts[this._cell(this._coordsU[index],this._coordsV[index])+1]++
        }
        //step 2: the prefix sum, which leaves _starts[cell] at the first
        //slot of that cell and _starts[cellCount] at the total — a checksum
        for(let cell=0;cell<this.cellCount;cell++){
            this._starts[cell+1]+=this._starts[cell]
        }
        if(this._starts[this.cellCount]!==this.count){
            throw new Error(`PointGrid: ${this._starts[this.cellCount]} slots for ${this.count} points`)
        }
        /* step 3: the scatter, one write per point at its cell's cursor.
           _fill STARTS AT THE FIRST SLOT OF EACH CELL — copying the prefix
           sum is the whole point of the structure. Left at zero it would
           make every cell write over slots 0,1,2... and collide. */
        for(let cell=0;cell<this.cellCount;cell++){
            this._fill[cell]=this._starts[cell]
        }
        for(let index=0;index<this.count;index++){
            this._items[this._fill[this._cell(this._coordsU[index],this._coordsV[index])]++]=index
        }
        //the coordinates are KEPT (nearest() measures with them). They are
        //only reallocated when THEY had to grow by slack: a buffer grown in
        //steps of 1.5x would otherwise hold up to 1.5x its memory. Planes
        //the caller handed over are already exact, and re-copying them would
        //cost 16 MiB on a million points for nothing.
        if(!adopted){
            const exactU=new Float64Array(this.count)
            exactU.set(this._coordsU.subarray(0,this.count))
            const exactV=new Float64Array(this.count)
            exactV.set(this._coordsV.subarray(0,this.count))
            this._coordsU=exactU
            this._coordsV=exactV
        }
        this._pending=0
        return this
    }

    //clamped, because a query may legitimately reach outside the data: the
    //cursor is in the margins, or the radius is wider than the extent
    _cell(u,v){
        //_inverseU is 0 on a degenerate axis and floor(0) is 0, so the whole
        //dataset lands in the first column — which is the correct answer
        let cx=Math.floor((u-this._minU)*this._inverseU)
        let cy=Math.floor((v-this._minV)*this._inverseV)
        if(cx<0) cx=0; else if(cx>=this.nx) cx=this.nx-1
        if(cy<0) cy=0; else if(cy>=this.ny) cy=this.ny-1
        return cy*this.nx+cx
    }

    _cellX(u){
        const raw=Math.floor((u-this._minU)*this._inverseU)
        return raw<0?0:(raw>=this.nx?this.nx-1:raw)
    }

    _cellY(v){
        const raw=Math.floor((v-this._minV)*this._inverseV)
        return raw<0?0:(raw>=this.ny?this.ny-1:raw)
    }

    //the trace a global point index belongs to, by binary search
    traceOf(pointIndex){
        const starts=this._traceStarts
        if(!starts||pointIndex<0) return -1
        let low=0
        let high=this.traceCount-1
        let found=-1
        while(low<=high){
            const middle=(low+high)>>1
            if(starts[middle]<=pointIndex){
                found=middle
                low=middle+1
            }else{
                high=middle-1
            }
        }
        return found
    }


    /* ---- query ---- */

    /* Returns {pointIndex, traceIndex, tracePoint, distance, u, v} or null,
       `u`/`v` being the reference coordinates of the point that won. The
       distances are measured with the grid's OWN Float64 planes, never with
       the vertex buffer — see the header for why reading it back would
       answer about the wrong vertex as soon as a trace has no markers. */
    nearest(cursorX,cursorY,projection,radiusPx){
        if(!(this.count>0)||!this._starts) return null
        const {u0,v0,sx,sy}=projection
        if(!sx||!sy||!Number.isFinite(cursorX)||!Number.isFinite(cursorY)) return null
        const radius2=radiusPx*radiusPx
        //a pixel radius becomes a (possibly anisotropic) box in the
        //reference frame — that is the only place the two frames meet
        const spanU=radiusPx/Math.abs(sx)
        const spanV=radiusPx/Math.abs(sy)
        const cursorU=(cursorX-u0)/sx
        const cursorV=(cursorY-v0)/sy
        const fromX=this._cellX(cursorU-spanU)
        const toX=this._cellX(cursorU+spanU)
        const fromY=this._cellY(cursorV-spanV)
        const toY=this._cellY(cursorV+spanV)
        let best=-1
        let bestDistance=radius2
        for(let cy=fromY;cy<=toY;cy++){
            const row=cy*this.nx
            for(let cx=fromX;cx<=toX;cx++){
                const cell=row+cx
                const end=this._starts[cell+1]
                for(let at=this._starts[cell];at<end;at++){
                    const pointIndex=this._items[at]
                    const dx=cursorX-(u0+this._coordsU[pointIndex]*sx)
                    const dy=cursorY-(v0+this._coordsV[pointIndex]*sy)
                    const distance=dx*dx+dy*dy
                    //the same tie rule as scanNearest, so the two paths
                    //cannot disagree on an equality
                    if(distance<bestDistance
                        ||(distance===bestDistance&&(best<0||pointIndex<best))){
                        bestDistance=distance
                        best=pointIndex
                    }
                }
            }
        }
        if(best<0) return null
        const traceIndex=this.traceOf(best)
        if(traceIndex<0) return null
        return {
            pointIndex:best,
            traceIndex,
            tracePoint:best-this._traceStarts[traceIndex],
            distance:Math.sqrt(bestDistance),
            u:this._coordsU[best],
            v:this._coordsV[best]
        }
    }

    memoryBytes(){
        if(!this._starts) return 0
        return this._starts.byteLength
            +this._fill.byteLength
            +this._items.byteLength
            +this._coordsU.byteLength
            +this._coordsV.byteLength
            +this._traceStarts.byteLength
    }
}


