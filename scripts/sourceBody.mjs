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
   stopped there would test the helper while claiming to test the plot. */
export function methodBody(text,name,after=0){
    const src=text.replace(/\r\n/g,"\n")
    const start=src.indexOf(`    ${name}(`,after)
    if(start<0) throw new Error(`${name}() not found`)
    const openParen=src.indexOf("(",start)
    let depth=0
    let closeParen=-1
    for(let k=openParen;k<src.length;k++){
        if(src[k]==="(") depth++
        else if(src[k]===")"){
            depth--
            if(depth===0){ closeParen=k; break }
        }
    }
    if(closeParen<0) throw new Error(`${name}( has no closing parenthesis in its signature`)
    const open=src.indexOf("{",closeParen)
    if(open<0) throw new Error(`${name}() has no opening brace after its signature`)
    const clean=blankComments(src.slice(open))
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