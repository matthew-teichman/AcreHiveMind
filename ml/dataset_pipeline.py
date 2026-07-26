import os
import random
import requests
import mercantile
from PIL import Image
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor

# Constants
ZOOM_LEVEL = 16
TILE_SIZE = 256
DATA_DIR = "dataset"
TRAIN_DIR = os.path.join(DATA_DIR, "train")
VAL_DIR = os.path.join(DATA_DIR, "val")
TEST_DIR = os.path.join(DATA_DIR, "test")

def setup_dirs():
    for split in [TRAIN_DIR, VAL_DIR, TEST_DIR]:
        os.makedirs(os.path.join(split, "raw_context"), exist_ok=True)
        os.makedirs(os.path.join(split, "images"), exist_ok=True)
        os.makedirs(os.path.join(split, "masks"), exist_ok=True)

def download_single_tile(x, y, z):
    url = f"https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            return Image.open(requests.get(url, stream=True).raw).convert('RGB')
    except Exception as e:
        print(f"Error downloading tile {z}/{x}/{y}: {e}")
    return None

def download_3x3_context(center_x, center_y, z, filepath):
    if os.path.exists(filepath):
        return True
        
    context_img = Image.new('RGB', (TILE_SIZE * 3, TILE_SIZE * 3))
    
    for row_idx, dy in enumerate([-1, 0, 1]):
        for col_idx, dx in enumerate([-1, 0, 1]):
            x = center_x + dx
            y = center_y + dy
            tile_img = download_single_tile(x, y, z)
            if tile_img is None:
                return False
            context_img.paste(tile_img, (col_idx * TILE_SIZE, row_idx * TILE_SIZE))
            
    context_img.save(filepath)
    return True

def get_random_coordinate():
    # Define large bounding boxes for sampling
    # [North, South, East, West]
    regions = [
        (43.0, 40.0, -90.0, -95.0),   # US Midwest
        (49.0, 46.0, 5.0, 0.0),       # France
        (-21.0, -24.0, -45.0, -50.0), # Brazil
        (31.0, 28.0, 77.0, 73.0)      # India
    ]
    
    region = random.choice(regions)
    n, s, e, w = region
    
    lat = random.uniform(s, n)
    lon = random.uniform(w, e)
    
    return lat, lon

def process_sample(args):
    idx, split_dir = args
    lat, lon = get_random_coordinate()
    
    tile = mercantile.tile(lon, lat, ZOOM_LEVEL)
    
    filename = f"{idx}_{tile.z}_{tile.x}_{tile.y}.jpg"
    context_path = os.path.join(split_dir, "raw_context", filename)
    
    success = download_3x3_context(tile.x, tile.y, tile.z, context_path)
    return success

def generate_dataset(num_train=2000, num_val=200, num_test=100):
    setup_dirs()
    print("Sampling geographic coordinates and downloading 3x3 context tiles (768x768)...")
    
    splits = [
        (num_train, TRAIN_DIR, "Train"),
        (num_val, VAL_DIR, "Val"),
        (num_test, TEST_DIR, "Test")
    ]
    
    for count, split_dir, split_name in splits:
        if count <= 0: continue
        print(f"\nProcessing {split_name} split ({count} images with 3x3 context)...")
        
        tasks = [(i, split_dir) for i in range(count)]
        success_count = 0
        
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(tqdm(executor.map(process_sample, tasks), total=len(tasks)))
            success_count = sum(1 for r in results if r)
            
        print(f"Finished {split_name}: {success_count}/{count} successful.")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', type=int, default=2000)
    parser.add_argument('--val', type=int, default=200)
    parser.add_argument('--test', type=int, default=100)
    parser.add_argument('--dry_run', action='store_true', help="Only do a small test run")
    
    args = parser.parse_args()
    
    if args.dry_run:
        print("Dry run: generating 10 train, 2 val, 2 test")
        generate_dataset(10, 2, 2)
    else:
        generate_dataset(args.train, args.val, args.test)
