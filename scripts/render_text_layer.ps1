[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Use the built-in Windows font engine consistently when invoked from PowerShell 7.
if ($PSVersionTable.PSEdition -eq 'Core') {
    $desktopPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $desktopPowerShell -PathType Leaf)) { throw 'This renderer requires Windows PowerShell and System.Drawing.' }
    & $desktopPowerShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -PlanPath $PlanPath -OutputPath $OutputPath -ReportPath $ReportPath
    exit $LASTEXITCODE
}

function Has-Property($Object, [string]$Name) {
    return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]
}
function Need-Property($Object, [string]$Name, [string]$Context) {
    if (-not (Has-Property $Object $Name)) { throw "Missing $Context.$Name" }
    return ,($Object.$Name)
}
function Number($Value, [string]$Context, [bool]$Integer = $false) {
    if ($Value -is [bool] -or $Value -is [string] -or $null -eq $Value) { throw "$Context must be a JSON number." }
    $n = [double]$Value
    if ([double]::IsNaN($n) -or [double]::IsInfinity($n)) { throw "$Context must be finite." }
    if ($Integer -and ($n -ne [Math]::Floor($n) -or $n -lt [int]::MinValue -or $n -gt [int]::MaxValue)) { throw "$Context must be an integer pixel value." }
    return $n
}
function String-Value($Value, [string]$Context) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw "$Context must be a nonempty string." }
    return $Value
}
function New-Destination([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ([IO.File]::Exists($full) -or [IO.Directory]::Exists($full)) { throw "Refusing to overwrite existing destination: $full" }
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($full))) { throw "Destination folder does not exist: $full" }
    return $full
}

$rendered = $null
$createdOutput = $false
$createdReport = $false
try {
    $source = [IO.Path]::GetFullPath($PlanPath)
    $destination = New-Destination $OutputPath
    $reportDestination = New-Destination $ReportPath
    if ([string]::Equals($destination, $reportDestination, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputPath and ReportPath must be different.' }
    if ([IO.Path]::GetExtension($destination) -ine '.png') { throw 'OutputPath must end in .png.' }
    $plan = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ((Number (Need-Property $plan 'version' 'plan') 'version' $true) -ne 1) { throw 'Only plan version 1 is supported.' }
    $canvas = Need-Property $plan 'canvas' 'plan'
    $width = [int](Number (Need-Property $canvas 'width' 'canvas') 'canvas.width' $true)
    $height = [int](Number (Need-Property $canvas 'height' 'canvas') 'canvas.height' $true)
    if ($width -le 0 -or $height -le 0) { throw 'Canvas dimensions must be positive.' }
    $text = Need-Property $plan 'text' 'plan'
    if ($text -isnot [Array] -or $text.Count -eq 0) { throw 'text must be a nonempty JSON array.' }
    $cleanup = Need-Property $plan 'cleanup' 'plan'
    if ($null -eq $cleanup) { $cleanup = @() }
    if ($cleanup -isnot [Array]) { throw 'cleanup must be a JSON array.' }
    foreach ($zone in $cleanup) {
        $rect = Need-Property $zone 'rect' 'cleanup'
        if ($rect -isnot [Array] -or $rect.Count -ne 4) { throw 'cleanup.rect must be [x,y,width,height].' }
        $r = @(for ($i = 0; $i -lt 4; $i++) { Number $rect[$i] "cleanup.rect[$i]" $true })
        if ($r[0] -lt 0 -or $r[1] -lt 0 -or $r[2] -le 0 -or $r[3] -le 0 -or ($r[0] + $r[2]) -gt $width -or ($r[1] + $r[3]) -gt $height) { throw 'cleanup.rect is outside the canvas or empty.' }
        $mode = Need-Property $zone 'mode' 'cleanup'
        if ($mode -cne 'matched-band' -and $mode -cne 'plate') { throw 'cleanup.mode must be matched-band or plate.' }
        if ($mode -ceq 'matched-band' -or (Has-Property $zone 'sampleRows')) {
            $rows = Need-Property $zone 'sampleRows' 'cleanup'
            if ($rows -isnot [Array] -or $rows.Count -ne 2) { throw 'cleanup.sampleRows must be [topRow,bottomRow].' }
            $top = Number $rows[0] 'cleanup.sampleRows[0]' $true
            $bottom = Number $rows[1] 'cleanup.sampleRows[1]' $true
            if ($top -lt 0 -or $bottom -ge $height -or $top -ge $r[1] -or $bottom -lt ($r[1] + $r[3])) { throw 'cleanup.sampleRows must bracket the rectangle outside its top and bottom, inside the canvas.' }
        }
        if (-not (Has-Property $zone 'feather')) { $zone | Add-Member -NotePropertyName feather -NotePropertyValue 8 }
        if (-not (Has-Property $zone 'residualWeight')) { $zone | Add-Member -NotePropertyName residualWeight -NotePropertyValue 0.35 }
        if ((Number $zone.feather 'cleanup.feather') -lt 0) { throw 'cleanup.feather must be nonnegative.' }
        $weight = Number $zone.residualWeight 'cleanup.residualWeight'
        if ($weight -lt 0 -or $weight -gt 1) { throw 'cleanup.residualWeight must be between 0 and 1.' }
    }
    Add-Type -AssemblyName System.Drawing
    if (-not ('ImageTextRetype.TextRenderer' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'TextRenderer.cs') -ReferencedAssemblies System.Drawing }
    $specs = New-Object 'System.Collections.Generic.List[ImageTextRetype.TextSpec]'
    $ids = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $unitCount = 0
    foreach ($item in $text) {
        $spec = New-Object ImageTextRetype.TextSpec
        $spec.Id = String-Value (Need-Property $item 'id' 'text') 'text.id'
        if (-not $ids.Add($spec.Id)) { throw "Duplicate text.id: $($spec.Id)" }
        $spec.Text = String-Value (Need-Property $item 'text' $spec.Id) "$($spec.Id).text"
        if ($spec.Text -match '[\r\n\u0085\u2028\u2029]') { throw "Each text item must be a single line: $($spec.Id)" }
        $spec.X = [int](Number (Need-Property $item 'x' $spec.Id) "$($spec.Id).x" $true)
        $spec.Y = [int](Number (Need-Property $item 'y' $spec.Id) "$($spec.Id).y" $true)
        $spec.Font = String-Value (Need-Property $item 'font' $spec.Id) "$($spec.Id).font"
        $size = Number (Need-Property $item 'size' $spec.Id) "$($spec.Id).size"
        if ($size -le 0 -or $size -gt [single]::MaxValue) { throw "Font size must be a positive finite pixel value: $($spec.Id)" }
        $spec.Size = [single]$size
        $bold = Need-Property $item 'bold' $spec.Id
        if ($bold -isnot [bool]) { throw "bold must be a JSON boolean: $($spec.Id)" }
        $spec.Bold = $bold
        $spec.Color = String-Value (Need-Property $item 'color' $spec.Id) "$($spec.Id).color"
        if ($spec.Color -notmatch '^#[0-9A-Fa-f]{6}$') { throw "color must be #RRGGBB: $($spec.Id)" }
        $tracking = Number (Need-Property $item 'tracking' $spec.Id) "$($spec.Id).tracking"
        if ([Math]::Abs($tracking) -gt [single]::MaxValue) { throw "tracking is out of range: $($spec.Id)" }
        $spec.Tracking = [single]$tracking
        if (Has-Property $item 'group') { $spec.Group = String-Value $item.group "$($spec.Id).group" }
        if (Has-Property $item 'role') { $spec.Role = String-Value $item.role "$($spec.Id).role" }
        if ($spec.Role -ceq 'unit') { $unitCount++ }
        $specs.Add($spec)
    }
    if ((Has-Property $plan 'expected') -and (Has-Property $plan.expected 'unitCount')) {
        $expected = Number $plan.expected.unitCount 'expected.unitCount' $true
        if ($expected -lt 0 -or $expected -ne $unitCount) { throw "Expected $expected units, found $unitCount items with role=unit." }
    }
    $rendered = [ImageTextRetype.TextRenderer]::Render($width, $height, $specs.ToArray())
    $report = [ordered]@{
        version = 1; canvas = [ordered]@{ width = $width; height = $height }
        lineCount = $specs.Count; unitCount = $unitCount
        items = @($rendered.Items); cleanup = @($cleanup)
        cleanupApplied = $false
    }
    $json = $report | ConvertTo-Json -Depth 12
    # CreateNew prevents replacement even if a destination appears after validation.
    $rendered.SaveNew($destination)
    $createdOutput = $true
    $stream = New-Object IO.FileStream($reportDestination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $createdReport = $true
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    Write-Output ("Rendered {0} lines ({1} units): {2}" -f $specs.Count, $unitCount, $destination)
} catch {
    if ($createdOutput) { [IO.File]::Delete($destination) }
    if ($createdReport) { [IO.File]::Delete($reportDestination) }
    Write-Error $_
    exit 1
} finally {
    if ($null -ne $rendered) { $rendered.Dispose() }
}
