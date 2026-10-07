import {CE} from "../util.js"

export class VirtualRowList{
    //rows drawn beyond the viewport, top and bottom. A screenful is plenty on
    //a fast wheel and not enough on a slow drag; 8 rows is the compromise.
    static OVERSCAN=8
    constructor({rowHeight,onRow,onActivate=null,scrollElement=null}={}){
        this.rowHeight=rowHeight
        this.onRow=onRow
        this.onActivate=onActivate
        this.rows=[]
        this.pool=[]
        this.first=0
        this.last=0
        this.paintFrame=null
        this.spacer=CE("div",{className:"fc-spacer"},[])
        this.layer=CE("div",{className:"fc-layer"},[])
        this.element=CE("div",{className:"fc-viewport"},[this.spacer,this.layer])
        this.spacer.addEventListener("click",()=>{})
        /* OÙ EST LE DÉFILEMENT, ET C'EST LA MOITIÉ DU BUG.

           `this.element` (`.fc-viewport`) est `position:absolute; inset:0` DANS
           `.fc-viewport-wrap`, et c'est le WRAP qui porte `overflow:auto`. Le
           wrap est donc le conteneur qui défile, et `this.element` non: son
           `scrollTop` vaut 0 en permanence.

           Lire la position sur le mauvais élément ne produit pas une erreur, ça
           produit une liste VIDE: `first` reste à 0, donc les lignes peintes
           restent celles du début, positionnées en `translateY(0…)` — et le
           wrap les fait défiler vers le haut en sortant du champ. On voit donc
           quelques lignes, puis du vide, puis plus rien. C'est exactement le
           symptôme décrit, et il n'apparaît qu'au défilement: au premier rendu
           la position 0 est la bonne, donc la liste semble juste.

           Le défilement est donc demandé à l'élément qui le porte, et la hauteur
           lue sur LE MÊME: en mesurer un et en faire défiler un autre, la
           fenêtre arriverait décalée d'un plein écran. */
        this.scroll=scrollElement??this.element
        this.observer=new ResizeObserver(()=>this.paint())
        this.observer.observe(this.scroll)
    }
    setRows(rows){
        this.rows=rows
        //the spacer IS the scrollbar: without its full height the list would
        //be a dozen rows tall no matter how many formulas it holds
        this.spacer.style.height=`${rows.length*this.rowHeight}px`
        this.paint()
        /* AND ONCE MORE, on the next frame.

           A paint measures `clientHeight`, and right after a re-render that
           number is the one the layout WILL have, not the one it has: the
           collections above have just been rebuilt, the write line has just
           been rebuilt, the browser has not reflowed. Painting on a stale zero
           fills a single row — or none — and the list then stays wrong until
           the user scrolls, which is exactly what "the formulas disappear when
           I pick another collection" looks like.

           The ResizeObserver catches the size changing, but it fires for SIZE,
           not for "the rows in it are different": a list that was already the
           right height and merely got new content is never resized. So the
           repaint is asked for explicitly, here, where the rows changed. */
        this.paintLater()
    }
    paintLater(){
        if(this.paintFrame) return
        this.paintFrame=requestAnimationFrame(()=>{
            this.paintFrame=null
            this.paint()
        })
    }
    /* The visible window, as row indices. A binary search over the offsets,
       because the list may hold a hundred thousand rows and a linear scan on
       every scroll frame is what virtualization was supposed to remove. */
    visibleRange(){
        const scrollTop=this.scroll.scrollTop
        /* One screenful when the box has not been laid out yet. A zero here
           would make `needed` zero, which hides every pooled row — and the list
           would then be blank for a reason that has nothing to do with how many
           formulas it holds. */
        const height=this.scroll.clientHeight||this.rowHeight*8
        const first=Math.max(0,Math.floor(scrollTop/this.rowHeight)-VirtualRowList.OVERSCAN)
        const last=Math.min(this.rows.length,Math.ceil((scrollTop+height)/this.rowHeight)+VirtualRowList.OVERSCAN)
        return {first,last}
    }
    paint(){
        const {first,last}=this.visibleRange()
        const needed=last-first
        while(this.pool.length<needed){
            //a null row means "BUILD": the callback returns a fresh element,
            //and from then on the pool re-fills the same ones forever
            const element=this.onRow(null,null,this.pool.length)
            element.style.position="absolute"
            element.style.left="0px"
            element.style.right="0px"
            this.layer.appendChild(element)
            this.pool.push(element)
        }
        for(let i=0;i<this.pool.length;i++){
            const element=this.pool[i]
            if(i>=needed){
                element.style.display="none"
                continue
            }
            element.style.display=""
            element.style.transform=`translateY(${(first+i)*this.rowHeight}px)`
            //the row is attached to its element here, so the click handler
            //installed once at build time always finds the CURRENT row
            this.onRow(element,this.rows[first+i],first+i)
        }
        this.first=first
        this.last=last
    }
    scrollToRow(index){
        if(!this.rows.length) return
        const clamped=Math.max(0,Math.min(this.rows.length-1,index))
        const top=clamped*this.rowHeight
        /* Même élément que `visibleRange`, pour la même raison: écrire le
           défilement sur un conteneur qui ne défile pas ne fait rien du tout, et
           les flèches du clavier semblaient ne pas marcher. */
        const height=this.scroll.clientHeight||this.rowHeight
        if(top<this.scroll.scrollTop){
            this.scroll.scrollTop=top
        }else if(top+this.rowHeight>this.scroll.scrollTop+height){
            this.scroll.scrollTop=top+this.rowHeight-height
        }
        this.paint()
    }
    dispose(){
        this.observer.disconnect()
        if(this.paintFrame) cancelAnimationFrame(this.paintFrame)
        this.element.remove()
        this.pool.length=0
        this.rows=[]
    }
}

