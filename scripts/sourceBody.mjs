/* =====================================================================
   Shared test helper — recover a method body out of a source FILE.

   These tests cannot run the code: the nodes need a DOM, the plots need a
   canvas, and the kernels need a worker. What they can do is read the real
   source and evaluate the real function bodies, so that a test exercises the
   FILE rather than a transcription of it. That only works if the extraction is
   correct, and it was wrong in four different ways before it was right — each
   one producing failures that read like product bugs:

     1. the body started after the FIRST "{" — and `suicide(options={})` has a
        brace in its default value, so the extracted body was EMPTY and every
        check inside it failed for no reason at all;
     2. the signature was found with a plain indexOf(")"), which lands inside a
        default value holding its own parenthesis — and on `computeBounds()`,
        which has no parameters, lands on the empty call and then finds the
        "{" of whatever code follows the method;
     3. comments were counted as code — a `{height:460}` inside one closes a
        brace that never opened, and the walk stops mid-comment;
     4. a git checkout on Windows leaves CRLF, so a body sliced on "\n" starts
        with a stray "\r" — enough to fail every anchored check inside it.

   So this is ONE copy, because three tests had grown their own and they were
   the kind of drift that turns a green suite into a liar.
   ===================================================================== */

/* Blank comments while PRESERVING OFFSETS, so a slice taken from the blanked
   text still lines up with the original. Replacing with spaces rather than
   "" keeps every index valid — deleting a comment would shift everything after
   it, which is how a test ends up asserting against the wrong line without ever
   saying so. */
function blankComments(text){
    return text.replace(/\/\*[\s\S]*?\*\//g,m=>" ".repeat(m.length))
               .replace(/^\s*\/\/.*$/gm,m=>" ".repeat(m.length))
}

/* The body of `name`, WITHOUT its surrounding braces and without its
   signature's parameter list. `after` skips earlier matches: "update()" and
   "dispose()" both appear in a helper class above the plot, and a search that
   stopped there would test the helper while claiming to test the plot.

   The name is matched at the START OF A LINE, not as a substring: the worker's
   JS twins are module-level functions with no indentation, and a search for
   "    name(" would miss every one of them. It is also why the name is anchored
   — `dispose()` must not match `disposeState()`. */
export function methodBody(text,name,after=0){
    const src=text.replace(/\r\n/g,"\n")
    /* Two shapes, because the codebase has two: a class method is indented and
       is found by name at the start of a line, and a module-level function has
       no indentation and carries `function` in front. The fallback also skips a
       prefix match — `dispose()` must not land on `disposeState()`. */
    /* Search the COMMENT-BLANKED copy and slice the original. These files are
       commented at length and the prose names the very methods being looked
       for — "every gesture ends in update()" is a sentence in a comment that
       sits a hundred lines ABOVE update() itself, and a search over the raw
       text found the sentence and returned the next method's body instead.
       It reads as a failure of the method under test, which is the worst
       possible place for a failure of the extractor. blankComments replaces
       with spaces, so every offset is valid in both. */
    const blanked=blankComments(src)
    const findAt=(pattern,from)=>{
        const re=new RegExp(pattern,from?"gm":"m")
        re.lastIndex=Math.max(0,from)
        const hit=re.exec(blanked)
        return hit?hit.index:-1
    }
    let start=findAt(`^\\s*(?:export\\s+)?(?:async\\s+)?${name}\\s*\\(`,after)
    if(start<0){
        start=findAt(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,after)
    }
    if(start<0){
        //a plain call or a member access: find it past `after`, on a word bound
        start=findAt(`\\b${name}\\s*\\(`,after)
    }
    if(start<0) throw new Error(`${name}() not found`)
    /* EVERY structural step below reads `blanked`, not `src`. Reading `src`
       for the parenthesis is the same bug one line later: a doc comment on the
       method often mentions the method's own name, and the first "(" after a
       match that starts inside a blanked comment is a "(" in the PROSE. The
       returned body is the only thing that must come from `src`, because a
       blanked comment would be handed to `new Function` as a wall of spaces. */
    const openParen=blanked.indexOf("(",start)
    let depth=0
    let closeParen=-1
    for(let k=openParen;k<blanked.length;k++){
        if(blanked[k]==="(") depth++
        else if(blanked[k]===")"){
            depth--
            if(depth===0){ closeParen=k; break }
        }
    }
    if(closeParen<0) throw new Error(`${name}( has no closing parenthesis in its signature`)
    const open=blanked.indexOf("{",closeParen)
    if(open<0) throw new Error(`${name}() has no opening brace after its signature`)
    const clean=blanked.slice(open)
    let braces=0
    for(let k=0;k<clean.length;k++){
        if(clean[k]==="{") braces++
        else if(clean[k]==="}"){
            braces--
            /* `k` is the index OF the closing brace and `open` the index OF the
               opening one, both within the same string, so the body is
               everything strictly between: open+1 … open+k. `open+1+k` would
               swallow the brace and yield a fragment that fails to compile with
               "Unexpected token '}'" — which reads as a broken method rather
               than as an off-by-one here. */
            if(braces===0) return src.slice(open+1,open+k)
        }
    }
    throw new Error(`unbalanced braces in ${name}()`)
}

/* The source with its comments blanked, for the checks that want to assert on
   CODE rather than on prose: several of these files explain at length which
   identifiers they are avoiding, and that account is worth keeping. */
export function codeOnly(text){
    return blankComments(text.replace(/\r\n/g,"\n"))
}