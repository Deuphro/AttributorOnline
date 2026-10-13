/* Standalone validation of the drawPoint()/derive() GLSL logic in
   scripts/plot2d-gl.js. The GLSL cannot run without a GL context here, so
   this mirrors the maths exactly in JS and asserts the spec's properties,
   then checks the shader SOURCE for structural correctness. Run:
       node scripts/drawPoint.check.mjs                                        */
import {readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import {dirname,join} from "node:path"

const here=dirname(fileURLToPath(import.meta.url))
const src=readFileSync(join(here,"plot2d-gl.js"),"utf8")

/* ---------- JS mirror of the GLSL helpers (verbatim port) ---------- */
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x))
function smoothstep(e0,e1,x){
    const t=clamp((x-e0)/(e1-e0),0,1)
    return t*t*(3-2*t)
}
function rgb2hsl([r,g,b]){
    const maxc=Math.max(r,g,b),minc=Math.min(r,g,b)
    const l=(maxc+minc)/2
    let h=0,s=0
    const d=maxc-minc
    if(d>1e-6){
        s=l>0.5?d/(2-maxc-minc):d/(maxc+minc)
        if(maxc===r)      h=(g-b)/d+(g<b?6:0)
        else if(maxc===g) h=(b-r)/d+2
        else              h=(r-g)/d+4
        h/=6
    }
    return [h,s,l]
}
function hue2rgb(p,q,t){
    if(t<0)t+=1
    if(t>1)t-=1
    if(t<1/6)return p+(q-p)*6*t
    if(t<0.5)return q
    if(t<2/3)return p+(q-p)*(2/3-t)*6
    return p
}
function hsl2rgb([h,s,l]){
    if(s<=0)return[l,l,l]
    const q=l<0.5?l*(1+s):l+s-l*s
    const p=2*l-q
    return [hue2rgb(p,q,h+1/3),hue2rgb(p,q,h),hue2rgb(p,q,h-1/3)]
}
const lum=([r,g,b])=>0.2126*r+0.7152*g+0.0722*b
function derive(base){
    const [h,s,l]=rgb2hsl(base)
    const dark=smoothstep(0.28,0.0,l)
    const light=smoothstep(0.65,1.0,l)
    let coreS=s*0.65
    let coreL=l+0.20
    coreL=coreL*(1-dark)+Math.max(coreL,0.62)*dark
    coreL=coreL*(1-light)+Math.max(coreL,0.92)*light
    let core=hsl2rgb([h,clamp(coreS,0,1),clamp(coreL,0,1)])
    core=core.map(c=>c*0.72+1*0.28)             //mix 28% toward white
    const rim=[1,1,1]
    const halo=hsl2rgb([h,clamp(s*1.35,0,1),clamp(l*0.45,0,1)])
    return {core,rim,halo,h,s,l}
}
const HALO=1.0
function drawPoint(px,py,R,baseColor){
    const col=derive(baseColor)
    const Rn=Math.max(R,1e-3)
    const d=Math.hypot(px,py)/Rn
    const coreMix=Math.pow(clamp(d/0.95,0,1),1.6)
    //inverted gradient: rim (pure white) at the centre, derived core colour
    //growing toward the edge of the disc — mirrors mix(col.rim,col.core,...)
    const coreColor=col.rim.map((c,i)=>c*(1-coreMix)+col.core[i]*coreMix)
    const wide=0.55*Math.exp(-0.5*Math.pow(d/2.00,2))
    const tight=0.90*Math.exp(-0.5*Math.pow(d/0.80,2))
    let haloField=1-(1-wide)*(1-tight)
    haloField*=smoothstep(1.0,1.15,d)
    haloField*=HALO
    const aa=1.5/R                                //~1.5px AA
    const coreMask=1-smoothstep(1.0-aa,1.0+aa,d)
    const alpha=clamp(coreMask+haloField*(1-coreMask),0,1)
    const rgb=col.halo.map((c,i)=>c*(1-coreMask)+coreColor[i]*coreMask)
    return {rgb,alpha,d}
}

/* ---------- assertions ---------- */
let failures=0
const ok=(cond,msg)=>{ if(!cond){failures++;console.error("  FAIL: "+msg)} else console.log("  ok: "+msg) }

console.log("derive()/drawPoint() logic:")
const bases={
    "forest green #aef22e":[0xae/255,0xf2/255,0x2e/255],
    "pure red":[1,0,0],
    "mid blue":[0.2,0.4,0.9],
    "very dark navy":[0.02,0.03,0.12],
    "near white":[0.96,0.97,0.98],
    "gray (no hue)":[0.5,0.5,0.5],
}
for(const [name,base] of Object.entries(bases)){
    const c=derive(base)
    ok(c.rim.every(v=>v===1),`${name}: rim is pure white`)
    ok(lum(c.halo)<lum(base),`${name}: halo darker than base (${lum(c.halo).toFixed(3)} < ${lum(base).toFixed(3)})`)
    if(c.s>0.02){
        // saturation x1.35, clamped to 1 -> halo HSL sat must be >= base sat
        const haloS=rgb2hsl(c.halo)[1]
        ok(haloS>=c.s-1e-6,`${name}: halo saturation >= base (${haloS.toFixed(3)} >= ${c.s.toFixed(3)})`)
    }
    ok(lum(c.core)>lum(base),`${name}: core lighter than base (${lum(c.core).toFixed(3)} > ${lum(base).toFixed(3)})`)
    if(c.s>0.3){
        const dh=Math.abs(rgb2hsl(c.halo)[0]-c.h)
        ok(dh<1e-6||Math.abs(dh-1)<1e-6,`${name}: halo hue preserved`)
    }
}

console.log("\ncontrast adaptation:")
{
    const dark=derive(bases["very dark navy"])
    ok(lum(dark.core)>0.25,`dark base -> readable core (L=${lum(dark.core).toFixed(3)} > 0.25)`)
    const lb=derive(bases["near white"])
    ok(lum(lb.core)>=lum(bases["near white"])-1e-6,`light base -> core stays bright`)
}

console.log("\ndrawPoint() shading:")
{
    const base=bases["forest green #aef22e"]
    const R=6.5
    const centre=drawPoint(0,0,R,base)
    ok(centre.alpha>0.999,`centre alpha ~ 1 (${centre.alpha.toFixed(4)})`)
    //inverted gradient: white at the centre, base hue toward the edge. On a
    //LARGE sprite the ~1.5px AA band is thinner than the core, so both ends
    //of the ramp are measurable: d=0 -> rim (pure white), d=0.95 -> core.
    const Rbig=60
    const centreBig=drawPoint(0,0,Rbig,base)
    ok(centreBig.rgb.every(v=>v>0.98),`centre is white (inverted gradient, min=${Math.min(...centreBig.rgb).toFixed(3)})`)
    ok(lum(centreBig.rgb)>lum(base),`centre brighter than base (${lum(centreBig.rgb).toFixed(3)} > ${lum(base).toFixed(3)})`)
    const bodyPt=drawPoint(0,Rbig*0.95,Rbig,base)
    const cb=bodyPt.rgb
    const spread=Math.max(...cb)-Math.min(...cb)
    ok(spread>0.08,`95% radius keeps the base hue (channel spread ${spread.toFixed(3)} > 0.08, rgb=[${cb.map(v=>v.toFixed(2)).join(",")}])`)
    ok(lum(cb)>lum(base),`95% radius core lightened (${lum(cb).toFixed(3)} > ${lum(base).toFixed(3)})`)
    let discOpaque=true
    for(let a=0;a<360;a+=15){
        const pt=drawPoint(Math.cos(a*Math.PI/180)*R*0.7,Math.sin(a*Math.PI/180)*R*0.7,R,base)
        if(pt.alpha<0.999)discOpaque=false
    }
    ok(discOpaque,`alpha=1 throughout the disc`)
    const justOut=drawPoint(0,R*1.2,R,base)
    ok(justOut.alpha>0.05,`halo present just outside (a=${justOut.alpha.toFixed(3)})`)
    const farOut=drawPoint(0,R*1.6,R,base)
    ok(farOut.alpha<justOut.alpha,`halo decays with distance (${farOut.alpha.toFixed(3)} < ${justOut.alpha.toFixed(3)})`)
    let prev=justOut.alpha,monotone=true
    for(let dd=1.25;dd<=1.7;dd+=0.05){
        const pt=drawPoint(0,R*dd,R,base)
        if(pt.alpha>prev+1e-9)monotone=false
        prev=pt.alpha
    }
    ok(monotone,`halo alpha decays monotonically (no hard outer edge)`)
}

console.log("\nshader source structure:")
ok(/vec4\s+drawPoint\s*\(\s*vec2\s+p\s*,\s*float\s+R\s*,\s*vec3\s+baseColor\s*\)/.test(src),"drawPoint(vec2 p, float R, vec3 baseColor) signature present")
ok(/PointColors\s+derive\s*\(\s*vec3\s+base\s*\)/.test(src),"derive(vec3 base) present")
ok(/vec3\s+rgb2hsl\s*\(/.test(src)&&/vec3\s+hsl2rgb\s*\(/.test(src),"rgb2hsl / hsl2rgb present")
ok(/uniform\s+float\s+uHaloIntensity/.test(src),"uHaloIntensity uniform present")
ok(/fwidth\s*\(\s*d\s*\)/.test(src),"fwidth(d) used for core-edge AA")
ok(/extensions:\s*\{\s*derivatives:\s*true\s*\}/.test(src),"extensions.derivatives enabled for WebGL1 fallback")
//rollback: only glow (8) is routed to drawPoint(); circle (0) is a hard mask again
ok(/if\(vShape>7\.5\)\{/.test(src),"fragment: ONLY glow(8) routed to drawPoint (circle reverted)")
ok(!/if\(vShape<0\.5\|\|vShape>7\.5\)/.test(src),"fragment: circle no longer routed to drawPoint")
ok(/if\(aShape>7\.5\)\s*sprite=vSize\*GLOW_SPRITE_SCALE/.test(src),"vertex: ONLY glow(8) sprite inflated")
ok(/mask=1\.0-length\(c\);\s*\/\/circle/.test(src),"hard circle mask restored in switch")
//perf early-out: exp() only runs when uHaloIntensity>0
ok(/if\(uHaloIntensity>0\.0\)\{[\s\S]*?exp\(/.test(src),"halo exp() guarded by uHaloIntensity>0 (perf early-out)")
ok(/setHaloIntensity\s*\(/.test(src),"setHaloIntensity() setter present")
//wide, blurred halo + brighter core tuning
ok(/pow\(d\/2\.00,2\.0\)/.test(src)&&/pow\(d\/0\.80,2\.0\)/.test(src),"halo sigmas widened (smooth/large/blurred)")
ok(/mix\(core,vec3\(1\.0\),0\.28\)/.test(src),"core brightened (28% toward white)")
//inverted gradient: rim (white) first, core colour second
ok(/mix\(col\.rim,col\.core,coreMix\)/.test(src),"gradient inverted (white at centre, core toward edge)")
//wider outer fade of the halo (0.70..1.0 instead of 0.92..1.0)
ok(/smoothstep\(0\.70,1\.0,length\(c\)\)/.test(src),"halo outer fade widened (smooth 0.70..1.0)")
//root glow coloured by error: one trace per error step + neutral fallback
{
    const forest=readFileSync(join(here,"nodes","AttributionForestMethods.js"),"utf8")
    ok(/shape:"glow",size:6/.test(forest),"root glow size reduced to 6")
    ok(/opacity:0\.4,line:\{size:1\},marker:\{shape:"glow",size:6\}/.test(forest),"root glow opacity reduced by 0.1 (0.4)")
    ok(/forestErrorColor\(\(low\+high\)\/2\)/.test(forest),"root glow coloured by forestErrorColor")
    ok(!/color:"#aef22e"/.test(forest),"root glow no longer hardcoded forest green")
}
//UI: glow (+ ring) offered as a marker shape
{
    const ui=readFileSync(join(here,"nodes","SimpleXYPlotNode.js"),"utf8")
    ok(/\["glow","Glow \(luminous\)"\]/.test(ui),"UI marker list offers Glow")
    ok(/\["ring","Ring"\]/.test(ui),"UI marker list offers Ring")
}
{
    const body=src.slice(src.indexOf("vec4 drawPoint"),src.indexOf("void main",src.indexOf("vec4 drawPoint")))
    ok(!/gl_FragColor/.test(body),"drawPoint returns vec4 (no gl_FragColor inside)")
}
{
    const frag=src.slice(src.indexOf("MARKER_FRAGMENT_SHADER=`")+"MARKER_FRAGMENT_SHADER=`".length)
    const block=frag.slice(0,frag.indexOf("`\n"))
    const open=(block.match(/\{/g)||[]).length, close=(block.match(/\}/g)||[]).length
    ok(open===close,`fragment shader braces balanced (${open}/${close})`)
    const po=(block.match(/\(/g)||[]).length, pc=(block.match(/\)/g)||[]).length
    ok(po===pc,`fragment shader parens balanced (${po}/${pc})`)
}

console.log(failures===0?"\nALL CHECKS PASSED":`\n${failures} CHECK(S) FAILED`)
process.exit(failures===0?0:1)
