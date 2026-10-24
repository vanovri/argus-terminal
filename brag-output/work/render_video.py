import math
import os
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont

WIDTH = 1920
HEIGHT = 1080
FPS = 30
DURATION = 18.0
TOTAL_FRAMES = int(FPS * DURATION)  # 540 frames

# Exact Brand Colors from public/css/terminal.css
BG_OBSIDIAN = (6, 8, 12)        # #06080c
BG_PANEL = (10, 14, 22)         # #0a0e16
BG_ELEVATED = (16, 22, 36)      # #101624
BG_HOVER = (22, 31, 51)         # #161f33
BG_INPUT = (5, 7, 11)           # #05070b
HEADER_SUB = (8, 11, 18)        # #080b12
THEAD_BG = (13, 19, 32)         # #0d1320

BORDER_PANEL = (17, 22, 34)     # #111622
BORDER_STRONG = (31, 41, 61)    # #1f293d

TEXT_PRI = (230, 237, 247)      # #e6edf7
TEXT_SEC = (139, 155, 180)      # #8b9bb4
TEXT_MUTED = (82, 97, 120)      # #526178

AMBER = (255, 158, 0)           # #ff9e00
AMBER_DIM = (48, 34, 14)
AMBER_BORDER = (145, 92, 10)

EMERALD = (0, 230, 118)         # #00e676
EMERALD_DIM = (8, 46, 30)
EMERALD_BAR = (10, 62, 38)

CRIMSON = (255, 59, 92)         # #ff3b5c
CRIMSON_DIM = (52, 16, 28)
CRIMSON_BAR = (68, 20, 34)

CYAN = (0, 210, 255)            # #00d2ff
CYAN_DIM = (10, 42, 56)
PURPLE = (179, 136, 255)        # #b388ff

FONT_REG_PATH = r"C:\Windows\Fonts\consola.ttf"
FONT_BOLD_PATH = r"C:\Windows\Fonts\consolab.ttf"

_FONT_CACHE = {}


def get_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    key = (size, bold)
    if key not in _FONT_CACHE:
        path = FONT_BOLD_PATH if bold else FONT_REG_PATH
        _FONT_CACHE[key] = ImageFont.truetype(path, size)
    return _FONT_CACHE[key]


def generate_base_candles(num=48):
    candles = []
    px = 94180.0
    for i in range(num):
        # Deterministic fictional BTC-USD demo price trajectory toward 94,500
        wave1 = math.sin(i * 0.34) * 55.0
        wave2 = math.cos(i * 0.71) * 32.0
        drift = 7.2 + (12.0 if i > 30 else 0.0)
        delta = drift + wave1 * 0.45 + wave2 * 0.55
        if i % 5 == 2:
            delta = -abs(delta) * 0.85
        elif i % 7 == 4:
            delta = -abs(delta) * 0.65
        else:
            delta = abs(delta) * 0.75

        open_px = px
        close_px = round((open_px + delta) * 2.0) / 2.0
        high_px = max(open_px, close_px) + round(abs(math.sin(i * 1.13)) * 48.0 + 14.0, 1)
        low_px = min(open_px, close_px) - round(abs(math.cos(i * 0.89)) * 44.0 + 12.0, 1)
        vol = round(18.0 + abs(delta) * 1.45 + (i % 4) * 9.5, 2)
        candles.append({
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "vol": vol,
        })
        px = close_px
    # Pin last candle near 94,500.00
    candles[-1]["open"] = 94462.50
    candles[-1]["low"] = 94448.00
    candles[-1]["high"] = 94524.00
    candles[-1]["close"] = 94500.00
    candles[-1]["vol"] = 84.60
    return candles


BASE_CANDLES = generate_base_candles(48)


def draw_grid_background(draw: ImageDraw.ImageDraw, t: float, step: int = 48):
    # Subtle obsidian matrix grid
    for x in range(0, WIDTH, step):
        col = (12, 17, 26) if (x % (step * 4) != 0) else (19, 27, 42)
        draw.line([(x, 0), (x, HEIGHT)], fill=col, width=1)
    for y in range(0, HEIGHT, step):
        col = (12, 17, 26) if (y % (step * 4) != 0) else (19, 27, 42)
        draw.line([(0, y), (WIDTH, y)], fill=col, width=1)

    # Corner framing brackets
    m = 36
    blen = 28
    bcol = AMBER_BORDER
    # Top-left
    draw.line([(m, m), (m + blen, m)], fill=bcol, width=2)
    draw.line([(m, m), (m, m + blen)], fill=bcol, width=2)
    # Top-right
    draw.line([(WIDTH - m - blen, m), (WIDTH - m, m)], fill=bcol, width=2)
    draw.line([(WIDTH - m, m), (WIDTH - m, m + blen)], fill=bcol, width=2)
    # Bottom-left
    draw.line([(m, HEIGHT - m), (m + blen, HEIGHT - m)], fill=bcol, width=2)
    draw.line([(m, HEIGHT - m - blen), (m, HEIGHT - m)], fill=bcol, width=2)
    # Bottom-right
    draw.line([(WIDTH - m - blen, HEIGHT - m), (WIDTH - m, HEIGHT - m)], fill=bcol, width=2)
    draw.line([(WIDTH - m, HEIGHT - m - blen), (WIDTH - m, HEIGHT - m)], fill=bcol, width=2)


def draw_top_bloomberg_header(draw: ImageDraw.ImageDraw, t: float, cmd_text: str = "BTC-USD <GO>", nav_val: str = "$10,042,850.00", upnl_val: str = "+$42,850.00"):
    # Top row (0..42)
    draw.rectangle([0, 0, WIDTH, 42], fill=BG_OBSIDIAN, outline=BORDER_PANEL)
    # Brand cluster
    draw.rectangle([12, 8, 38, 34], fill=AMBER)
    draw.text((19, 10), "A", font=get_font(18, True), fill=(0, 0, 0))
    draw.text((48, 12), "ARGUS", font=get_font(18, True), fill=TEXT_PRI)
    draw.text((100, 13), "//TERMINAL", font=get_font(15, True), fill=AMBER)

    # WS Telemetry pill
    draw.rectangle([216, 8, 398, 34], fill=BG_PANEL, outline=BORDER_STRONG)
    pulse_on = (int(t * 4) % 2 == 0)
    dot_col = EMERALD if pulse_on else (0, 175, 90)
    draw.ellipse([226, 16, 236, 26], fill=dot_col)
    draw.text((244, 13), "WS: LIVE", font=get_font(13, True), fill=TEXT_SEC)
    ticks_count = 420 + int(t * 18)
    draw.text((316, 13), f"{ticks_count} TICKS", font=get_font(13, True), fill=CYAN)

    # Iconic Amber <GO> Command Bar (412..1170)
    draw.rectangle([412, 6, 1170, 36], fill=BG_INPUT, outline=AMBER, width=1)
    draw.rectangle([413, 7, 474, 35], fill=AMBER_DIM)
    draw.text((422, 12), "CMD>", font=get_font(14, True), fill=AMBER)
    draw.text((486, 11), cmd_text, font=get_font(15, True), fill=AMBER)

    # Quick chips
    chips = ["BTC", "ETH", "NVDA", "XAU", "SQL", "DEPTH"]
    cx = 790
    for ch in chips:
        w = len(ch) * 9 + 14
        draw.rectangle([cx, 10, cx + w, 32], fill=BG_ELEVATED, outline=BORDER_STRONG)
        draw.text((cx + 7, 14), ch, font=get_font(12, True), fill=TEXT_SEC)
        cx += w + 5

    # <GO> button + ⌘K MENU
    draw.rectangle([1038, 7, 1096, 35], fill=EMERALD)
    draw.text((1049, 12), "<GO>", font=get_font(14, True), fill=(2, 16, 8))
    draw.rectangle([1097, 7, 1169, 35], fill=BG_ELEVATED, outline=BORDER_STRONG)
    draw.text((1106, 12), "^K MENU", font=get_font(13, True), fill=AMBER)

    # Desk + Portfolio Strip (1182..1908)
    draw.rectangle([1182, 7, 1410, 35], fill=BG_PANEL, outline=BORDER_STRONG)
    draw.text((1190, 13), "DESK:", font=get_font(12, True), fill=TEXT_MUTED)
    draw.text((1232, 12), "ACC-INST-01 (ALPHA)", font=get_font(13, True), fill=CYAN)

    draw.rectangle([1418, 7, 1796, 35], fill=BG_PANEL, outline=BORDER_STRONG)
    draw.text((1428, 12), "NAV:", font=get_font(12, True), fill=TEXT_MUTED)
    draw.text((1462, 12), nav_val, font=get_font(13, True), fill=TEXT_PRI)
    draw.text((1586, 12), "UPNL:", font=get_font(12, True), fill=TEXT_MUTED)
    draw.text((1630, 12), upnl_val, font=get_font(13, True), fill=EMERALD)

    draw.rectangle([1804, 7, 1908, 35], fill=BG_PANEL, outline=BORDER_STRONG)
    sec_num = int(t) % 60
    draw.text((1812, 12), f"UTC 14:53:{sec_num:02d}", font=get_font(12, True), fill=AMBER)

    # Function Key Bar (42..70)
    draw.rectangle([0, 42, WIDTH, 70], fill=HEADER_SUB, outline=BORDER_STRONG)
    fkeys = [
        ("F1", "HELP/DOCS"),
        ("F2", "CHART/DEPTH"),
        ("F3", "ORDER TICKET"),
        ("F4", "SQL CONSOLE"),
        ("F5", "NEWS WIRE"),
        ("F6", "LAYOUT TILE"),
        ("F7", "WEBHOOK PING"),
    ]
    fx = 12
    for fk, lbl in fkeys:
        fw = len(fk + lbl) * 8 + 22
        draw.rectangle([fx, 46, fx + fw, 66], fill=BG_ELEVATED, outline=BORDER_PANEL)
        draw.text((fx + 6, 49), fk, font=get_font(12, True), fill=AMBER)
        draw.text((fx + 28, 49), lbl, font=get_font(12, False), fill=TEXT_SEC)
        fx += fw + 6

    draw.text((1160, 49), "LIVE WIRE //", font=get_font(12, True), fill=AMBER)
    draw.text(
        (1258, 49),
        "SIMULATED MARKET FEED — FIFO PRICE-TIME PRIORITY MATCHING ACTIVE",
        font=get_font(12, False),
        fill=TEXT_SEC,
    )


def render_scene_1_hook(img: Image.Image, draw: ImageDraw.ImageDraw, t: float):
    draw_grid_background(draw, t, step=48)

    # Beat pulse glow bar at top & bottom
    beat_phase = (t % 0.5) / 0.5
    pulse_h = int(4 + (1.0 - beat_phase) * 4)
    draw.rectangle([0, 0, WIDTH, pulse_h], fill=AMBER)
    draw.rectangle([0, HEIGHT - pulse_h, WIDTH, HEIGHT], fill=AMBER)

    # Top Telemetry Pill
    kicker_w, kicker_h = 660, 46
    kx = (WIDTH - kicker_w) // 2
    ky = 150
    draw.rectangle([kx, ky, kx + kicker_w, ky + kicker_h], fill=AMBER_DIM, outline=AMBER, width=2)
    draw.rectangle([kx + 12, ky + 10, kx + 38, ky + 36], fill=AMBER)
    draw.text((kx + 19, ky + 12), "A", font=get_font(18, True), fill=(0, 0, 0))
    draw.text(
        (kx + 52, ky + 13),
        "ARGUS TERMINAL // LOCAL MARKET SIMULATION",
        font=get_font(18, True),
        fill=AMBER,
    )

    if t < 1.5:
        # PART 1A (0.0s - 1.5s): "A BLOOMBERG-STYLE TERMINAL, BUILT AS A LOCAL SIMULATION."
        draw.text(
            (WIDTH // 2, 340),
            "A BLOOMBERG-STYLE TERMINAL,",
            font=get_font(76, True),
            fill=TEXT_PRI,
            anchor="mm",
        )

        # Highlighted Amber Box
        draw.rectangle([360, 420, 1560, 548], fill=AMBER_DIM, outline=AMBER, width=3)
        draw.text(
            (WIDTH // 2, 484),
            "BUILT AS A LOCAL SIMULATION.",
            font=get_font(68, True),
            fill=AMBER,
            anchor="mm",
        )

        draw.text(
            (WIDTH // 2, 635),
            "NODE.JS + SQLITE. ONE PROCESS. SIMULATED DATA.",
            font=get_font(30, True),
            fill=TEXT_SEC,
            anchor="mm",
        )

        # Bottom status strip (honest scope disclaimer)
        draw.rectangle([480, 740, 1440, 796], fill=BG_ELEVATED, outline=BORDER_STRONG, width=2)
        draw.text(
            (WIDTH // 2, 768),
            "EDUCATIONAL PROJECT   |   NO REAL MARKET DATA   |   NOT AFFILIATED WITH BLOOMBERG",
            font=get_font(17, True),
            fill=TEXT_MUTED,
            anchor="mm",
        )
    else:
        # PART 1B (1.5s - 3.5s): Hard cut on Beat 3 -> "ARGUS RUNS LOCALLY." + <GO> Command Bar
        cut_age = t - 1.5
        if cut_age < 0.08:
            # Subtle white/amber flash border on the beat cut
            draw.rectangle([16, 16, WIDTH - 16, HEIGHT - 16], outline=AMBER, width=6)

        draw.text(
            (WIDTH // 2, 305),
            "ARGUS RUNS",
            font=get_font(84, True),
            fill=TEXT_PRI,
            anchor="mm",
        )

        # Glowing Emerald "LOCALLY." box
        draw.rectangle([580, 378, 1340, 498], fill=EMERALD_DIM, outline=EMERALD, width=3)
        draw.text(
            (WIDTH // 2, 438),
            "LOCALLY.",
            font=get_font(88, True),
            fill=EMERALD,
            anchor="mm",
        )

        draw.text(
            (WIDTH // 2, 555),
            "NO BUILD STEP  •  FIFO MATCHING ENGINE  •  NODE:SQLITE (WAL)  •  CANVAS 2D CHARTS",
            font=get_font(21, True),
            fill=CYAN,
            anchor="mm",
        )

        # Iconic Bloomberg Amber <GO> Command Bar Typing "BTC-USD <GO>"
        bar_w, bar_h = 1140, 88
        bx = (WIDTH - bar_w) // 2
        by = 635
        go_active = t >= 3.08
        border_col = EMERALD if go_active else AMBER
        draw.rectangle([bx - 4, by - 4, bx + bar_w + 4, by + bar_h + 4], outline=AMBER_DIM, width=4)
        draw.rectangle([bx, by, bx + bar_w, by + bar_h], fill=BG_INPUT, outline=border_col, width=3)

        # CMD> Prefix
        draw.rectangle([bx + 3, by + 3, bx + 150, by + bar_h - 3], fill=AMBER_DIM)
        draw.line([(bx + 150, by), (bx + 150, by + bar_h)], fill=AMBER, width=2)
        draw.text((bx + 76, by + bar_h // 2), "CMD>", font=get_font(34, True), fill=AMBER, anchor="mm")

        # Typed command text
        full_cmd = "BTC-USD <GO>"
        if t < 1.82:
            typed = ""
        else:
            n_chars = min(len(full_cmd), int((t - 1.82) / 0.095) + 1)
            typed = full_cmd[:n_chars]

        cursor_char = "█" if (int(t * 8) % 2 == 0 and not go_active) else ""
        draw.text(
            (bx + 180, by + bar_h // 2),
            f"{typed}{cursor_char}",
            font=get_font(38, True),
            fill=EMERALD if go_active else AMBER,
            anchor="lm",
        )

        # Quick Chips + <GO> Button inside command bar
        draw.rectangle([bx + bar_w - 210, by + 12, bx + bar_w - 14, by + bar_h - 12], fill=EMERALD)
        draw.text(
            (bx + bar_w - 112, by + bar_h // 2),
            "EXEC <GO>" if go_active else "<GO>",
            font=get_font(28, True),
            fill=(2, 16, 8),
            anchor="mm",
        )

        # Bottom status readout
        status_str = (
            "STATUS: SUBSCRIBING WS://LOCALHOST:3400/WS // HYDRATING L2 ORDERBOOK..."
            if go_active
            else "TYPE TICKER OR FUNCTION AND PRESS <GO> TO INITIALIZE WORKSPACE"
        )
        draw.text(
            (WIDTH // 2, 785),
            status_str,
            font=get_font(19, True),
            fill=EMERALD if go_active else TEXT_SEC,
            anchor="mm",
        )


def draw_pane_header(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, idx_str: str, title: str, right_badge: str = "", right_col=AMBER):
    draw.rectangle([x0, y0, x1, y0 + 30], fill=BG_ELEVATED, outline=BORDER_STRONG)
    draw.rectangle([x0 + 8, y0 + 5, x0 + 34, y0 + 25], fill=AMBER_DIM, outline=AMBER)
    draw.text((x0 + 21, y0 + 15), idx_str, font=get_font(12, True), fill=AMBER, anchor="mm")
    draw.text((x0 + 44, y0 + 15), title, font=get_font(13, True), fill=TEXT_PRI, anchor="lm")
    if right_badge:
        draw.text((x1 - 10, y0 + 15), right_badge, font=get_font(12, True), fill=right_col, anchor="rm")


def render_scene_2_terminal(img: Image.Image, draw: ImageDraw.ImageDraw, t: float, is_poster: bool = False):
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=BG_OBSIDIAN)
    draw_top_bloomberg_header(draw, t)

    # 5-Pane Workspace Grid Coordinates (y: 70..1080)
    # Left Col: 0..370 | Center Col: 371..1470 | Right Col: 1471..1920
    # Top Row: 70..680 | Bottom Row: 681..1080 (Right Col spans 70..1080)

    # --- PANE 1: LEFT WATCHLIST & CROSS-ASSET TELEMETRY (0..370, 70..680) ---
    p1_x0, p1_y0, p1_x1, p1_y1 = 0, 70, 370, 680
    draw.rectangle([p1_x0, p1_y0, p1_x1, p1_y1], fill=BG_PANEL, outline=BORDER_STRONG)
    draw_pane_header(draw, p1_x0, p1_y0, p1_x1, "P1", "MARKET WATCH // CROSS-ASSET", "ALL | 6 SYM", AMBER)

    # Table Header
    th_y = p1_y0 + 30
    draw.rectangle([p1_x0, th_y, p1_x1, th_y + 26], fill=THEAD_BG, outline=BORDER_STRONG)
    draw.text((12, th_y + 13), "INSTRUMENT", font=get_font(11, True), fill=TEXT_MUTED, anchor="lm")
    draw.text((186, th_y + 13), "LAST PX", font=get_font(11, True), fill=TEXT_MUTED, anchor="rm")
    draw.text((268, th_y + 13), "24H %", font=get_font(11, True), fill=TEXT_MUTED, anchor="rm")
    draw.text((358, th_y + 13), "VWAP", font=get_font(11, True), fill=TEXT_MUTED, anchor="rm")

    osc = math.sin(t * 3.2) * 1.5
    tickers = [
        ("BTC-USD", f"{94500.00 + osc:,.2f}", "+2.41%", "94,485.2", True, True),
        ("ETH-USD", f"{3180.00 + osc * 0.15:,.2f}", "+1.85%", "3,174.5", True, False),
        ("SOL-USD", f"{212.50 + osc * 0.04:,.2f}", "+4.12%", "210.80", True, False),
        ("NVDA-EQ", f"{148.20 + osc * 0.02:,.2f}", "+3.05%", "147.10", True, False),
        ("XAU-USD", f"{2745.00 - osc * 0.10:,.2f}", "-0.32%", "2,748.1", False, False),
        ("IDR-USD", "15,680.00", "+0.11%", "15,675", True, False),
    ]

    ry = th_y + 26
    for sym, px_s, chg_s, vwap_s, is_up, is_active in tickers:
        row_h = 38
        if is_active:
            draw.rectangle([p1_x0 + 1, ry, p1_x1 - 1, ry + row_h], fill=(32, 26, 14))
            draw.rectangle([p1_x0 + 1, ry, p1_x0 + 4, ry + row_h], fill=AMBER)
        else:
            draw.line([(p1_x0, ry + row_h), (p1_x1, ry + row_h)], fill=BORDER_PANEL)

        sym_col = AMBER if is_active else TEXT_PRI
        px_col = EMERALD if is_up else CRIMSON
        draw.text((14, ry + row_h // 2), sym, font=get_font(13, True), fill=sym_col, anchor="lm")
        draw.text((186, ry + row_h // 2), px_s, font=get_font(13, True), fill=px_col, anchor="rm")
        draw.text((268, ry + row_h // 2), chg_s, font=get_font(12, True), fill=px_col, anchor="rm")
        draw.text((358, ry + row_h // 2), vwap_s, font=get_font(12, False), fill=CYAN, anchor="rm")
        ry += row_h

    # Selected Instrument Microstructure Telemetry Card
    tc_y0 = ry + 10
    draw.rectangle([10, tc_y0, p1_x1 - 10, p1_y1 - 10], fill=BG_OBSIDIAN, outline=BORDER_STRONG)
    draw.rectangle([10, tc_y0, p1_x1 - 10, tc_y0 + 32], fill=BG_ELEVATED, outline=BORDER_STRONG)
    draw.text((20, tc_y0 + 16), "BTC-USD // CRYPTO SPOT", font=get_font(13, True), fill=AMBER, anchor="lm")
    draw.text((p1_x1 - 20, tc_y0 + 16), "SPREAD: 0.5 bps", font=get_font(12, True), fill=EMERALD, anchor="rm")

    tele_cells = [
        ("24H HIGH", "95,420.00", TEXT_PRI),
        ("24H LOW", "93,110.00", TEXT_PRI),
        ("24H VOL (BTC)", "14,820.50", TEXT_PRI),
        ("SESSION VWAP", "94,485.20", CYAN),
        ("BEST BID", f"{94499.50 + osc:,.2f}", EMERALD),
        ("BEST ASK", f"{94500.50 + osc:,.2f}", CRIMSON),
    ]
    for idx, (lbl, val, col) in enumerate(tele_cells):
        col_i = idx % 2
        row_i = idx // 2
        cx0 = 20 + col_i * 170
        cy0 = tc_y0 + 44 + row_i * 76
        draw.rectangle([cx0, cy0, cx0 + 160, cy0 + 66], fill=BG_PANEL, outline=BORDER_PANEL)
        draw.text((cx0 + 10, cy0 + 18), lbl, font=get_font(11, True), fill=TEXT_MUTED, anchor="lm")
        draw.text((cx0 + 10, cy0 + 44), val, font=get_font(16, True), fill=col, anchor="lm")

    # --- PANE 2: CENTER PRIMARY CANVAS CHART (OHLCV + EMA + L2 DEPTH) (371..1470, 70..680) ---
    p2_x0, p2_y0, p2_x1, p2_y1 = 371, 70, 1470, 680
    draw.rectangle([p2_x0, p2_y0, p2_x1, p2_y1], fill=BG_OBSIDIAN, outline=BORDER_STRONG)
    live_btc = 94500.00 + osc
    draw_pane_header(
        draw,
        p2_x0,
        p2_y0,
        p2_x1,
        "P2",
        f"BTC-USD // BITCOIN SPOT (SIMULATED)   ${live_btc:,.2f}  (+2.41%)",
        "MODE: SPLIT (CANDLES + L2 DEPTH) | EMA 9/21 | VWAP",
        CYAN,
    )

    # HUD Strip (y: 100..126)
    hud_y = p2_y0 + 30
    draw.rectangle([p2_x0, hud_y, p2_x1, hud_y + 26], fill=BG_PANEL, outline=BORDER_PANEL)
    hud_text = (
        f"T: LIVE 1m   O: 94,462.50   H: 94,524.00   L: 94,448.00   "
        f"C: {live_btc:,.2f}   V: 84.60 BTC   EMA9: 94,491.40   EMA21: 94,468.10   VWAP: 94,485.20"
    )
    draw.text((p2_x0 + 12, hud_y + 13), hud_text, font=get_font(12, True), fill=TEXT_SEC, anchor="lm")

    # Candlestick Stage (y: 126..480)
    c_x0, c_y0, c_x1, c_y1 = p2_x0 + 14, hud_y + 30, p2_x1 - 86, 480
    # Horizontal price grid lines
    min_px, max_px = 94140.0, 94560.0
    for g_idx in range(6):
        gy = int(c_y0 + g_idx * (c_y1 - c_y0) / 5)
        g_px = max_px - g_idx * (max_px - min_px) / 5
        draw.line([(c_x0, gy), (c_x1, gy)], fill=(15, 22, 34), width=1)
        draw.text((c_x1 + 8, gy), f"{g_px:,.0f}", font=get_font(11, False), fill=TEXT_MUTED, anchor="lm")

    def px_to_y(p):
        frac = (p - min_px) / (max_px - min_px)
        return int(c_y1 - frac * (c_y1 - c_y0))

    # Draw 48 Candlesticks + EMA9 + EMA21 + VWAP
    num_c = len(BASE_CANDLES)
    slot_w = (c_x1 - c_x0) / num_c
    body_w = max(6, int(slot_w * 0.64))

    ema9_pts = []
    ema21_pts = []
    vwap_pts = []
    ema9_val = BASE_CANDLES[0]["close"]
    ema21_val = BASE_CANDLES[0]["close"]

    for i, c in enumerate(BASE_CANDLES):
        cx = int(c_x0 + (i + 0.5) * slot_w)
        o_px = c["open"]
        h_px = c["high"]
        l_px = c["low"]
        cl_px = live_btc if i == num_c - 1 else c["close"]
        if i == num_c - 1:
            h_px = max(h_px, cl_px + 8.0)

        ema9_val = ema9_val * (8.0 / 10.0) + cl_px * (2.0 / 10.0)
        ema21_val = ema21_val * (20.0 / 22.0) + cl_px * (2.0 / 22.0)
        vwap_val = 94240.0 + (i / num_c) * 245.20

        ema9_pts.append((cx, px_to_y(ema9_val)))
        ema21_pts.append((cx, px_to_y(ema21_val)))
        vwap_pts.append((cx, px_to_y(vwap_val)))

        bull = cl_px >= o_px
        col = EMERALD if bull else CRIMSON

        # Wick
        draw.line([(cx, px_to_y(h_px)), (cx, px_to_y(l_px))], fill=col, width=2)
        # Body
        by0 = min(px_to_y(o_px), px_to_y(cl_px))
        by1 = max(px_to_y(o_px), px_to_y(cl_px))
        if by1 - by0 < 3:
            by1 = by0 + 3
        draw.rectangle([cx - body_w // 2, by0, cx + body_w // 2, by1], fill=col)

        # Volume bar at bottom of candle stage
        v_h = int((c["vol"] / 110.0) * 48)
        v_col = (0, 110, 62) if bull else (115, 28, 44)
        draw.rectangle([cx - body_w // 2, c_y1 - v_h, cx + body_w // 2, c_y1], fill=v_col)

    # Overlays: VWAP (Cyan), EMA21 (Purple), EMA9 (Amber)
    if len(vwap_pts) > 1:
        draw.line(vwap_pts, fill=CYAN, width=2)
        draw.line(ema21_pts, fill=PURPLE, width=2)
        draw.line(ema9_pts, fill=AMBER, width=2)

    # Current Price Laser Line + Right Axis Pill
    cur_y = px_to_y(live_btc)
    draw.line([(c_x0, cur_y), (c_x1, cur_y)], fill=EMERALD, width=1)
    draw.rectangle([c_x1 + 2, cur_y - 11, p2_x1 - 4, cur_y + 11], fill=EMERALD)
    draw.text((c_x1 + 6, cur_y), f"{live_btc:,.1f}", font=get_font(11, True), fill=(0, 0, 0), anchor="lm")

    # Bottom Sub-Stage of P2: L2 Cumulative Market Depth Wall (y: 486..674)
    d_y0, d_y1 = 488, 672
    draw.rectangle([p2_x0 + 2, d_y0, p2_x1 - 2, d_y1], fill=(7, 10, 16), outline=BORDER_PANEL)
    draw.text(
        (p2_x0 + 16, d_y0 + 16),
        "L2 CUMULATIVE LIQUIDITY DEPTH WALL // BID (EMERALD) VS ASK (CRIMSON)",
        font=get_font(12, True),
        fill=AMBER,
        anchor="lm",
    )

    mid_x = (c_x0 + c_x1) // 2
    # Bid staircase polygon (left of mid_x)
    bid_poly = [(mid_x - 4, d_y1 - 4)]
    ask_poly = [(mid_x + 4, d_y1 - 4)]
    bid_line = []
    ask_line = []
    steps = 16
    for s in range(steps):
        frac = s / (steps - 1)
        bx = int(mid_x - 4 - frac * (mid_x - c_x0 - 16))
        ax = int(mid_x + 4 + frac * (c_x1 - mid_x - 16))
        depth_b = (frac ** 0.72) * 135.0 + math.sin(s + t * 2.0) * 4.0
        depth_a = (frac ** 0.75) * 128.0 + math.cos(s + t * 2.0) * 4.0
        by = int(d_y1 - 8 - depth_b)
        ay = int(d_y1 - 8 - depth_a)
        bid_line.append((bx, by))
        ask_line.append((ax, ay))
        bid_poly.append((bx, by))
        ask_poly.append((ax, ay))
    bid_poly.append((bid_line[-1][0], d_y1 - 4))
    ask_poly.append((ask_line[-1][0], d_y1 - 4))

    draw.polygon(bid_poly, fill=(6, 54, 34))
    draw.polygon(ask_poly, fill=(62, 16, 28))
    draw.line(bid_line, fill=EMERALD, width=3)
    draw.line(ask_line, fill=CRIMSON, width=3)
    draw.line([(mid_x, d_y0 + 8), (mid_x, d_y1 - 4)], fill=AMBER, width=2)
    draw.text((mid_x, d_y0 + 40), "MID $94,500.00", font=get_font(12, True), fill=AMBER, anchor="mm")

    # --- PANE 3: RIGHT L2 ORDERBOOK & TIME/SALES TAPE (1471..1920, 70..1080) ---
    p3_x0, p3_y0, p3_x1, p3_y1 = 1471, 70, 1920, 1080
    draw.rectangle([p3_x0, p3_y0, p3_x1, p3_y1], fill=BG_PANEL, outline=BORDER_STRONG)
    draw_pane_header(draw, p3_x0, p3_y0, p3_x1, "P3", "L2 BOOK & TIME/SALES", "B: 58% | A: 42%", EMERALD)

    ob_y = p3_y0 + 30
    draw.rectangle([p3_x0, ob_y, p3_x1, ob_y + 24], fill=THEAD_BG, outline=BORDER_STRONG)
    draw.text((p3_x0 + 12, ob_y + 12), "PRICE (USD)", font=get_font(11, True), fill=TEXT_MUTED, anchor="lm")
    draw.text((p3_x0 + 275, ob_y + 12), "SIZE (BTC)", font=get_font(11, True), fill=TEXT_MUTED, anchor="rm")
    draw.text((p3_x1 - 12, ob_y + 12), "TOTAL", font=get_font(11, True), fill=TEXT_MUTED, anchor="rm")

    # 8 Ask Rows (94,504.00 down to 94,500.50)
    ry = ob_y + 26
    ask_tot = 24.80
    for i in range(8):
        px = 94500.50 + (7 - i) * 0.50
        sz = 1.40 + ((i * 3) % 5) * 0.65 + (0.2 if (int(t * 5 + i) % 2 == 0) else 0.0)
        bar_w = int(min(1.0, ask_tot / 28.0) * (p3_x1 - p3_x0 - 16))
        draw.rectangle([p3_x1 - 6 - bar_w, ry + 2, p3_x1 - 6, ry + 25], fill=CRIMSON_BAR)
        draw.text((p3_x0 + 14, ry + 13), f"{px:,.2f}", font=get_font(13, True), fill=CRIMSON, anchor="lm")
        draw.text((p3_x0 + 275, ry + 13), f"{sz:0.4f}", font=get_font(12, False), fill=TEXT_PRI, anchor="rm")
        draw.text((p3_x1 - 12, ry + 13), f"{ask_tot:0.2f}", font=get_font(12, False), fill=TEXT_SEC, anchor="rm")
        ask_tot -= sz * 0.8
        ry += 27

    # Mid-Price & Spread Banner
    draw.rectangle([p3_x0 + 4, ry + 2, p3_x1 - 4, ry + 36], fill=AMBER_DIM, outline=AMBER)
    draw.text((p3_x0 + 14, ry + 19), f"MID: {live_btc:,.2f}", font=get_font(14, True), fill=AMBER, anchor="lm")
    draw.text((p3_x1 - 14, ry + 19), "SPREAD: $0.50 (0.5 bps)", font=get_font(12, True), fill=EMERALD, anchor="rm")
    ry += 40

    # 8 Bid Rows (94,499.50 down to 94,496.00)
    bid_tot = 2.65
    for i in range(8):
        px = 94499.50 - i * 0.50
        sz = 1.85 + ((i * 2) % 5) * 0.75 + (0.3 if (int(t * 5 + i) % 2 == 1) else 0.0)
        bid_tot += sz
        bar_w = int(min(1.0, bid_tot / 28.0) * (p3_x1 - p3_x0 - 16))
        draw.rectangle([p3_x1 - 6 - bar_w, ry + 2, p3_x1 - 6, ry + 25], fill=EMERALD_BAR)
        draw.text((p3_x0 + 14, ry + 13), f"{px:,.2f}", font=get_font(13, True), fill=EMERALD, anchor="lm")
        draw.text((p3_x0 + 275, ry + 13), f"{sz:0.4f}", font=get_font(12, False), fill=TEXT_PRI, anchor="rm")
        draw.text((p3_x1 - 12, ry + 13), f"{bid_tot:0.2f}", font=get_font(12, False), fill=TEXT_SEC, anchor="rm")
        ry += 27

    # Time & Sales Execution Tape (ry..1080)
    draw.rectangle([p3_x0, ry + 4, p3_x1, ry + 32], fill=BG_ELEVATED, outline=BORDER_STRONG)
    draw.text((p3_x0 + 12, ry + 18), "TIME & SALES EXECUTION TAPE", font=get_font(12, True), fill=AMBER, anchor="lm")
    draw.text((p3_x1 - 12, ry + 18), "SIM PRINTS", font=get_font(11, True), fill=CYAN, anchor="rm")
    ry += 34

    tape_offset = int(t * 6)
    for row_i in range(14):
        tid = tape_offset + row_i
        is_buy = (tid % 3 != 0)
        t_col = EMERALD if is_buy else CRIMSON
        side_s = "BUY " if is_buy else "SELL"
        px_t = 94500.50 if is_buy else 94499.50
        sz_t = 0.4200 + ((tid * 7) % 19) * 0.1800
        ms = (912 - row_i * 63) % 1000
        sec = (53 - (row_i // 4)) % 60
        draw.text((p3_x0 + 12, ry + 12), f"14:53:{sec:02d}.{ms:03d}", font=get_font(12, False), fill=TEXT_SEC, anchor="lm")
        draw.text((p3_x0 + 150, ry + 12), side_s, font=get_font(12, True), fill=t_col, anchor="lm")
        draw.text((p3_x0 + 310, ry + 12), f"{px_t:,.2f}", font=get_font(12, True), fill=t_col, anchor="rm")
        draw.text((p3_x1 - 12, ry + 12), f"{sz_t:0.4f}", font=get_font(12, False), fill=TEXT_PRI, anchor="rm")
        ry += 24
        if ry > p3_y1 - 18:
            break

    # --- PANE 4: BOTTOM LEFT ORDER ENTRY TICKET (0..370, 681..1080) ---
    p4_x0, p4_y0, p4_x1, p4_y1 = 0, 681, 370, 1080
    draw.rectangle([p4_x0, p4_y0, p4_x1, p4_y1], fill=BG_PANEL, outline=BORDER_STRONG)
    draw_pane_header(draw, p4_x0, p4_y0, p4_x1, "P4", "ORDER ENTRY // DMA ROUTER", "BTC-USD", AMBER)

    # BUY / SELL Toggle
    draw.rectangle([12, p4_y0 + 40, 182, p4_y0 + 74], fill=EMERALD_DIM, outline=EMERALD, width=2)
    draw.text((97, p4_y0 + 57), "BUY // BID", font=get_font(13, True), fill=EMERALD, anchor="mm")
    draw.rectangle([188, p4_y0 + 40, 358, p4_y0 + 74], fill=BG_OBSIDIAN, outline=BORDER_STRONG)
    draw.text((273, p4_y0 + 57), "SELL // ASK", font=get_font(13, True), fill=TEXT_MUTED, anchor="mm")

    # LIMIT / MARKET Tabs
    draw.rectangle([12, p4_y0 + 82, 182, p4_y0 + 110], fill=AMBER_DIM, outline=AMBER)
    draw.text((97, p4_y0 + 96), "LIMIT (FIFO)", font=get_font(12, True), fill=AMBER, anchor="mm")
    draw.rectangle([188, p4_y0 + 82, 358, p4_y0 + 110], fill=BG_OBSIDIAN, outline=BORDER_STRONG)
    draw.text((273, p4_y0 + 96), "MARKET (SWEEP)", font=get_font(12, True), fill=TEXT_SEC, anchor="mm")

    # Inputs
    draw.text((14, p4_y0 + 128), "LIMIT PRICE (USD)", font=get_font(11, True), fill=TEXT_MUTED, anchor="lm")
    draw.rectangle([12, p4_y0 + 140, 358, p4_y0 + 174], fill=BG_INPUT, outline=BORDER_STRONG)
    draw.text((22, p4_y0 + 157), "94,500.00", font=get_font(15, True), fill=TEXT_PRI, anchor="lm")

    draw.text((14, p4_y0 + 192), "QUANTITY (BTC)  |  TAG: ALPHA-DMA-01", font=get_font(11, True), fill=TEXT_MUTED, anchor="lm")
    draw.rectangle([12, p4_y0 + 204, 358, p4_y0 + 238], fill=BG_INPUT, outline=BORDER_STRONG)
    draw.text((22, p4_y0 + 221), "2.5000 BTC   (NOTIONAL: $236,250.00)", font=get_font(13, True), fill=CYAN, anchor="lm")

    # Submit Button
    draw.rectangle([12, p4_y0 + 254, 358, p4_y0 + 300], fill=EMERALD)
    draw.text((185, p4_y0 + 277), "TRANSMIT BUY LIMIT <GO>", font=get_font(15, True), fill=(2, 16, 8), anchor="mm")

    # --- PANE 5: BOTTOM CENTER BLOTTER (371..1470, 681..1080) ---
    p5_x0, p5_y0, p5_x1, p5_y1 = 371, 681, 1470, 1080
    draw.rectangle([p5_x0, p5_y0, p5_x1, p5_y1], fill=BG_PANEL, outline=BORDER_STRONG)
    draw_pane_header(
        draw,
        p5_x0,
        p5_y0,
        p5_x1,
        "P5",
        "BLOTTER // POSITIONS & MTM PNL  |  ORDERS  |  SQLITE WAL  |  NEWS WIRE",
        "EXPOSURE: $1,648,410.00",
        CYAN,
    )

    b_th_y = p5_y0 + 30
    draw.rectangle([p5_x0, b_th_y, p5_x1, b_th_y + 26], fill=THEAD_BG, outline=BORDER_STRONG)
    cols = [
        (p5_x0 + 16, "SYMBOL", "lm"),
        (p5_x0 + 140, "SIDE", "lm"),
        (p5_x0 + 270, "QTY", "rm"),
        (p5_x0 + 430, "AVG ENTRY", "rm"),
        (p5_x0 + 590, "MARK PX", "rm"),
        (p5_x0 + 770, "NOTIONAL", "rm"),
        (p5_x0 + 950, "UNREALIZED PNL", "rm"),
        (p5_x1 - 20, "ROE %", "rm"),
    ]
    for cx, lbl, anc in cols:
        draw.text((cx, b_th_y + 13), lbl, font=get_font(11, True), fill=TEXT_MUTED, anchor=anc)

    positions = [
        ("BTC-USD", "LONG", "12.5000", "$91,820.00", f"${live_btc:,.2f}", "$1,181,250.00", "+$33,500.00", "+2.92%", True),
        ("ETH-USD", "LONG", "85.0000", "$3,070.00", "$3,180.00", "$270,300.00", "+$9,350.00", "+3.58%", True),
        ("NVDA-EQ", "LONG", "600.00", "$142.50", "$148.20", "$88,920.00", "+$3,420.00", "+4.00%", True),
        ("XAU-USD", "SHORT", "40.00", "$2,762.00", "$2,745.00", "$109,800.00", "+$680.00", "+0.62%", True),
    ]
    pry = b_th_y + 28
    for sym, side, qty, entry, mark, notl, upnl, roe, is_pos in positions:
        draw.line([(p5_x0, pry + 36), (p5_x1, pry + 36)], fill=BORDER_PANEL)
        s_col = EMERALD if side == "LONG" else CRIMSON
        p_col = EMERALD if is_pos else CRIMSON
        draw.text((p5_x0 + 16, pry + 18), sym, font=get_font(13, True), fill=AMBER, anchor="lm")
        draw.text((p5_x0 + 140, pry + 18), side, font=get_font(12, True), fill=s_col, anchor="lm")
        draw.text((p5_x0 + 270, pry + 18), qty, font=get_font(13, False), fill=TEXT_PRI, anchor="rm")
        draw.text((p5_x0 + 430, pry + 18), entry, font=get_font(13, False), fill=TEXT_SEC, anchor="rm")
        draw.text((p5_x0 + 590, pry + 18), mark, font=get_font(13, True), fill=TEXT_PRI, anchor="rm")
        draw.text((p5_x0 + 770, pry + 18), notl, font=get_font(13, False), fill=TEXT_PRI, anchor="rm")
        draw.text((p5_x0 + 950, pry + 18), upnl, font=get_font(13, True), fill=p_col, anchor="rm")
        draw.text((p5_x1 - 20, pry + 18), roe, font=get_font(13, True), fill=p_col, anchor="rm")
        pry += 38

    # Bottom Live Telemetry Footer inside P5
    draw.rectangle([p5_x0 + 12, p5_y1 - 54, p5_x1 - 12, p5_y1 - 12], fill=BG_OBSIDIAN, outline=AMBER)
    draw.text(
        (p5_x0 + 26, p5_y1 - 33),
        "CANVAS 2D CHARTS  •  WEBSOCKET PUSH UPDATES  •  ONE RUNTIME DEPENDENCY (ws)  •  SIMULATED DATA",
        font=get_font(14, True),
        fill=AMBER,
        anchor="lm",
    )

    if is_poster:
        # Poster Frame Callout Badge at Top-Center of Chart for unmistakable thumbnail clarity
        draw.rectangle([490, 140, 1350, 204], fill=(6, 8, 12), outline=AMBER, width=3)
        draw.rectangle([504, 152, 536, 192], fill=AMBER)
        draw.text((520, 172), "A", font=get_font(22, True), fill=(0, 0, 0), anchor="mm")
        draw.text(
            (552, 172),
            "ARGUS TERMINAL // LOCAL MARKET-TERMINAL SIMULATION",
            font=get_font(23, True),
            fill=TEXT_PRI,
            anchor="lm",
        )


def render_scene_3_engine_security(img: Image.Image, draw: ImageDraw.ImageDraw, t: float):
    # Scene 3 (8.5s - 13.5s): Price-Time Priority Matching Engine, read-only SQLite console & 5 fixed seeded vulnerabilities
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=BG_OBSIDIAN)
    filled = t >= 10.0
    cmd_str = "BUY 2.50 BTC-USD @ MARKET <GO>"
    nav_s = "$10,279,101.25" if filled else "$10,042,850.00"
    upnl_s = "+$46,420.00" if filled else "+$42,850.00"
    draw_top_bloomberg_header(draw, t, cmd_text=cmd_str, nav_val=nav_s, upnl_val=upnl_s)

    # Scene 3 Hero Header Strip (y: 78..146)
    draw.rectangle([24, 82, WIDTH - 24, 146], fill=BG_ELEVATED, outline=AMBER, width=2)
    draw.text(
        (48, 114),
        "FIFO MATCHING ENGINE  +  IN-PROCESS NODE:SQLITE (WAL)  +  SEEDED-VULNERABILITY FIXES",
        font=get_font(22, True),
        fill=AMBER,
        anchor="lm",
    )
    draw.rectangle([WIDTH - 360, 94, WIDTH - 44, 134], fill=EMERALD_DIM, outline=EMERALD, width=2)
    draw.text(
        (WIDTH - 202, 114),
        "5 SUITES • 51 CHECKS PASSING",
        font=get_font(16, True),
        fill=EMERALD,
        anchor="mm",
    )

    # --- LEFT HERO PANEL: P4 DMA ORDER ROUTER & EXECUTION FILL (x: 24..720, y: 162..1056) ---
    lx0, ly0, lx1, ly1 = 24, 162, 720, 1056
    draw.rectangle([lx0, ly0, lx1, ly1], fill=BG_PANEL, outline=BORDER_STRONG, width=2)
    draw_pane_header(draw, lx0, ly0, lx1, "P4", "DMA ORDER ROUTER // PRICE-TIME PRIORITY (FIFO)", "ACC-INST-01", CYAN)

    # Order Side & Type Selection
    draw.rectangle([lx0 + 24, ly0 + 50, lx0 + 336, ly0 + 104], fill=EMERALD_DIM, outline=EMERALD, width=2)
    draw.text((lx0 + 180, ly0 + 77), "BUY // BID SWEEP", font=get_font(20, True), fill=EMERALD, anchor="mm")
    draw.rectangle([lx0 + 354, ly0 + 50, lx1 - 24, ly0 + 104], fill=AMBER_DIM, outline=AMBER, width=2)
    draw.text((lx0 + 513, ly0 + 77), "MARKET (FIFO SWEEP)", font=get_font(20, True), fill=AMBER, anchor="mm")

    # Ticket Fields
    fields = [
        ("INSTRUMENT // ROUTE", "BTC-USD (BITCOIN SPOT // SIMULATED L2 BOOK)", TEXT_PRI),
        ("ORDER QUANTITY (BTC)", "2.5000 BTC   [QUICK ALLOC: 25% | 50% | MAX]", EMERALD),
        ("EXECUTION PRICE", "MARKET SWEEP -> BEST ASK $94,500.50 (0.5 bps SPREAD)", AMBER),
        ("ESTIMATED NOTIONAL", "$236,251.25 USD   (FREE CASH: $8,500,000.00)", CYAN),
        ("CLIENT / ALGO TAG", "ALPHA-DMA-01   (5x BUYING-POWER CHECK: PASSED)", TEXT_SEC),
    ]
    fy = ly0 + 126
    for lbl, val, col in fields:
        draw.text((lx0 + 28, fy), lbl, font=get_font(14, True), fill=TEXT_MUTED, anchor="lm")
        draw.rectangle([lx0 + 24, fy + 16, lx1 - 24, fy + 68], fill=BG_INPUT, outline=BORDER_STRONG, width=2)
        draw.text((lx0 + 40, fy + 42), val, font=get_font(17, True), fill=col, anchor="lm")
        fy += 88

    # Transmit Button
    btn_y0 = fy + 10
    if filled:
        draw.rectangle([lx0 + 24, btn_y0, lx1 - 24, btn_y0 + 74], fill=EMERALD, outline=TEXT_PRI, width=3)
        draw.text(
            ((lx0 + lx1) // 2, btn_y0 + 37),
            "ORDER FILLED // BUY 2.50 BTC @ $94,500.50",
            font=get_font(19, True),
            fill=(2, 16, 8),
            anchor="mm",
        )
    else:
        draw.rectangle([lx0 + 24, btn_y0, lx1 - 24, btn_y0 + 74], fill=AMBER, outline=TEXT_PRI, width=2)
        draw.text(
            ((lx0 + lx1) // 2, btn_y0 + 37),
            "TRANSMIT BUY 2.50 BTC-USD @ MARKET <GO>",
            font=get_font(20, True),
            fill=(0, 0, 0),
            anchor="mm",
        )

    # Instant Fill Audit Toast Card inside Left Panel
    toast_y0 = btn_y0 + 94
    if filled:
        draw.rectangle([lx0 + 24, toast_y0, lx1 - 24, ly1 - 24], fill=EMERALD_DIM, outline=EMERALD, width=3)
        draw.text(
            (lx0 + 44, toast_y0 + 32),
            "FIFO MATCHING ENGINE FILL CONFIRMED (SIMULATED)",
            font=get_font(18, True),
            fill=EMERALD,
            anchor="lm",
        )
        draw.text(
            (lx0 + 44, toast_y0 + 68),
            "ORDER ID: ORD-904281   |   FILL PX: $94,500.50   |   QTY: 2.5000 BTC",
            font=get_font(15, True),
            fill=TEXT_PRI,
            anchor="lm",
        )
        draw.text(
            (lx0 + 44, toast_y0 + 100),
            "SQLITE TRANSACTION COMMITTED: orders + trades + positions + accounts",
            font=get_font(15, False),
            fill=CYAN,
            anchor="lm",
        )
        draw.text(
            (lx0 + 44, toast_y0 + 132),
            "WEBSOCKET BROADCAST: TRADE + ORDERBOOK + PORTFOLIO_UPDATE SENT",
            font=get_font(14, False),
            fill=AMBER,
            anchor="lm",
        )
    else:
        draw.rectangle([lx0 + 24, toast_y0, lx1 - 24, ly1 - 24], fill=BG_OBSIDIAN, outline=BORDER_STRONG, width=2)
        draw.text(
            (lx0 + 44, toast_y0 + 46),
            "PRE-TRADE FIFO ENGINE READY // WAITING FOR <GO>...",
            font=get_font(17, True),
            fill=AMBER,
            anchor="lm",
        )
        draw.text(
            (lx0 + 44, toast_y0 + 88),
            "L2 ASK LIQUIDITY AVAILABLE AT $94,500.50: 4.8500 BTC (SIMULATED BOOK)",
            font=get_font(15, False),
            fill=TEXT_SEC,
            anchor="lm",
        )

    # --- TOP-RIGHT PANEL: P5 IN-PROCESS READ-ONLY SQLITE CONSOLE (x: 740..1896, y: 162..586) ---
    rx0, ry0, rx1, ry1 = 740, 162, 1896, 586
    draw.rectangle([rx0, ry0, rx1, ry1], fill=BG_PANEL, outline=BORDER_STRONG, width=2)
    draw_pane_header(
        draw,
        rx0,
        ry0,
        rx1,
        "P5",
        "READ-ONLY SQL CONSOLE // IN-PROCESS NODE:SQLITE (WAL MODE)",
        "6 ROWS // SELECT-ONLY GUARD",
        EMERALD,
    )

    # SQL Query Box
    draw.rectangle([rx0 + 20, ry0 + 44, rx1 - 20, ry0 + 114], fill=BG_INPUT, outline=AMBER, width=2)
    draw.text(
        (rx0 + 36, ry0 + 66),
        "SQL> SELECT symbol, count(*) AS trades, round(sum(size * price), 2) AS notional,",
        font=get_font(16, True),
        fill=AMBER,
        anchor="lm",
    )
    draw.text(
        (rx0 + 36, ry0 + 92),
        "            round(avg(price), 2) AS avg_px FROM trades GROUP BY symbol ORDER BY notional DESC;",
        font=get_font(16, True),
        fill=AMBER,
        anchor="lm",
    )
    draw.rectangle([rx1 - 210, ry0 + 54, rx1 - 32, ry0 + 104], fill=EMERALD)
    draw.text((rx1 - 121, ry0 + 79), "RUN <GO>", font=get_font(18, True), fill=(0, 0, 0), anchor="mm")

    # SQL Result Table
    st_y = ry0 + 128
    draw.rectangle([rx0 + 20, st_y, rx1 - 20, st_y + 32], fill=THEAD_BG, outline=BORDER_STRONG)
    draw.text((rx0 + 40, st_y + 16), "SYMBOL", font=get_font(13, True), fill=TEXT_MUTED, anchor="lm")
    draw.text((rx0 + 310, st_y + 16), "ASSET CLASS", font=get_font(13, True), fill=TEXT_MUTED, anchor="lm")
    draw.text((rx0 + 590, st_y + 16), "TRADES", font=get_font(13, True), fill=TEXT_MUTED, anchor="rm")
    draw.text((rx0 + 880, st_y + 16), "CUMULATIVE NOTIONAL", font=get_font(13, True), fill=TEXT_MUTED, anchor="rm")
    draw.text((rx1 - 40, st_y + 16), "AVG PRICE", font=get_font(13, True), fill=TEXT_MUTED, anchor="rm")

    btc_notional = "$135,182,251.25" if filled else "$134,946,000.00"
    btc_trades = "1,429" if filled else "1,428"
    sql_rows = [
        ("BTC-USD", "CRYPTO SPOT", btc_trades, btc_notional, "$94,485.20", EMERALD),
        ("ETH-USD", "CRYPTO SPOT", "984", "$31,291,200.00", "$3,174.50", TEXT_PRI),
        ("XAU-USD", "COMMODITY SPOT", "612", "$16,799,400.00", "$2,748.10", TEXT_PRI),
        ("SOL-USD", "CRYPTO SPOT", "845", "$11,482,500.00", "$210.80", TEXT_PRI),
        ("NVDA-EQ", "US EQUITY", "520", "$7,706,400.00", "$147.10", TEXT_PRI),
        ("IDR-USD", "FX FUTURES", "310", "$4,860,800.00", "15,675.00", CYAN),
    ]
    sry = st_y + 34
    for sym, acls, trd, notl, vwap, rcol in sql_rows:
        draw.line([(rx0 + 20, sry + 38), (rx1 - 20, sry + 38)], fill=BORDER_PANEL)
        draw.text((rx0 + 40, sry + 19), sym, font=get_font(15, True), fill=AMBER, anchor="lm")
        draw.text((rx0 + 310, sry + 19), acls, font=get_font(14, False), fill=TEXT_SEC, anchor="lm")
        draw.text((rx0 + 590, sry + 19), trd, font=get_font(15, True), fill=TEXT_PRI, anchor="rm")
        draw.text((rx0 + 880, sry + 19), notl, font=get_font(15, True), fill=rcol, anchor="rm")
        draw.text((rx1 - 40, sry + 19), vwap, font=get_font(15, True), fill=CYAN, anchor="rm")
        sry += 40

    # --- BOTTOM-RIGHT PANEL: 5 SEEDED VULNERABILITIES FIXED + REGRESSION-TESTED (x: 740..1896, y: 604..1056) ---
    sx0, sy0, sx1, sy1 = 740, 604, 1896, 1056
    draw.rectangle([sx0, sy0, sx1, sy1], fill=BG_PANEL, outline=EMERALD, width=2)
    draw_pane_header(
        draw,
        sx0,
        sy0,
        sx1,
        "SEC",
        "SECURITY // 5 SEEDED VULNERABILITIES FIXED + REGRESSION-TESTED",
        "SECURITY SUITE: 5/5 PASS",
        EMERALD,
    )

    sec_items = [
        ("1. SQL INJECTION IN ORDER SEARCH", "FIXED", "Order search now uses parameterized queries (LIKE ?)"),
        ("2. SQL CONSOLE WRITE ACCESS", "FIXED", "Read-only guard: single SELECT only; accounts/api_secret blocked"),
        ("3. SSRF VIA WEBHOOK PING", "FIXED", "Egress filter rejects loopback / private / link-local targets"),
        ("4. RESTRICTED ACCOUNT ACCESS", "FIXED", "X-API-Key required to trade the RESTRICTED account ACC-VAULT-99"),
        ("5. UNBOUNDED ORDERS & PAYLOADS", "FIXED", "5x buying-power cap per order + 64KB request body limit"),
    ]
    iy = sy0 + 46
    for title_s, badge_s, desc_s in sec_items:
        draw.rectangle([sx0 + 20, iy, sx1 - 20, iy + 68], fill=BG_OBSIDIAN, outline=BORDER_STRONG, width=1)
        draw.rectangle([sx0 + 20, iy, sx0 + 26, iy + 68], fill=EMERALD)
        draw.text((sx0 + 42, iy + 22), title_s, font=get_font(16, True), fill=TEXT_PRI, anchor="lm")
        draw.text((sx0 + 42, iy + 48), desc_s, font=get_font(14, False), fill=TEXT_SEC, anchor="lm")

        draw.rectangle([sx1 - 190, iy + 14, sx1 - 36, iy + 54], fill=EMERALD_DIM, outline=EMERALD, width=2)
        draw.text((sx1 - 113, iy + 34), f"{badge_s} + TESTED", font=get_font(15, True), fill=EMERALD, anchor="mm")
        iy += 78


def render_scene_4_outro(img: Image.Image, draw: ImageDraw.ImageDraw, t: float):
    # Scene 4 (13.5s - 18.0s): Outro / Punchline
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=BG_OBSIDIAN)
    draw_grid_background(draw, t, step=48)
    draw_top_bloomberg_header(draw, t, cmd_text="ARGUS // READY <GO>", nav_val="$10,279,101.25", upnl_val="+$46,420.00")

    # Center Hero Card Frame
    cx0, cy0, cx1, cy1 = 130, 140, WIDTH - 130, 980
    draw.rectangle([cx0, cy0, cx1, cy1], fill=BG_PANEL, outline=AMBER, width=3)
    draw.rectangle([cx0 + 10, cy0 + 10, cx1 - 10, cy1 - 10], outline=BORDER_STRONG, width=1)

    # Brand Lockup
    draw.rectangle([WIDTH // 2 - 290, 200, WIDTH // 2 - 226, 264], fill=AMBER)
    draw.text((WIDTH // 2 - 258, 232), "A", font=get_font(42, True), fill=(0, 0, 0), anchor="mm")
    draw.text(
        (WIDTH // 2 + 35, 232),
        "ARGUS // TERMINAL",
        font=get_font(46, True),
        fill=TEXT_PRI,
        anchor="mm",
    )

    # Main Hero Punchline
    draw.text(
        (WIDTH // 2, 355),
        "AN EDUCATIONAL TRADING SIM.",
        font=get_font(72, True),
        fill=TEXT_PRI,
        anchor="mm",
    )
    draw.text(
        (WIDTH // 2, 455),
        "RUNS ON YOUR MACHINE.",
        font=get_font(78, True),
        fill=AMBER,
        anchor="mm",
    )

    # Telemetry Summary Pills (4 Cards across)
    cards = [
        ("6 SIM INSTRUMENTS", "BTC • ETH • SOL • NVDA • XAU • IDR", EMERALD),
        ("FIFO MATCHING", "TYPEDARRAY SLAB ORDER BOOK", AMBER),
        ("NODE:SQLITE + WS", "READ-ONLY SQL CONSOLE + LIVE TAPE", CYAN),
        ("5 VULNS FIXED", "SEEDED • REGRESSION-TESTED", EMERALD),
    ]
    card_w = 370
    gap = 24
    total_w = 4 * card_w + 3 * gap
    start_x = (WIDTH - total_w) // 2
    cy_card = 555

    for idx, (hdr, sub, col) in enumerate(cards):
        x0 = start_x + idx * (card_w + gap)
        draw.rectangle([x0, cy_card, x0 + card_w, cy_card + 130], fill=BG_ELEVATED, outline=col, width=2)
        draw.text((x0 + card_w // 2, cy_card + 46), hdr, font=get_font(25, True), fill=col, anchor="mm")
        draw.text((x0 + card_w // 2, cy_card + 92), sub, font=get_font(14, True), fill=TEXT_SEC, anchor="mm")

    # Bottom <GO> Command Bar CTA
    bx0, by0, bx1, by1 = 310, 745, WIDTH - 310, 835
    draw.rectangle([bx0, by0, bx1, by1], fill=BG_INPUT, outline=AMBER, width=3)
    draw.rectangle([bx0 + 3, by0 + 3, bx0 + 135, by1 - 3], fill=AMBER_DIM)
    draw.text((bx0 + 69, (by0 + by1) // 2), "CMD>", font=get_font(28, True), fill=AMBER, anchor="mm")
    draw.text(
        (bx0 + 165, (by0 + by1) // 2),
        "npm start  //  http://localhost:3400 <GO>",
        font=get_font(28, True),
        fill=TEXT_PRI,
        anchor="lm",
    )
    draw.rectangle([bx1 - 190, by0 + 10, bx1 - 12, by1 - 10], fill=EMERALD)
    draw.text((bx1 - 101, (by0 + by1) // 2), "RUN <GO>", font=get_font(24, True), fill=(2, 16, 8), anchor="mm")

    draw.text(
        (WIDTH // 2, 910),
        "LOCAL NODE.JS + NODE:SQLITE  •  ONE RUNTIME DEPENDENCY (ws)  •  5 TEST SUITES  •  51 CHECKS PASSING",
        font=get_font(18, True),
        fill=TEXT_SEC,
        anchor="mm",
    )


def render_frame_at(frame_idx: int, poster_Img: Image.Image = None) -> Image.Image:
    # Frame 0 is replaced with the strongest settled poster frame per brag-slim spec
    if frame_idx == 0 and poster_Img is not None:
        return poster_Img

    t = frame_idx / float(FPS)
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_OBSIDIAN)
    draw = ImageDraw.Draw(img)

    if t < 3.5:
        render_scene_1_hook(img, draw, t)
    elif t < 8.5:
        render_scene_2_terminal(img, draw, t, is_poster=False)
    elif t < 13.5:
        render_scene_3_engine_security(img, draw, t)
    else:
        render_scene_4_outro(img, draw, t)

    return img


def build_poster_image() -> Image.Image:
    # Strongest settled frame at t = 6.0s (Frame 180) showing full 5-pane terminal + title badge
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_OBSIDIAN)
    draw = ImageDraw.Draw(img)
    render_scene_2_terminal(img, draw, 6.0, is_poster=True)
    return img


def save_check_stills(work_dir: str, poster_path: str) -> Image.Image:
    os.makedirs(work_dir, exist_ok=True)
    poster_img = build_poster_image()
    poster_img.save(poster_path, quality=95, subsampling=0)
    print(f"Saved poster: {poster_path} ({os.path.getsize(poster_path)} bytes)")

    check_samples = [
        ("still_s1a_hook.png", 18),       # t = 0.6s
        ("still_s1b_gobar.png", 96),      # t = 3.2s
        ("still_s2_terminal.png", 180),   # t = 6.0s
        ("still_s3_engine_sec.png", 330), # t = 11.0s
        ("still_s4_outro.png", 465),      # t = 15.5s
    ]
    for fname, fidx in check_samples:
        im = render_frame_at(fidx, poster_img)
        out_p = os.path.join(work_dir, fname)
        im.save(out_p)
        print(f"Saved check still: {out_p}")

    return poster_img


def render_mp4(work_dir: str, audio_path: str, out_mp4: str, poster_img: Image.Image):
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel", "error",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-s", f"{WIDTH}x{HEIGHT}",
        "-pix_fmt", "rgb24",
        "-r", str(FPS),
        "-i", "-",
        "-i", audio_path,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        out_mp4,
    ]
    print("Launching FFmpeg pipeline...")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for f in range(TOTAL_FRAMES):
        frame_img = render_frame_at(f, poster_img)
        proc.stdin.write(frame_img.tobytes())
        if (f + 1) % 90 == 0 or f == TOTAL_FRAMES - 1:
            print(f"  Rendered {f + 1}/{TOTAL_FRAMES} frames...")

    proc.stdin.close()
    ret = proc.wait()
    if ret != 0:
        raise RuntimeError(f"FFmpeg failed with code {ret}")
    print(f"Successfully rendered MP4: {out_mp4} ({os.path.getsize(out_mp4)} bytes)")


if __name__ == "__main__":
    # brag-output/ (parent of this script's work/ folder)
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    work_dir = os.path.join(base_dir, "work")
    audio_path = os.path.join(work_dir, "soundtrack.wav")
    poster_path = os.path.join(base_dir, "brag.jpg")
    out_mp4 = os.path.join(base_dir, "brag.mp4")

    poster_img = save_check_stills(work_dir, poster_path)
    if "--stills-only" not in sys.argv:
        render_mp4(work_dir, audio_path, out_mp4, poster_img)
