param(
    [string]$RendererPath = (Join-Path $PSScriptRoot '..\scripts\render_text_layer.ps1'),
    [string]$Font = 'Microsoft YaHei UI'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
Assert (Test-Path -LiteralPath $RendererPath -PathType Leaf) 'Renderer implementation is missing.'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$run = Join-Path $tempRoot ('image-text-retype-renderer-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
try {
function Save-Plan($plan, [string]$name) {
    $path = Join-Path $run ($name + '.json')
    [IO.File]::WriteAllText($path, ($plan | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    return $path
}
function Invoke-Renderer([string]$plan, [string]$output, [string]$report, [bool]$success) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $log = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $RendererPath -PlanPath $plan -OutputPath $output -ReportPath $report 2>&1
        $status = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($success) { Assert ($status -eq 0) ('Render failed: ' + ($log -join [Environment]::NewLine)) }
    else { Assert ($status -ne 0) 'Invalid request unexpectedly succeeded.' }
}
$cjkTitle = -join @([char]0x4E2D, [char]0x6587, [char]0x6E05, [char]0x6670)
$cjkUnitA = -join @([char]0x7B2C, [char]0x4E00, [char]0x5355, [char]0x4F4D)
$cjkUnitB = -join @([char]0x7B2C, [char]0x4E8C, [char]0x5355, [char]0x4F4D)
$plan = [ordered]@{
    version = 1; canvas = @{ width = 1000; height = 400 }
    text = @(
        @{ id = 'title'; text = $cjkTitle; x = 30; y = 25; font = $Font; size = 44; bold = $true; color = '#AABBCC'; tracking = 2; role = 'title' },
        @{ id = 'unit-a'; text = $cjkUnitA; x = 30; y = 115; font = $Font; size = 34; bold = $false; color = '#FFFFFF'; tracking = 1; role = 'unit' },
        @{ id = 'unit-b'; text = $cjkUnitB; x = 30; y = 205; font = $Font; size = 34; bold = $false; color = '#FFFFFF'; tracking = 1; role = 'unit' },
        @{ id = 'combining'; text = ('A' + [char]0x0301 + 'B'); x = 30; y = 295; font = 'Arial'; size = 38; bold = $false; color = '#FFFFFF'; tracking = 12 }
    )
    cleanup = @(@{ rect = @(10, 10, 800, 80); mode = 'matched-band'; sampleRows = @(5, 95); feather = 8; residualWeight = 0.35 })
    expected = @{ unitCount = 2 }
}
$valid = Save-Plan $plan 'valid'
$png = Join-Path $run 'text.png'; $reportPath = Join-Path $run 'report.json'
Invoke-Renderer $valid $png $reportPath $true
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert ($report.lineCount -eq 4 -and $report.unitCount -eq 2) 'Line or unit counts are wrong.'
Assert ($report.items[3].graphemeCount -eq 2) 'Combining mark was split into a separate tracked glyph.'
Assert ($report.items[0].actualFont -eq $Font) 'Font was silently substituted.'
$bitmap = [Drawing.Bitmap]::FromFile($png)
try {
    Assert ($bitmap.Width -eq 1000 -and $bitmap.Height -eq 400) 'PNG canvas size changed.'
    Assert ($bitmap.GetPixel(0, 0).A -eq 0 -and $bitmap.GetPixel(999, 399).A -eq 0) 'PNG does not have transparent outer bounds.'
    foreach ($item in $report.items) {
        $b = $item.bbox
        $minX = $bitmap.Width; $minY = $bitmap.Height; $maxX = -1; $maxY = -1
        for ($y = $b.y; $y -lt ($b.y + $b.height); $y++) {
            for ($x = $b.x; $x -lt ($b.x + $b.width); $x++) {
                if ($bitmap.GetPixel($x, $y).A -gt 0) {
                    $minX = [Math]::Min($minX, $x); $minY = [Math]::Min($minY, $y)
                    $maxX = [Math]::Max($maxX, $x); $maxY = [Math]::Max($maxY, $y)
                }
            }
        }
        Assert ($minX -eq $b.x -and $minY -eq $b.y -and ($maxX - $minX + 1) -eq $b.width -and ($maxY - $minY + 1) -eq $b.height) 'Reported ink bounds differ from actual PNG pixels.'
    }
} finally { $bitmap.Dispose() }
$pngHash = (Get-FileHash -LiteralPath $png -Algorithm SHA256).Hash
$reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash
Invoke-Renderer $valid $png (Join-Path $run 'overwrite.json') $false
$newPng = Join-Path $run 'report-exists.png'
Invoke-Renderer $valid $newPng $reportPath $false
Assert (-not (Test-Path -LiteralPath $newPng)) 'Output was created despite an existing report.'
Assert ((Get-FileHash -LiteralPath $png -Algorithm SHA256).Hash -eq $pngHash) 'Existing PNG was modified.'
Assert ((Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash -eq $reportHash) 'Existing report was modified.'
$plan.text[0].font = '__font_that_does_not_exist_73c04f__'
$bad = Save-Plan $plan 'missing-font'; Invoke-Renderer $bad (Join-Path $run 'missing-font.png') (Join-Path $run 'missing-font-report.json') $false
$plan.text[0].font = $Font; $plan.text[0].x = 999
$bad = Save-Plan $plan 'out-of-bounds'; Invoke-Renderer $bad (Join-Path $run 'bounds.png') (Join-Path $run 'bounds-report.json') $false
$plan.text[0].x = 30; $plan.text[1].y = 25
$bad = Save-Plan $plan 'overlap'; Invoke-Renderer $bad (Join-Path $run 'overlap.png') (Join-Path $run 'overlap-report.json') $false
$plan.text[1].y = 115; $plan.expected.unitCount = 16
$bad = Save-Plan $plan 'count'; Invoke-Renderer $bad (Join-Path $run 'count.png') (Join-Path $run 'count-report.json') $false
$plan.Remove('expected')
$noExpected = Save-Plan $plan 'no-expected'
Invoke-Renderer $noExpected (Join-Path $run 'no-expected.png') (Join-Path $run 'no-expected-report.json') $true
$singlePlan = @{ version = 1; canvas = $plan.canvas; text = @($plan.text[3]); cleanup = @() }
$singlePath = Save-Plan $singlePlan 'single-empty-cleanup'
$singleReport = Join-Path $run 'single-report.json'
Invoke-Renderer $singlePath (Join-Path $run 'single.png') $singleReport $true
$singleResult = Get-Content -LiteralPath $singleReport -Raw -Encoding UTF8 | ConvertFrom-Json
Assert ($singleResult.lineCount -eq 1 -and $singleResult.unitCount -eq 0 -and $singleResult.cleanup.Count -eq 0) 'Single text item or empty cleanup was not preserved.'
$unicodeText = [char]::ConvertFromUtf32(0x1F469) + [char]0x200D + [char]::ConvertFromUtf32(0x1F4BB) + [char]::ConvertFromUtf32(0x1F1E8) + [char]::ConvertFromUtf32(0x1F1F3)
$singlePlan.text = @(@{ id = 'unicode'; text = $unicodeText; x = 30; y = 30; font = 'Segoe UI Emoji'; size = 44; bold = $false; color = '#FFFFFF'; tracking = 8 })
$unicodePath = Save-Plan $singlePlan 'unicode-graphemes'
$unicodeReport = Join-Path $run 'unicode-report.json'
Invoke-Renderer $unicodePath (Join-Path $run 'unicode.png') $unicodeReport $true
$unicodeResult = Get-Content -LiteralPath $unicodeReport -Raw -Encoding UTF8 | ConvertFrom-Json
Assert ($unicodeResult.items[0].graphemeCount -eq 2) 'ZWJ or regional-indicator pair was split by tracking.'
$singlePlan.cleanup = @(@{ rect = @(10, 10, 800, 80); mode = 'plate' })
$platePath = Save-Plan $singlePlan 'plate-defaults'
$plateReport = Join-Path $run 'plate-defaults-report.json'
Invoke-Renderer $platePath (Join-Path $run 'plate-defaults.png') $plateReport $true
$plateResult = Get-Content -LiteralPath $plateReport -Raw -Encoding UTF8 | ConvertFrom-Json
Assert ($plateResult.cleanup[0].feather -eq 8 -and $plateResult.cleanup[0].residualWeight -eq 0.35) 'Cleanup defaults were not recorded.'
$singlePlan.cleanup = @(@{ rect = @(10, 10, 800, 80); mode = 'matched-band'; sampleRows = @(5, 90) })
$bandPath = Save-Plan $singlePlan 'band-defaults'
Invoke-Renderer $bandPath (Join-Path $run 'band-defaults.png') (Join-Path $run 'band-defaults-report.json') $true
foreach ($sampleRows in @(@(10, 95), @(5, 89))) {
    $singlePlan.cleanup[0].sampleRows = $sampleRows
    $name = 'band-inside-' + $sampleRows[0] + '-' + $sampleRows[1]
    $invalidBand = Save-Plan $singlePlan $name
    Invoke-Renderer $invalidBand (Join-Path $run ($name + '.png')) (Join-Path $run ($name + '-report.json')) $false
}
$singlePlan.cleanup[0].Remove('sampleRows')
$missingRows = Save-Plan $singlePlan 'band-missing-rows'
Invoke-Renderer $missingRows (Join-Path $run 'band-missing-rows.png') (Join-Path $run 'band-missing-rows-report.json') $false


} finally {
    # Only remove the unique temporary directory created by this test run.
    $resolvedRun = [IO.Path]::GetFullPath($run)
    $resolvedParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($resolvedRun))
    $expectedParent = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (-not [string]::Equals($resolvedParent, $expectedParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($resolvedRun).StartsWith('image-text-retype-renderer-test-', [StringComparison]::Ordinal)) {
        throw 'Refusing to remove a path outside the test temporary directory.'
    }
    if (Test-Path -LiteralPath $resolvedRun) { Remove-Item -LiteralPath $resolvedRun -Recurse -Force }
}
Write-Output ('PASS: true-font CJK, grapheme tracking, transparent ink bounds, count reporting, missing-font/bounds/overlap/overwrite/count rejection. Temporary artifacts were removed.')
