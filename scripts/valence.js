/* =========================================================================
   valence.js — valences, and the parity question.

   A valence is a CHEMICAL CONVENTION, not a measurement. The same element
   carries different ones depending on what it is bonded to, which is why
   this is an instantiable object and not a table baked into a function:
   the valence in force is decided per use, never assumed once and for all.

   That is the same move as the isotope profiles. An isotope profile is a
   swappable object, so a labelled 13C composition can be asked for without
   touching the data. A valence is a decision of the same kind: the default
   in the file is a starting point, not a law.

     const v=new ValenceSet(table)
     v.valence("Cr")            // 3, the default from the file
     const cr6=v.with("Cr",6)   // a COPY where chromium is hexavalent
     cr6.valence("Cr")          // 6
     v.valence("Cr")            // still 3, the original is untouched

   The copy matters: one formula where chromium happens to be hexavalent must
   not make every other formula hexavalent.                              === */

/* The known valences per element, used when the data file has none. Kept
   minimal on purpose: these are the organic-spectrometry elements, and they
   are a STARTING POINT, not a claim about the rest of the table. */
const DEFAULT_VALENCES={
    H:[1],  C:[4],  N:[3,5],  O:[2],  F:[1],
    P:[3,5], S:[2,4,6], Cl:[1,3,5,7], Br:[1,3,5,7], I:[1,3,5,7],
    B:[3],  Si:[4], Se:[2,4,6],
    Na:[1], Li:[1], K:[1],  Mg:[2], Ca:[2], Zn:[2], Ba:[2],
    Al:[3], Fe:[2,3], Cu:[1,2], Cr:[3,6], Mn:[2,4,7], Co:[2,3],
}

class ValenceSet{
    /* table: the contents of data/elements.json, or anything shaped like it
       ({elements:[{symbol, valences:{default, all}}]}) */
    constructor(table,{valences=undefined}={}){
        this.elements=table?.elements??[]
        // symbol -> the valence in force, overriding the file's default
        this.overrides=valences?new Map(Object.entries(valences)):new Map()
    }

    //the element record, or a clear failure rather than a silent undefined
    get(symbol){
        const el=this.elements.find(e=>e.symbol===symbol)
        if(el) return el
        throw new Error(`unknown element: ${symbol}`)
    }

    /* The valence in force: the override if one was set, the file's default
       otherwise. Throws when the element has no valence at all, because
       "not decided yet" and "zero" are different answers, and a zero would
       pass every parity test without anyone noticing. */
    valence(symbol){
        if(this.overrides.has(symbol)) return this.overrides.get(symbol)
        const el=this.get(symbol)
        const known=el.valences??DEFAULT_VALENCES[symbol]
        if(!known) throw new Error(`${symbol} has no valence in the data`)
        return known.default??known[0]
    }

    //every valence known for this element
    valencesOf(symbol){
        if(this.overrides.has(symbol)) return [this.overrides.get(symbol)]
        const el=this.get(symbol)
        const known=el.valences??DEFAULT_VALENCES[symbol]
        if(!known) return null
        return known.all?known.all.slice():known.slice()
    }

    /* A COPY with some valences pinned. The original is untouched, which is
       the whole point: pinning chromium to 6 for one formula must not change
       the next one. Called as with("Cr",6,"Fe",2), flat pairs. */
    with(...args){
        if(args.length===1&&args[0]&&typeof args[0]==="object"){
            args=Object.entries(args[0])   // or with({Cr:6, Fe:2})
        }
        if(args.length%2!==0){
            throw new Error(`with() takes symbol/valence pairs, got ${args.length} arguments`)
        }
        const overrides=new Map(this.overrides)
        for(let i=0;i<args.length;i+=2) overrides.set(args[i],args[i+1])
        return new ValenceSet(this,{valences:Object.fromEntries(overrides)})
    }

    /* True when EVERY valence this element could take has the same parity.
       Chromium (3 and 6) and iron (2 and 3) do not qualify: for those the
       question has no answer until a valence is chosen, which is what `with`
       exists for. */
    hasStableParity(symbol){
        const all=this.valencesOf(symbol)
        if(!all) return false
        return new Set(all.map(v=>v%2)).size===1
    }

    // 0 for an even valence, 1 for an odd one
    parity(symbol){
        return this.valence(symbol)%2
    }
}

/* The parity of a WHOLE composition: sum the valences, one per atom, and ask
   whether the total is even, so the bonds can close on themselves.
   `composition` is a plain object of symbol -> count, e.g. {C:6, H:12, O:6}.

   UNKNOWN VALENCE MEANS THE FORMULA PASSES, and that is a decision, not a
   fallback. Two different cases lead there:
     - the valence is simply not in the data (67 elements: the noble gases, the
       lanthanides, the heavy synthetic ones). Nothing is known, so anything
       goes and the formula is kept.
     - the valence is known but ambiguous (Cr is 3 or 6, Fe is 2 or 3). The
       element could go either way, so it is kept too: refusing it would throw
       away real chemistry, and the price paid is only that Cr and Fe can no
       longer be ruled out by this test alone.
   An odd sum rules a formula out, which is the one thing this test is for. A
   null is therefore not returned: pinning a valence with .with() is still
   worth it, it just sharpens a test that already let the formula through. */
function valenceParity(valences,composition){
    let total=0
    for(const [symbol,count] of Object.entries(composition)){
        if(!count) continue
        if(!valences.overrides.has(symbol)&&!valences.hasStableParity(symbol)){
            // unknown or ambiguous: this element cannot rule anything out
            continue
        }
        total+=valences.valence(symbol)*count
    }
    return total%2===0
}

export {ValenceSet,valenceParity,DEFAULT_VALENCES}
