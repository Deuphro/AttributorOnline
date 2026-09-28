# fetch-nist.ps1 — download the NIST isotope table for one element (or all 118)
#
# NIST sits behind Cloudflare and turns away a plain Node fetch, so the download
# lives here in PowerShell (which gets through) and the parsing lives in
# build-elements.mjs. Splitting them keeps the arithmetic testable offline.
#
#   powershell -File TOOLS/fetch-nist.ps1 H        one element
#   powershell -File TOOLS/fetch-nist.ps1          all 118
param([string]$Symbol="")

$symbols = if($Symbol){
    $Symbol
} else {
    @("H","He","Li","Be","B","C","N","O","F","Ne","Na","Mg","Al","Si","P","S",
      "Cl","Ar","K","Ca","Sc","Ti","V","Cr","Mn","Fe","Co","Ni","Cu","Zn","Ga",
      "Ge","As","Se","Br","Kr","Rb","Sr","Y","Zr","Nb","Mo","Tc","Ru","Rh","Pd",
      "Ag","Cd","In","Sn","Sb","Te","I","Xe","Cs","Ba","La","Ce","Pr","Nd","Pm",
      "Sm","Eu","Gd","Tb","Dy","Ho","Er","Tm","Yb","Lu","Hf","Ta","W","Re","Os",
      "Ir","Pt","Au","Hg","Tl","Pb","Bi","Po","At","Rn","Fr","Ra","Ac","Th","Pa",
      "U","Np","Pu","Am","Cm","Bk","Cf","Es","Fm","Md","No","Lr","Rf","Db","Sg",
      "Bh","Hs","Mt","Ds","Rg","Cn","Nh","Fl","Mc","Lv","Ts","Og")
}

$cache = Join-Path $PSScriptRoot "..\.cache\nist"
New-Item -ItemType Directory -Force -Path $cache | Out-Null

# a polite pause: NIST is a public service, not a CDN
$pause = 400

foreach($s in $symbols){
    $out = Join-Path $cache "$s.html"
    if(Test-Path $out){
        Write-Host "$s  cached"
        continue
    }
    $url = "https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=$s&ascii=html&isotope=some"
    try{
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60
        # -Encoding utf8 keeps the page byte-exact; Out-File would add a BOM
        [IO.File]::WriteAllText($out, $r.Content, [Text.Encoding]::UTF8)
        $n = ([regex]::Matches($r.Content,"(?<!\d)\d{1,3}\s+[A-Z][a-z]?\s+")).Count
        Write-Host "$s  fetched  (len $($r.Content.Length), $n candidate rows)"
    } catch {
        Write-Host "$s  FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
    Start-Sleep -Milliseconds $pause
}
