import os
import glob
import base64
import io
import cv2
import numpy as np
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_cors import CORS
from ultralytics import SAM
from PIL import Image

app = Flask(__name__)
CORS(app)

DATA_DIR = "dataset"
SPLITS = ["train", "val", "test"]

print("Loading SAM Base model...")
model = SAM('sam_b.pt')

def get_image_list():
    images = []
    for split in SPLITS:
        raw_dir = os.path.join(DATA_DIR, split, "raw_context")
        img_dir = os.path.join(DATA_DIR, split, "images")
        mask_dir = os.path.join(DATA_DIR, split, "masks")
        
        if not os.path.exists(raw_dir):
            continue
            
        raw_files = glob.glob(os.path.join(raw_dir, "*.jpg"))
        for raw_path in raw_files:
            filename = os.path.basename(raw_path)
            mask_filename = filename.replace(".jpg", ".png")
            
            img_path = os.path.join(img_dir, filename)
            mask_path = os.path.join(mask_dir, mask_filename)
            
            status = "annotated" if os.path.exists(mask_path) else "unannotated"
            
            images.append({
                "id": f"{split}/{filename}",
                "split": split,
                "filename": filename,
                "mask_filename": mask_filename,
                "status": status,
                "raw_url": f"/api/raw/{split}/{filename}",
                "mask_url": f"/api/mask/{split}/{mask_filename}" if status == "annotated" else None
            })
    return sorted(images, key=lambda x: (x['status'], x['id']))

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/images')
def list_images():
    return jsonify(get_image_list())

@app.route('/api/raw/<split>/<filename>')
def serve_raw(split, filename):
    return send_from_directory(os.path.join(DATA_DIR, split, "raw_context"), filename)

@app.route('/api/mask/<split>/<filename>')
def serve_mask(split, filename):
    return send_from_directory(os.path.join(DATA_DIR, split, "masks"), filename)

@app.route('/api/predict', methods=['POST'])
def predict():
    data = request.json
    split = data.get('split')
    filename = data.get('filename')
    points = data.get('points', [])
    labels = data.get('labels', [])
    
    if not points or not split or not filename:
        return jsonify({"error": "Missing data"}), 400
        
    raw_path = os.path.join(DATA_DIR, split, "raw_context", filename)
    if not os.path.exists(raw_path):
        return jsonify({"error": "Image not found"}), 404
        
    # Read image
    img = cv2.imread(raw_path)
    
    # Run SAM
    results = model.predict(img, points=points, labels=labels, verbose=False)
    
    if len(results) > 0 and results[0].masks is not None:
        mask = results[0].masks.data[0].cpu().numpy()
        h, w = img.shape[:2]
        mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
        
        # Convert mask to base64 PNG
        mask_uint8 = (mask * 255).astype(np.uint8)
        _, buffer = cv2.imencode('.png', mask_uint8)
        mask_b64 = base64.b64encode(buffer).decode('utf-8')
        
        return jsonify({
            "mask_b64": f"data:image/png;base64,{mask_b64}"
        })
    else:
        return jsonify({"error": "No mask generated"}), 500

@app.route('/api/save', methods=['POST'])
def save_mask():
    data = request.json
    split = data.get('split')
    filename = data.get('filename')
    mask_b64 = data.get('mask_b64') # "data:image/png;base64,..."
    
    if not split or not filename or not mask_b64:
        return jsonify({"error": "Missing data"}), 400
        
    try:
        header, encoded = mask_b64.split(",", 1)
        mask_data = base64.b64decode(encoded)
        
        # Decode the RGBA canvas image sent by the browser
        nparr = np.frombuffer(mask_data, np.uint8)
        img_rgba = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        
        # Convert it to a 1-channel binary mask (255 for fields, 0 for background)
        if len(img_rgba.shape) == 3 and img_rgba.shape[2] == 4:
            # Use alpha channel (where we painted)
            binary_mask = img_rgba[:, :, 3]
        else:
            # Fallback to green channel if not RGBA
            binary_mask = img_rgba[:, :, 1] if len(img_rgba.shape) == 3 else img_rgba
            
        _, binary_mask = cv2.threshold(binary_mask, 127, 255, cv2.THRESH_BINARY)
        
        mask_filename = filename.replace(".jpg", ".png")
        img_dir = os.path.join(DATA_DIR, split, "images")
        mask_dir = os.path.join(DATA_DIR, split, "masks")
        raw_path = os.path.join(DATA_DIR, split, "raw_context", filename)
        
        final_img_path = os.path.join(img_dir, filename)
        final_mask_path = os.path.join(mask_dir, mask_filename)
        
        # Save Binary Mask
        cv2.imwrite(final_mask_path, binary_mask)
            
        # Copy Raw Context to Images dir if it doesn't exist
        if not os.path.exists(final_img_path):
            import shutil
            shutil.copy2(raw_path, final_img_path)
            
        return jsonify({"success": True, "mask_url": f"/api/mask/{split}/{mask_filename}"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
