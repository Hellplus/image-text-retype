# 配置与运行

## 计划格式

`plan.json` 使用 UTF-8，版本为 `1`。所有坐标和字号均为原高清图的实际像素，矩形统一为 `[x, y, width, height]`。

```json
{
  "version": 1,
  "canvas": {"width": 1200, "height": 600},
  "text": [
    {"id": "guidance-label", "text": "指导单位：", "x": 120, "y": 380, "font": "Microsoft YaHei", "size": 42, "bold": true, "color": "#FF0000", "tracking": 2, "group": "guidance", "role": "label"},
    {"id": "guidance-1", "text": "示例文化和旅游局", "x": 370, "y": 385, "font": "Microsoft YaHei", "size": 36, "bold": false, "color": "#800000", "tracking": 1, "group": "guidance", "role": "unit"},
    {"id": "date", "text": "2026年10月30日", "x": 120, "y": 455, "font": "Microsoft YaHei", "size": 30, "bold": false, "color": "#800000", "tracking": 2, "group": "date", "role": "date"}
  ],
  "cleanup": [
    {"rect": [90, 350, 1020, 170], "mode": "matched-band", "sampleRows": [330, 540], "feather": 8, "residualWeight": 0.35}
  ],
  "expected": {"unitCount": 1}
}
```

这是结构示例，实际任务从原图测量配置，不套用其文字和坐标。

### 文字字段

每个 `text` 条目是一段单行文字，`x/y` 对应渲染后实际可见墨迹左上角，而非字体行框。不同字号因此可以通过实测高度对齐。

- `id`：唯一标识；`text`：已核准的精确文字。
- `font`：已安装的 Windows 字体名；中英文字体别名应以系统可解析名称为准。字体缺失时替换为另一种已核对的真实字体，并重新测量。
- `size`：像素字号；`bold`：粗体；`color`：十六进制颜色；`tracking`：字素间附加像素间距。
- `group`、`role`：可选记录信息。`role: "unit"` 表示一名单单位，标签、分隔符和日期分别作为其他条目。
- `expected.unitCount`：可选，仅统计 `role: "unit"` 的条目，排版条目总数和单位数不能混为一谈。

文字层脚本输出实际边界、字体和数量。多行内容拆成单行条目；间隔竖线也作为有位置的真实字体条目。

### 清底字段与选择

`cleanup` 描述允许修改的区域，区域之外的图像必须与原图逐像素一致。文字层的所有可见像素也应位于这些区域内。

每个 `rect` 包含旧字、其浅色描边、羽化边缘，以及新文字所需范围。先看原尺寸局部，避免小范围遮罩只清掉深色笔画而留下白色字影。

| mode | 适用条件 | 方法 |
|---|---|---|
| `matched-band` | 不透明、平滑浅底或低频渐变 | 用原图上/下干净采样行逐列还原渐变，加清底稿的局部残差，再对完整文字带羽化 |
| `plate` | 图案、山水、纹理、边框等复杂背景 | 将图像编辑工具的清底稿局部贴回原高清底稿，在区域边缘羽化；必须视觉复核局部图案和接缝 |

`matched-band` 的 `sampleRows: [topY, bottomY]` 为原尺寸纵坐标，分别位于清理带上方和下方；采样行必须没有文字、浅描边或别的图案。相邻文字行之间的干净空隙通常比远处跨行采样可靠。需要补回复杂图案时使用 `plate`，不把条带插值用到图案区域。

`feather` 为区域内的边缘羽化宽度，通常从 8 px 起，按图像实际分辨率调整；旧字及其描边应位于不透明的修补核心内。`residualWeight` 仅用于 `matched-band`，通常从 0.35 起，按局部效果调整。

清底中间图须和原图构图、比例对齐。合成器允许比例匹配的低分辨率清底稿提升到原图像素，用作区域素材；最终画布始终取自原图。错误比例、越界、错误采样行、图层外溢和已存在输出应先修正配置或采用新路径。

## 运行

工具处理常规8位、单帧 RGB/RGBA 位图；16位、多帧或需要保持特殊色彩工作流的文件应使用支持该格式的编辑方式，经用户允许再做格式转换。

在当前环境确认现有 PowerShell、Node.js 和 `sharp`。可通过 Codex 的 `load_workspace_dependencies` 获取现有路径，然后令 `NODE_PATH` 指向其 Node 模块目录。字体来自本机，不随技能复制字体文件。字体外观取决于所选字体，GDI+ 不保证彩色 Emoji 或复杂文字塑形。

```powershell
$skillDir = '实际技能目录'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $skillDir 'scripts/render_text_layer.ps1') -PlanPath 'plan.json' -OutputPath 'text-layer.png' -ReportPath 'text-layer.report.json'
& node (Join-Path $skillDir 'scripts/compose.cjs') --source 'original.png' --clean-plate 'clean.png' --text-layer 'text-layer.png' --plan 'plan.json' --output 'final.png' --report 'final.report.json'
```

`-ExecutionPolicy Bypass` 仅用于运行本次已审阅的本地渲染脚本，不更改用户或机器级执行策略；若环境强制限制仍阻止执行，按该环境权限机制处理。PowerShell 7 调用时，脚本使用本机 Windows PowerShell 字体引擎。

脚本路径可以是绝对路径；相对路径按当前工作目录解析。输出和报告的父目录须已存在。输入、输出和报告保持不同路径，每次试排使用新版本名。字体报告用于核对字形、实际尺寸及边界，合成报告用于核对完整 PNG 的宽高、目标区外像素和原图哈希。脚本报告的准确字段以实际输出为准。

## 核验与另存

先查看整图，再按原尺寸查看每个修改区域。逐项核对文案及顺序，同时检查旧白描边、重影、断笔、字形碰撞、边框接缝和颜色突变。像素不变的保护范围是清理区之外；文字下方的背景是修补结果，有色差时继续匹配局部底色或调整修补范围后复核。验证完整 PNG 的实际宽高，而非依据文件名或聊天预览。

用户要求归档时，使用已核验的完整 PNG 另存到指定目录。目标目录应已存在，目标文件名须不同于原图，目标已存在时选择新版本名。

```powershell
$sourceHash = (Get-FileHash -LiteralPath $fullPng -Algorithm SHA256).Hash
$originalHash = (Get-FileHash -LiteralPath $originalPng -Algorithm SHA256).Hash
[System.IO.File]::Copy($fullPng, $destinationPng, $false)
if ((Get-FileHash -LiteralPath $destinationPng -Algorithm SHA256).Hash -ne $sourceHash) { throw '归档副本不一致' }
if ((Get-FileHash -LiteralPath $originalPng -Algorithm SHA256).Hash -ne $originalHash) { throw '原图发生变化' }
```

复制涉及受限目录时使用当前工具的授权机制；技能本身不扩展目录权限。只保存用户要求的交付内容，不顺带改其他稿件。回执报告完整图尺寸和新位置；本地图像自检与用户验收、实际印刷或大屏显示验收分别表述。
