using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

namespace ImageTextRetype {
    public sealed class TextSpec {
        public string Id, Text, Font, Color, Group, Role;
        public int X, Y;
        public float Size, Tracking;
        public bool Bold;
    }
    public sealed class InkBox {
        public int x, y, width, height;
        public InkBox(Rectangle r) { x = r.X; y = r.Y; width = r.Width; height = r.Height; }
    }
    public sealed class ItemReport {
        public string id, text, requestedFont, actualFont, color, group, role;
        public InkBox bbox;
        public float size, tracking, advance;
        public bool bold;
        public int graphemeCount;
    }
    public sealed class RenderResult : IDisposable {
        public Bitmap Image;
        public ItemReport[] Items;
        public void SaveNew(string path) {
            bool created = false;
            try {
                using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    created = true;
                    Image.Save(stream, ImageFormat.Png);
                }
            } catch { if (created) File.Delete(path); throw; }
        }
        public void Dispose() { if (Image != null) { Image.Dispose(); Image = null; } }
    }
    internal sealed class Tile : IDisposable {
        public Bitmap Image;
        public ItemReport Report;
        public Rectangle Bounds;
        public void Dispose() { if (Image != null) Image.Dispose(); }
    }

    public static class TextRenderer {
        private static FontFamily FindFamily(string requested) {
            using (var fonts = new InstalledFontCollection()) {
                foreach (var family in fonts.Families) {
                    bool match = String.Equals(family.Name, requested, StringComparison.OrdinalIgnoreCase);
                    foreach (int language in new int[] { 0x409, 0x804, 0x404, CultureInfo.CurrentUICulture.LCID }) {
                        try { match |= String.Equals(family.GetName(language), requested, StringComparison.OrdinalIgnoreCase); }
                        catch (ArgumentException) { }
                    }
                    if (match) return new FontFamily(family.Name);
                }
            }
            throw new ArgumentException("Font is not installed: " + requested);
        }

        private static int FirstCodePoint(string value) { return Char.ConvertToUtf32(value, 0); }
        private static int LastCodePoint(string value) {
            int offset = value.Length - 1;
            if (offset > 0 && Char.IsLowSurrogate(value[offset]) && Char.IsHighSurrogate(value[offset - 1])) offset--;
            return Char.ConvertToUtf32(value, offset);
        }
        private static bool IsExtend(int cp) {
            if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF) ||
                (cp >= 0x1F3FB && cp <= 0x1F3FF) || (cp >= 0xE0020 && cp <= 0xE007F)) return true;
            var category = CharUnicodeInfo.GetUnicodeCategory(Char.ConvertFromUtf32(cp), 0);
            return category == UnicodeCategory.NonSpacingMark || category == UnicodeCategory.SpacingCombiningMark ||
                category == UnicodeCategory.EnclosingMark;
        }
        private static int Hangul(int cp) {
            if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0xA960 && cp <= 0xA97C)) return 1;
            if ((cp >= 0x1160 && cp <= 0x11A7) || (cp >= 0xD7B0 && cp <= 0xD7C6)) return 2;
            if ((cp >= 0x11A8 && cp <= 0x11FF) || (cp >= 0xD7CB && cp <= 0xD7FB)) return 3;
            if (cp >= 0xAC00 && cp <= 0xD7A3) return ((cp - 0xAC00) % 28 == 0) ? 4 : 5;
            return 0;
        }
        private static bool IsRegional(int cp) { return cp >= 0x1F1E6 && cp <= 0x1F1FF; }
        // StringInfo preserves surrogate pairs and combining marks. Merge additional
        // extended clusters on Windows PowerShell's older .NET Framework runtime.
        private static List<string> Graphemes(string text) {
            var result = new List<string>();
            var elements = StringInfo.GetTextElementEnumerator(text);
            int regionalRun = 0;
            while (elements.MoveNext()) {
                string element = elements.GetTextElement();
                int first = FirstCodePoint(element);
                bool merge = false;
                if (result.Count > 0) {
                    int previous = LastCodePoint(result[result.Count - 1]);
                    int left = Hangul(previous), right = Hangul(first);
                    merge = first == 0x200D || previous == 0x200D || IsExtend(first) ||
                        (IsRegional(first) && regionalRun % 2 == 1) ||
                        (left == 1 && (right == 1 || right == 2 || right == 4 || right == 5)) ||
                        ((left == 2 || left == 4) && (right == 2 || right == 3)) ||
                        ((left == 3 || left == 5) && right == 3);
                }
                if (merge) result[result.Count - 1] += element;
                else result.Add(element);
                regionalRun = IsRegional(first) ? regionalRun + 1 : 0;
            }
            return result;
        }

        private static Rectangle InkBounds(Bitmap bitmap) {
            int left = bitmap.Width, top = bitmap.Height, right = -1, bottom = -1;
            var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                var row = new byte[bitmap.Width * 4];
                for (int y = 0; y < bitmap.Height; y++) {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                    for (int x = 0; x < bitmap.Width; x++) {
                        if (row[x * 4 + 3] == 0) continue;
                        if (x < left) left = x;
                        if (x > right) right = x;
                        if (y < top) top = y;
                        if (y > bottom) bottom = y;
                    }
                }
            } finally { bitmap.UnlockBits(data); }
            if (right < left) throw new ArgumentException("Text has no visible glyph pixels.");
            return Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
        }

        private static Tile RenderTile(TextSpec item) {
            using (var family = FindFamily(item.Font)) {
                var style = item.Bold ? FontStyle.Bold : FontStyle.Regular;
                if (!family.IsStyleAvailable(style)) throw new ArgumentException("Requested font style is unavailable: " + item.Font + " / " + style);
                using (var font = new Font(family, item.Size, style, GraphicsUnit.Pixel))
                using (var format = (StringFormat)StringFormat.GenericTypographic.Clone())
                using (var measure = new Bitmap(1, 1, PixelFormat.Format32bppArgb))
                using (var graphics = Graphics.FromImage(measure)) {
                    format.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoClip | StringFormatFlags.NoFontFallback;
                    graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    var elements = Graphemes(item.Text);
                    var positions = new List<float>();
                    float pen = 0, min = 0, max = 0;
                    for (int i = 0; i < elements.Count; i++) {
                        float width = graphics.MeasureString(elements[i], font, PointF.Empty, format).Width;
                        positions.Add(pen);
                        min = Math.Min(min, pen); max = Math.Max(max, pen + width);
                        pen += width + (i < elements.Count - 1 ? item.Tracking : 0);
                    }
                    if (Single.IsInfinity(pen) || Single.IsNaN(pen)) throw new ArgumentException("Text width is not finite: " + item.Id);
                    int pad = Math.Max(16, checked((int)Math.Ceiling(item.Size * 2)));
                    int tempWidth = checked((int)Math.Ceiling(max - min) + pad * 2);
                    int tempHeight = checked((int)Math.Ceiling(font.GetHeight(graphics) * 2) + pad * 2);
                    using (var temporary = new Bitmap(tempWidth, tempHeight, PixelFormat.Format32bppArgb))
                    using (var draw = Graphics.FromImage(temporary))
                    using (var brush = new SolidBrush(ColorTranslator.FromHtml(item.Color))) {
                        draw.Clear(Color.Transparent);
                        draw.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                        draw.SmoothingMode = SmoothingMode.HighQuality;
                        draw.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        for (int i = 0; i < elements.Count; i++)
                            draw.DrawString(elements[i], font, brush, new PointF(pad - min + positions[i], pad), format);
                        draw.Flush();
                        Rectangle ink = InkBounds(temporary);
                        if (ink.Left == 0 || ink.Top == 0 || ink.Right == temporary.Width || ink.Bottom == temporary.Height)
                            throw new ArgumentException("Glyph reached the measurement edge; increase measurement padding: " + item.Id);
                        var bounds = new Rectangle(item.X, item.Y, ink.Width, ink.Height);
                        return new Tile {
                            Image = temporary.Clone(ink, PixelFormat.Format32bppArgb), Bounds = bounds,
                            Report = new ItemReport { id = item.Id, text = item.Text, requestedFont = item.Font,
                                actualFont = font.FontFamily.Name, size = item.Size, bold = item.Bold, color = item.Color,
                                tracking = item.Tracking, graphemeCount = elements.Count, advance = pen,
                                bbox = new InkBox(bounds), group = item.Group, role = item.Role }
                        };
                    }
                }
            }
        }

        public static RenderResult Render(int width, int height, TextSpec[] items) {
            var tiles = new List<Tile>();
            Bitmap output = null;
            try {
                foreach (var item in items) {
                    var tile = RenderTile(item);
                    tiles.Add(tile);
                    if (tile.Bounds.Left < 0 || tile.Bounds.Top < 0 || (long)tile.Bounds.X + tile.Bounds.Width > width || (long)tile.Bounds.Y + tile.Bounds.Height > height)
                        throw new ArgumentException("Text ink is outside the canvas: " + item.Id);
                    for (int i = 0; i < tiles.Count - 1; i++)
                        if (tile.Bounds.IntersectsWith(tiles[i].Bounds))
                            throw new ArgumentException("Text bounding boxes overlap: " + tiles[i].Report.id + " and " + item.Id);
                }
                output = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                using (var graphics = Graphics.FromImage(output)) {
                    graphics.Clear(Color.Transparent);
                    foreach (var tile in tiles) graphics.DrawImageUnscaled(tile.Image, tile.Bounds.X, tile.Bounds.Y);
                }
                var reports = new ItemReport[tiles.Count];
                for (int i = 0; i < tiles.Count; i++) reports[i] = tiles[i].Report;
                var result = new RenderResult { Image = output, Items = reports };
                output = null;
                return result;
            } finally {
                if (output != null) output.Dispose();
                foreach (var tile in tiles) tile.Dispose();
            }
        }
    }
}
