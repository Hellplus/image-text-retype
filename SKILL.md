---
name: image-text-retype
description: Use when small text in an existing poster, backdrop, welcome screen, screenshot, or upscaled image is blurred or distorted and the user wants it re-typeset while preserving the background, layout, and full pixel dimensions. 适用于图片小字排清楚、文字笔画失真、背景墙小字重排、保留原背景和高清尺寸的任务。
---

# 图片小字清晰重排

以原高清图作底稿，清除指定旧字，再用真实字体按原版式排字。适合已有准确文案、需要清晰文字的位图；普通整图放大或重绘不属于此技能。

## 执行流程

1. **锁定输入与文案。** 实读原图尺寸、透明通道及 SHA-256，查看整图和原尺寸小字。优先采用用户已确认文字或相关原稿；逐项核对名称、日期、数字和分组。顺序按用户最新要求，允许明确指定与另一张已确认稿一致。名单和数量均为本次输入，不固定为16家。缺失的关键字保留待核对，不凭生成笔画猜写。
2. **测量并配置。** 在原尺寸坐标系内记录目标旧字及浅色描边完整范围、文字墨迹起点、字号、颜色、字距和行距。维持原有层级及整体位置；其余标题、Logo、插画和装饰保留。按 [配置与运行](references/plan-format.md) 建立 `plan.json`。
3. **清理旧字。** 使用可用的内置图像编辑工具，仅移除获准旧字及描边，得到干净背景中间稿；已有合适清底稿时复用。清底稿可比原图小，最终合成仍以原高清图为底。复杂背景使用 `plate` 局部修补；平滑浅底或渐变可使用 `matched-band` 校正。采样行须处于无字干净背景，完整清理文字带以消除白描边。
4. **真实字体重排。** 运行 `render_text_layer.ps1` 生成透明文字层，再运行 `compose.cjs` 合成 PNG。字体实际存在、文字不相交且不越界后才进入合成。合成器核验原图不变、输出尺寸等于原图、目标区域之外逐像素一致。工具依赖缺失时报告具体缺项，保留已完成部分。
5. **图像核验。** 对照准确文案逐项看完整文字；查看整图及原尺寸局部，检查错漏字、顺序、笔画、间距、裁字、旧字和白边残影、接缝及色块。脚本通过不替代视觉检查。发现问题时调整清理区域、采样或字体后复核；无法核准的内容或背景修补缺口须如实说明。
6. **另存和交付。** 完整 PNG 保持输入的实际宽高，使用新文件名。预览图明确标为预览；下载链接指向已核验的完整 PNG，清底中间稿不作为成品。用户要求同目录时按其路径另存，以禁止覆盖的文件复制并比对 SHA-256，复核原图哈希。完成回执写明尺寸、新文件位置、未覆盖原图及尚存问题。

## 本地工具

工具适用 Windows 的常规8位、单帧 RGB/RGBA 位图。真实字体渲染使用 PowerShell、System.Drawing/C#；合成使用 Node.js、`sharp`。优先通过环境的 `load_workspace_dependencies` 找到现有运行库；Node 可用 `NODE_PATH` 指向其模块目录。脚本不下载字体、模型或依赖。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/render_text_layer.ps1 -PlanPath plan.json -OutputPath text-layer.png -ReportPath text-layer.report.json
node scripts/compose.cjs --source original.png --clean-plate clean.png --text-layer text-layer.png --plan plan.json --output final.png --report final.report.json
```

执行策略选项仅作用于本次已审阅脚本的进程，不修改持久策略。输出与报告均使用新路径。详细配置、清底方式选择、运行及交付核验见 [references/plan-format.md](references/plan-format.md)。
