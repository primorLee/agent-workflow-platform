"""awp_report_pdf — Markdown 报告 → PDF,**完整中文 + 字体嵌入**。自包含。

生产回归：通用 Markdown 报告若使用仅支持拉丁字符的字体转换，会导致中文乱码。
+ ps2pdf(纯拉丁字体)→ 中文全乱码。enscript/groff/a2ps/pdfroff 都不吃 UTF-8/CJK。
本工具 reportlab Platypus + **嵌入的 TrueType(glyf)CJK 字体子集**:中文字形随
PDF 走,任何阅读器(含 awp artifact 面板的 pdf.js)都正确显示,不依赖阅读器

用法(客户 VM 上 AI 经 vm_exec 调):
    python3 -m awp_report_pdf <input.md> <output.pdf> [--title "标题"]
支持:# 标题 / **粗体** / 表格 | a | b | / ``` 代码块 ``` / - · 列表 / 段落。
"""
import sys
import os
import re
import html as _html
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

__all__ = ["main", "build"]

# Emoji the AI commonly emits but a CJK text font lacks → safe equivalents the
# bundled font DOES have (✓ ✗ ● ▲ etc. are in U+2200-27BF / geometric blocks).
_EMOJI_MAP = {
    "✅": "✓", "✔️": "✓", "✔": "✓", "☑️": "✓", "✓": "✓",
    "❌": "✗", "✖️": "✗", "❎": "✗",
    "⚠️": "⚠", "❗": "!", "❓": "?",
    "🔴": "●", "🟢": "●", "🟡": "●", "🔵": "●", "⚪": "○", "⚫": "●",
    "🟥": "■", "🟩": "■", "🟦": "■", "⭐": "★", "✨": "*",
    "📊": "", "📈": "", "📉": "", "📋": "", "📝": "", "🔬": "", "⚡": "",
    "💡": "", "🚀": "", "🎯": "", "👉": "→", "➡️": "→", "→": "→",
}


def _sanitize(text: str) -> str:
    """Replace emoji with font-safe equivalents; strip any remaining
    astral-plane (U+10000+) chars so they never render as tofu boxes."""
    for k, v in _EMOJI_MAP.items():
        if k in text:
            text = text.replace(k, v)
    # variation selectors + ZWJ + any astral codepoints (emoji etc.)
    return "".join(
        c for c in text
        if ord(c) < 0x1F000 and ord(c) not in (0xFE0F, 0xFE0E, 0x200D)
    )


def _register_cjk() -> str:
    here = Path(__file__).resolve().parent
    for p in (os.environ.get("AWP_PDF_FONT", ""),
              "/usr/share/fonts/awp-cjk.ttf"):
        if p and os.path.exists(p):
            try:
                pdfmetrics.registerFont(TTFont("CJK", p))
                return "CJK"
            except Exception as e:
                sys.stderr.write(f"[awp_report_pdf] font {p} failed: {e}\n")
    # Last resort: reportlab built-in CID (NOT embedded — relies on viewer).
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    sys.stderr.write("[awp_report_pdf] WARNING: no embeddable CJK font found, "
                     "using non-embedded STSong-Light\n")
    return "STSong-Light"


def _styles(font: str):
    ss = getSampleStyleSheet()
    base = ParagraphStyle("body", parent=ss["BodyText"], fontName=font, fontSize=10.5, leading=16)
    return {
        "h1": ParagraphStyle("h1", parent=ss["Heading1"], fontName=font, fontSize=18, leading=24, spaceAfter=8),
        "h2": ParagraphStyle("h2", parent=ss["Heading2"], fontName=font, fontSize=14, leading=20, spaceBefore=8, spaceAfter=6),
        "h3": ParagraphStyle("h3", parent=ss["Heading3"], fontName=font, fontSize=12, leading=18, spaceBefore=6, spaceAfter=4),
        "body": base,
        "cell": ParagraphStyle("cell", parent=base, fontSize=9.5, leading=13),
        "code": ParagraphStyle("code", parent=base, fontName=font, fontSize=8.5, leading=11, backColor=colors.HexColor("#f4f4f4")),
        "li": ParagraphStyle("li", parent=base, leftIndent=14),
    }


def _inline(text: str) -> str:
    text = _html.escape(_sanitize(text), quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`(.+?)`", r"<font face='Courier'>\1</font>", text)
    return text


def _md_to_flowables(md: str, st: dict):
    flow, lines, i = [], md.replace("\r\n", "\n").split("\n"), 0
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith("```"):
            i += 1; buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            flow.append(Preformatted(_sanitize("\n".join(buf)) or " ", st["code"])); flow.append(Spacer(1, 4)); continue
        if ln.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?[\s:|-]+\|?\s*$", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                if re.match(r"^\s*\|?[\s:|-]+\|?\s*$", lines[i]):
                    i += 1; continue
                rows.append([Paragraph(_inline(c.strip()), st["cell"]) for c in lines[i].strip().strip("|").split("|")])
                i += 1
            if rows:
                t = Table(rows, hAlign="LEFT")
                t.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f7")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]))
                flow.append(t); flow.append(Spacer(1, 6))
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", ln)
        if m:
            flow.append(Paragraph(_inline(m.group(2)), st[f"h{len(m.group(1))}"])); i += 1; continue
        m = re.match(r"^\s*[-*]\s+(.*)$", ln)
        if m:
            flow.append(Paragraph("• " + _inline(m.group(1)), st["li"])); i += 1; continue
        m = re.match(r"^\s*(\d+)\.\s+(.*)$", ln)
        if m:
            flow.append(Paragraph(f"{m.group(1)}. " + _inline(m.group(2)), st["li"])); i += 1; continue
        if not ln.strip():
            flow.append(Spacer(1, 4)); i += 1; continue
        para = [ln]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,3}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*\|)", lines[i]):
            para.append(lines[i]); i += 1
        flow.append(Paragraph(_inline(" ".join(para)), st["body"]))
    return flow


def build(md_text: str, out_path: str, title: str = "") -> str:
    font = _register_cjk()
    st = _styles(font)
    doc = SimpleDocTemplate(str(out_path), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=16 * mm, bottomMargin=16 * mm, title=_sanitize(title) or Path(out_path).stem)
    flow = []
    if title:
        flow.append(Paragraph(_inline(title), st["h1"])); flow.append(Spacer(1, 6))
    flow += _md_to_flowables(md_text, st)
    doc.build(flow)
    return font


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 2:
        sys.stderr.write("Usage: python3 -m awp_report_pdf <input.md> <output.pdf> [--title T]\n")
        return 2
    inp, outp = Path(argv[0]), Path(argv[1])
    title = argv[argv.index("--title") + 1] if "--title" in argv else ""
    font = build(inp.read_text(encoding="utf-8"), str(outp), title)
    sys.stderr.write(f"[awp_report_pdf] wrote {outp} ({outp.stat().st_size} B) font={font}\n")
    return 0
