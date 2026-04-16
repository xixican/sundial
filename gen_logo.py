"""
Generate Sundial logo v3:
- Black background with rounded corners
- Green (#2ecc71) circle ring (thicker)
- Top quarter of the ring = horizontal bar of "T" (with gaps at ends)
- Vertical line from mid-top arc down to center = vertical bar of "T" (thicker)
"""

from PIL import Image, ImageDraw
import math

SIZE = 512
CX = SIZE // 2
CY = SIZE // 2
RADIUS = int(SIZE * 0.37)
RING_W = int(SIZE * 0.08)   # thicker ring (was 0.05)
GREEN = (46, 204, 113)
BLACK = (0, 0, 0)
CORNER_R = int(SIZE * 0.22)  # rounded corner radius (more visible)

# Create with alpha for rounded corners
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- Draw rounded-corner black background ---
draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=CORNER_R, fill=BLACK)

outer_r = RADIUS
inner_r = RADIUS - RING_W
mid_r = (outer_r + inner_r) / 2.0

# --- Draw ring as individual arc segments ---
def draw_ring_arc(start_deg, end_deg, color):
    """Draw a filled ring arc from start_deg to end_deg (PIL convention: 0=right, CW)."""
    step = 0.5
    a = start_deg
    while a < end_deg:
        a1 = math.radians(a)
        a2 = math.radians(min(a + step, end_deg))
        p1 = (CX + outer_r * math.cos(a1), CY + outer_r * math.sin(a1))
        p2 = (CX + outer_r * math.cos(a2), CY + outer_r * math.sin(a2))
        p3 = (CX + inner_r * math.cos(a2), CY + inner_r * math.sin(a2))
        p4 = (CX + inner_r * math.cos(a1), CY + inner_r * math.sin(a1))
        draw.polygon([p1, p2, p3, p4], fill=color)
        a += step

# PIL angle convention: 0=right(3 o'clock), CW
# Top = 270 deg, Top quarter = 225 to 315 deg
GAP = 10  # degrees gap at T bar ends

# Draw bottom 3/4 of ring
draw_ring_arc(315 + GAP, 360, GREEN)
draw_ring_arc(0, 225 - GAP, GREEN)

# Draw top quarter (T horizontal bar)
draw_ring_arc(225 + GAP, 315 - GAP, GREEN)

# --- Draw vertical line of "T" (thicker) ---
T_W = int(RING_W * 0.72)
t_top = CY - inner_r
t_bot = CY  # exactly to center

draw.rectangle([CX - T_W // 2, t_top, CX + T_W // 2, t_bot], fill=GREEN)

# --- Save ---
out = r"E:\WorkBuddyProject\sundial\assets\icon.png"
# Save as PNG with alpha (rounded corners are transparent)
img.save(out, 'PNG')

img64 = img.resize((64, 64), Image.LANCZOS)
img64.save(out.replace('icon.png', 'icon_64.png'), 'PNG')

img256 = img.resize((256, 256), Image.LANCZOS)
img256.save(out.replace('icon.png', 'icon_256.png'), 'PNG')

print("Done:", out)
