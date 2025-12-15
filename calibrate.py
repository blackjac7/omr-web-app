import cv2
import numpy as np

img_path = 'ljk_template.jpg'
src = cv2.imread(img_path)

if src is None:
    print("Failed to load image")
    exit()

gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 2)
contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

anchors = []
img_area = src.shape[0] * src.shape[1]

print(f"Total contours: {len(contours)}")

for i, cnt in enumerate(contours):
    area = cv2.contourArea(cnt)
    if area > img_area * 0.0005: # Lowered threshold
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)

        # print(f"Cnt {i}: area={area:.0f}, approx_len={len(approx)}")

        if len(approx) == 4:
             x,y,w,h = cv2.boundingRect(approx)
             aspect = w/float(h)
             # Relaxed aspect ratio
             if 0.7 < aspect < 1.3:
                 M = cv2.moments(cnt)
                 if M["m00"] != 0:
                     anchors.append({'x': M["m10"] / M["m00"], 'y': M["m01"] / M["m00"], 'area': area})

print(f"Found {len(anchors)} potential anchors.")

if len(anchors) != 4:
    # If we found more than 4, maybe we picked up the big frame?
    # Sort by area and pick the 4 similar ones?
    # Or maybe we found the corner markers + something else.
    # The LJK markers are usually the largest black squares.
    if len(anchors) > 4:
        anchors.sort(key=lambda x: x['area'], reverse=True)
        # Pick top 4?
        # Actually in LJK, the corner markers are significant.
        # Let's check areas.
        pass
    else:
        print("Less than 4 anchors found. Aborting calibration.")
        exit()

# Sort anchors: Top-Left, Top-Right, Bottom-Left, Bottom-Right
# Sort by Y
anchors.sort(key=lambda p: p['y'])
top = sorted(anchors[:2], key=lambda p: p['x'])
bottom = sorted(anchors[2:], key=lambda p: p['x'])
final_anchors = top + bottom

src_pts = np.array([ [p['x'], p['y']] for p in final_anchors ], dtype='float32')

# --- CONFIG ---
CONFIG = {
    'widthMM': 210,
    'heightMM': 297,
    'anchors': [{'x': 22.5, 'y': 22.5}, {'x': 187.5, 'y': 22.5}, {'x': 22.5, 'y': 274.5}, {'x': 187.5, 'y': 274.5}],
    'colStartX': 20,
    'bubbleStartY': 110,
    'colWidth': (210 - 40) / 3,
    'rowHeight': 9,
    'bubbleGapMM': 8,
    'firstBubbleOffsetMM': 25,
    'verticalAlignOffset': 3
}

scale_factor = 10
dst_w = int(CONFIG['widthMM'] * scale_factor)
dst_h = int(CONFIG['heightMM'] * scale_factor)
dst_pts = np.array([ [p['x']*scale_factor, p['y']*scale_factor] for p in CONFIG['anchors'] ], dtype='float32')

M = cv2.getPerspectiveTransform(src_pts, dst_pts)
warped = cv2.warpPerspective(src, M, (dst_w, dst_h))
warped_gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)

# --- Bubble Detection ---
w_thresh = cv2.adaptiveThreshold(warped_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 3)
cnts, _ = cv2.findContours(w_thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

bubbles = []
for c in cnts:
    area = cv2.contourArea(c)
    x,y,w,h = cv2.boundingRect(c)
    aspect = w/float(h)

    if 25 < w < 80 and 25 < h < 80 and 0.8 < aspect < 1.2:
        M = cv2.moments(c)
        if M["m00"] != 0:
            cx = M["m10"] / M["m00"]
            cy = M["m01"] / M["m00"]
            bubbles.append([cx, cy])

bubbles = np.array(bubbles)
print(f"Detected {len(bubbles)} bubble candidates.")

if len(bubbles) == 0:
    print("No bubbles detected. Check thresholds.")
    exit()

# --- Calibration Logic ---

# Helper to find closest bubble to a theoretical point
def find_offset(tx, ty, name="Point"):
    distances = np.linalg.norm(bubbles - np.array([tx, ty]), axis=1)
    min_idx = np.argmin(distances)
    closest = bubbles[min_idx]
    dx = closest[0] - tx
    dy = closest[1] - ty
    print(f"{name} -> Theo:({tx:.1f},{ty:.1f}) Obs:({closest[0]:.1f},{closest[1]:.1f}) Delta:({dx:.1f},{dy:.1f})")
    return dx, dy

# Q1-A (Index 0,0,0)
t_cx = (CONFIG['colStartX'] + CONFIG['firstBubbleOffsetMM']) * scale_factor
t_cy = (CONFIG['bubbleStartY'] + CONFIG['verticalAlignOffset']) * scale_factor
dx1, dy1 = find_offset(t_cx, t_cy, "Q1-A")

# Q31-A (Index 30 -> Col 2, Row 0)
q31_cx = (CONFIG['colStartX'] + (2 * CONFIG['colWidth']) + CONFIG['firstBubbleOffsetMM']) * scale_factor
q31_cy = t_cy
dx31, dy31 = find_offset(q31_cx, q31_cy, "Q31-A")

# Q15-A (Index 14 -> Col 0, Row 14)
q15_cx = t_cx
q15_cy = (CONFIG['bubbleStartY'] + (14 * CONFIG['rowHeight']) + CONFIG['verticalAlignOffset']) * scale_factor
dx15, dy15 = find_offset(q15_cx, q15_cy, "Q15-A")

# Calculate New Params
# 1. New Col Width
# Dist between Q1 and Q31 is 2 cols.
# Obs dist X
obs_dist_x_1_31 = (bubbles[np.argmin(np.linalg.norm(bubbles - [q31_cx, q31_cy], axis=1))][0] -
                   bubbles[np.argmin(np.linalg.norm(bubbles - [t_cx, t_cy], axis=1))][0])
new_col_width = (obs_dist_x_1_31 / 2.0) / scale_factor

# 2. New Row Height
obs_dist_y_1_15 = (bubbles[np.argmin(np.linalg.norm(bubbles - [q15_cx, q15_cy], axis=1))][1] -
                   bubbles[np.argmin(np.linalg.norm(bubbles - [t_cx, t_cy], axis=1))][1])
new_row_height = (obs_dist_y_1_15 / 14.0) / scale_factor

# 3. New Offsets
# We align Q1-A exactly.
# But if we change ColWidth, the theoretical position of Q1 (which is Col 0) doesn't change based on ColWidth.
# So Q1-A offset is purely firstBubbleOffset and verticalAlignOffset shift.
new_firstBubbleOffset = CONFIG['firstBubbleOffsetMM'] + (dx1 / scale_factor)
new_verticalAlignOffset = CONFIG['verticalAlignOffset'] + (dy1 / scale_factor)

print("\n--- RESULTS ---")
print(f"Old ColWidth: {CONFIG['colWidth']:.3f} -> New: {new_col_width:.3f}")
print(f"Old RowHeight: {CONFIG['rowHeight']:.3f} -> New: {new_row_height:.3f}")
print(f"Old FirstBubbleOffset: {CONFIG['firstBubbleOffsetMM']:.3f} -> New: {new_firstBubbleOffset:.3f}")
print(f"Old VerticalAlignOffset: {CONFIG['verticalAlignOffset']:.3f} -> New: {new_verticalAlignOffset:.3f}")
