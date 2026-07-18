import onnxruntime as ort
import numpy as np
import cv2
import requests
import os
import matplotlib.pyplot as plt
from PIL import Image

import math

def get_google_satellite_tile(tx, ty, zoom):
    url = f"https://mt1.google.com/vt/lyrs=s&x={tx}&y={ty}&z={zoom}"
    resp = requests.get(url)
    if resp.status_code == 200:
        return np.asarray(bytearray(resp.content), dtype="uint8")
    return None

def lat_lng_to_tile(lat, lng, zoom):
    n = 2.0 ** zoom
    x = int((lng + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return x, y

def download_sample_image():
    zoom = 15
    lat, lng = 44.7709911, -80.0116563

    n = 2.0 ** zoom
    x_center = (lng + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y_center = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n

    # Same logic as tiles.rs: top-left tile is (x_center - 2.0).floor()
    top_left_x = int(math.floor(x_center - 2.0))
    top_left_y = int(math.floor(y_center - 2.0))

    img = np.zeros((1024, 1024, 3), dtype=np.uint8)

    for dx in range(4):
        for dy in range(4):
            tx = top_left_x + dx
            ty = top_left_y + dy
            tile_data = get_google_satellite_tile(tx, ty, zoom)
            if tile_data is not None:
                tile = cv2.imdecode(tile_data, cv2.IMREAD_COLOR)
                tile = cv2.cvtColor(tile, cv2.COLOR_BGR2RGB)
                # Google tiles are 256x256
                img[dy*256:(dy+1)*256, dx*256:(dx+1)*256] = tile

    # We also need to map the lat/lng center to the exact pixel coordinate in this 1024x1024 grid
    # x_global = x_center, top_left_x_tile = top_left_x
    px = (x_center - top_left_x) * 256.0
    py = (y_center - top_left_y) * 256.0

    return img, (px, py)

def main():
    encoder_path = r'C:\Users\teich\AppData\Roaming\com.acremind\mobile_sam_encoder.onnx'
    decoder_path = r'C:\Users\teich\AppData\Roaming\com.acremind\mobile_sam_decoder.onnx'

    print("Loading models...")
    encoder = ort.InferenceSession(encoder_path)
    decoder = ort.InferenceSession(decoder_path)

    # 1. Image
    img, (cx, cy) = download_sample_image()
    img_h, img_w = img.shape[:2]

    # Preprocess image for encoder (just pass 0-255 values, since normalization is baked in!)
    input_tensor = img.astype(np.float32)

    print("Running encoder...")
    # Encoder input expects ['image_height', 'image_width', 3]
    # No batch dimension!
    encoder_inputs = {'input_image': input_tensor}
    encoder_outputs = encoder.run(None, encoder_inputs)
    image_embeddings = encoder_outputs[0]

    # 2. Decoder
    # Bounding box prompt
    # Centroid: (cx, cy)
    # Box: e.g. cx-100 to cx+100

    # Points array: shape [1, 3, 2]
    point_coords = np.zeros((1, 3, 2), dtype=np.float32)
    point_labels = np.zeros((1, 3), dtype=np.float32)

    point_coords[0, 0, :] = [cx, cy]
    point_labels[0, 0] = 1.0 # foreground

    point_coords[0, 1, :] = [cx - 150, cy - 150] # TL
    point_labels[0, 1] = 2.0 # TL

    point_coords[0, 2, :] = [cx + 150, cy + 150] # BR
    point_labels[0, 2] = 3.0 # BR

    mask_input = np.zeros((1, 1, 256, 256), dtype=np.float32)
    has_mask_input = np.zeros(1, dtype=np.float32)
    orig_im_size = np.array([img_h, img_w], dtype=np.float32)

    print("Running decoder...")
    decoder_inputs = {
        'image_embeddings': image_embeddings,
        'point_coords': point_coords,
        'point_labels': point_labels,
        'mask_input': mask_input,
        'has_mask_input': has_mask_input,
        'orig_im_size': orig_im_size
    }

    decoder_outputs = decoder.run(None, decoder_inputs)
    masks = decoder_outputs[0]
    iou_predictions = decoder_outputs[1]

    best_idx = np.argmax(iou_predictions[0])
    best_mask = masks[0, best_idx, :, :]

    # Threshold mask
    best_mask = (best_mask > 0.0).astype(np.uint8) * 255

    print(f"Raw mask generated. Shape: {best_mask.shape}")

    # --- FILTERING: Keep only largest continuous object and smooth it ---
    # Find contours
    contours, _ = cv2.findContours(best_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        # Get the largest contour by area
        largest_contour = max(contours, key=cv2.contourArea)

        # Smooth the contour using Ramer-Douglas-Peucker (RDP) algorithm
        epsilon = 20.0 # Increased pixel tolerance for much smoother, straighter edges
        smoothed_contour = cv2.approxPolyDP(largest_contour, epsilon, True)

        # Create a new blank mask and draw the smoothed, filled contour
        filtered_mask = np.zeros_like(best_mask)
        cv2.drawContours(filtered_mask, [smoothed_contour], 0, 255, -1)
    else:
        filtered_mask = best_mask

    # Overlay
    # Create red overlay
    color_mask = np.zeros_like(img)
    color_mask[:, :, 0] = filtered_mask # Red channel

    alpha = 0.5
    overlay = cv2.addWeighted(img, 1.0, color_mask, alpha, 0)

    # Draw prompt points and box on overlay
    cv2.circle(overlay, (int(cx), int(cy)), 5, (0, 255, 0), -1) # Centroid (Green)
    # Draw the Bounding Box (Red/Blue depending on channel order)
    cv2.rectangle(overlay, (int(cx)-150, int(cy)-150), (int(cx)+150, int(cy)+150), (255, 0, 0), 2)

    # Save only the overlay image
    out_path = 'segmentation_result.png'
    # Convert RGB back to BGR for cv2.imwrite
    overlay_bgr = cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR)
    cv2.imwrite(out_path, overlay_bgr)
    print(f"Saved {out_path}")

if __name__ == '__main__':
    main()
