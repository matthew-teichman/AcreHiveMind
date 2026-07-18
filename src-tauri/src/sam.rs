use crate::tiles::{LatLng, MapContext};
use geo::algorithm::bounding_rect::BoundingRect;
use geo::algorithm::simplify::Simplify;
use geo::{BooleanOps, LineString, Polygon};
use image::DynamicImage;
use ndarray::{Array1, Array2, Array3, Array4, s};
use ort::session::{Session, builder::GraphOptimizationLevel};
use reqwest::Client;
use std::fs::File;
use std::io::Write;
use std::path::Path;

use imageproc::contours::find_contours_with_threshold;

const ENCODER_URL: &str =
    "https://huggingface.co/PulpCut/mobilesam-onnx/resolve/main/mobilesam.encoder.onnx";
const DECODER_URL: &str =
    "https://huggingface.co/PulpCut/mobilesam-onnx/resolve/main/mobilesam.decoder.onnx";

pub struct SamModels {
    encoder: Session,
    decoder: Session,
}

pub async fn init_sam_models(app_data_dir: &Path) -> Result<SamModels, String> {
    let encoder_path = app_data_dir.join("mobile_sam_encoder.onnx");
    let decoder_path = app_data_dir.join("mobile_sam_decoder.onnx");

    download_if_missing(&encoder_path, ENCODER_URL).await?;
    download_if_missing(&decoder_path, DECODER_URL).await?;

    let _ = ort::init().with_name("MobileSAM").commit();

    let encoder = Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .commit_from_file(&encoder_path)
        .map_err(|e| e.to_string())?;

    let decoder = Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .commit_from_file(&decoder_path)
        .map_err(|e| e.to_string())?;

    Ok(SamModels { encoder, decoder })
}

async fn download_if_missing(path: &Path, url: &str) -> Result<(), String> {
    if !path.exists() {
        println!("Downloading {} to {:?}", url, path);
        let client = Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36").build().map_err(|e| e.to_string())?;
        let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Failed to download model from {}: {} - {}",
                url, status, text
            ));
        }
        let mut file = File::create(path).map_err(|e| e.to_string())?;
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn preprocess_image(image: &DynamicImage) -> Array3<f32> {
    let resized = image.resize_exact(1024, 1024, image::imageops::FilterType::Triangle);
    let mut tensor = Array3::<f32>::zeros((1024, 1024, 3));

    for (x, y, pixel) in resized.to_rgb8().enumerate_pixels() {
        tensor[[y as usize, x as usize, 0]] = pixel[0] as f32;
        tensor[[y as usize, x as usize, 1]] = pixel[1] as f32;
        tensor[[y as usize, x as usize, 2]] = pixel[2] as f32;
    }
    tensor
}

pub fn run_sam_inference(
    models: &mut SamModels,
    map_context: &MapContext,
    input_points: &[LatLng],
) -> Result<Vec<LatLng>, String> {
    // 1. Run encoder
    let input_tensor = preprocess_image(&map_context.image);
    let input_val = ort::value::Tensor::from_array(input_tensor).map_err(|e| e.to_string())?;

    let encoder_outputs = models
        .encoder
        .run(ort::inputs![input_val])
        .map_err(|e| e.to_string())?;

    // The output is named "image_embeddings" in MobileSAM
    let image_embeddings_val = &encoder_outputs[0];
    let (shape, data) = image_embeddings_val
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let image_embeddings_tensor = ndarray::ArrayView4::from_shape(
        (
            shape[0] as usize,
            shape[1] as usize,
            shape[2] as usize,
            shape[3] as usize,
        ),
        data,
    )
    .map_err(|e| e.to_string())?;

    // 2. Prepare decoder inputs - Use Bounding Box + Centroid of the polygon
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;

    for pt in input_points {
        let (px, py) = map_context.latlng_to_pixel(pt);
        let px = px as f32;
        let py = py as f32;
        sum_x += px;
        sum_y += py;
        if px < min_x {
            min_x = px;
        }
        if py < min_y {
            min_y = py;
        }
        if px > max_x {
            max_x = px;
        }
        if py > max_y {
            max_y = py;
        }
    }

    let img_w = map_context.image.width() as f32;
    let img_h = map_context.image.height() as f32;

    let center_x = (sum_x / input_points.len() as f32 / img_w) * 1024.0;
    let center_y = (sum_y / input_points.len() as f32 / img_h) * 1024.0;

    let tl_x = (min_x / img_w) * 1024.0;
    let tl_y = (min_y / img_h) * 1024.0;
    let br_x = (max_x / img_w) * 1024.0;
    let br_y = (max_y / img_h) * 1024.0;

    // Use 3 points: Centroid, Top-Left box, Bottom-Right box
    let mut point_coords = Array3::<f32>::zeros((1, 3, 2));
    let mut point_labels = Array2::<f32>::zeros((1, 3));

    point_coords[[0, 0, 0]] = center_x;
    point_coords[[0, 0, 1]] = center_y;
    point_labels[[0, 0]] = 1.0; // Foreground point

    point_coords[[0, 1, 0]] = tl_x;
    point_coords[[0, 1, 1]] = tl_y;
    point_labels[[0, 1]] = 2.0; // Top-left bounding box

    point_coords[[0, 2, 0]] = br_x;
    point_coords[[0, 2, 1]] = br_y;
    point_labels[[0, 2]] = 3.0; // Bottom-right bounding box

    let mask_input = Array4::<f32>::zeros((1, 1, 256, 256));
    let has_mask_input = Array1::<f32>::zeros(1);
    let mut orig_im_size = Array1::<f32>::zeros(2);
    orig_im_size[0] = img_h;
    orig_im_size[1] = img_w;

    let point_coords_val =
        ort::value::Tensor::from_array(point_coords).map_err(|e| e.to_string())?;
    let point_labels_val =
        ort::value::Tensor::from_array(point_labels).map_err(|e| e.to_string())?;
    let mask_input_val = ort::value::Tensor::from_array(mask_input).map_err(|e| e.to_string())?;
    let has_mask_input_val =
        ort::value::Tensor::from_array(has_mask_input).map_err(|e| e.to_string())?;
    let orig_im_size_val =
        ort::value::Tensor::from_array(orig_im_size).map_err(|e| e.to_string())?;

    // We need to re-create the image embeddings value for the decoder session
    let image_embeddings_val2 = ort::value::Tensor::from_array(image_embeddings_tensor.to_owned())
        .map_err(|e| e.to_string())?;

    let decoder_outputs = models
        .decoder
        .run(ort::inputs![
            image_embeddings_val2,
            point_coords_val,
            point_labels_val,
            mask_input_val,
            has_mask_input_val,
            orig_im_size_val
        ])
        .map_err(|e| e.to_string())?;

    let masks_val = &decoder_outputs[0];
    let (shape, data) = masks_val
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let masks_tensor = ndarray::ArrayView4::from_shape(
        (
            shape[0] as usize,
            shape[1] as usize,
            shape[2] as usize,
            shape[3] as usize,
        ),
        data,
    )
    .map_err(|e| e.to_string())?;

    let iou_val = &decoder_outputs[1];
    let (_, iou_data) = iou_val
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let mut best_idx = 0;
    let mut best_iou = -1.0;
    for (i, &iou) in iou_data.iter().enumerate() {
        if iou > best_iou {
            best_iou = iou;
            best_idx = i;
        }
    }

    // masks shape: [1, num_masks, H, W]
    let mask_2d = masks_tensor.slice(s![0, best_idx, .., ..]);

    // 3. Post-process to extract polygon
    let mask_h = shape[2] as u32;
    let mask_w = shape[3] as u32;
    let mut mask_image = image::GrayImage::new(mask_w, mask_h);
    for y in 0..mask_h {
        for x in 0..mask_w {
            let val = mask_2d[[y as usize, x as usize]];
            if val > 0.0 {
                mask_image.put_pixel(x, y, image::Luma([255]));
            }
        }
    }

    // Save debug image
    let debug_path = std::env::temp_dir().join("segmented_mask_debug.png");
    let _ = mask_image.save(&debug_path);

    // Find contours
    let contours = find_contours_with_threshold::<u32>(&mask_image, 128);

    if contours.is_empty() {
        return Err("No field found in segmentation".into());
    }

    // Get largest contour
    let largest_contour = contours.iter().max_by_key(|c| c.points.len()).unwrap();

    let mut points = Vec::new();
    let scale_x = 1024.0 / mask_w as f64;
    let scale_y = 1024.0 / mask_h as f64;
    for p in &largest_contour.points {
        points.push(geo::Point::new(p.x as f64 * scale_x, p.y as f64 * scale_y));
    }

    // Simplify the contour using Ramer-Douglas-Peucker
    let line_string = LineString::from(points);
    let simplified = line_string.simplify(5.0); // Hardcoded 5 pixel epsilon tolerance for smoother edges

    // Map back to LatLng
    let mut result_latlng = Vec::new();
    for pt in simplified.clone().into_iter() {
        let ll = map_context.pixel_to_latlng(pt.x as u32, pt.y as u32);
        result_latlng.push(ll);
    }

    // Generate debug overlay
    use image::Rgba;
    use imageproc::drawing::{draw_cross_mut, draw_hollow_rect_mut, draw_line_segment_mut};
    use imageproc::rect::Rect;

    let mut overlay = map_context.image.to_rgba8();

    // Blend the raw mask (red tint)
    for y in 0..mask_h {
        for x in 0..mask_w {
            if mask_image.get_pixel(x, y)[0] > 0 {
                let base_x = (x as f32 * 1024.0 / mask_w as f32) as u32;
                let base_y = (y as f32 * 1024.0 / mask_h as f32) as u32;
                let step_x = (1024.0 / mask_w as f32).ceil() as u32;
                let step_y = (1024.0 / mask_h as f32).ceil() as u32;

                for dy in 0..step_y {
                    for dx in 0..step_x {
                        if base_x + dx < 1024 && base_y + dy < 1024 {
                            let p = overlay.get_pixel_mut(base_x + dx, base_y + dy);
                            p[0] = ((p[0] as u32 + 255) / 2) as u8; // blend red
                            p[1] = (p[1] as u32 / 2) as u8;
                            p[2] = (p[2] as u32 / 2) as u8;
                        }
                    }
                }
            }
        }
    }

    // Draw bounding box (Blue)
    let rect =
        Rect::at(tl_x as i32, tl_y as i32).of_size((br_x - tl_x) as u32, (br_y - tl_y) as u32);
    draw_hollow_rect_mut(&mut overlay, rect, Rgba([0, 0, 255, 255]));

    // Draw centroid (Green cross)
    draw_cross_mut(
        &mut overlay,
        Rgba([0, 255, 0, 255]),
        center_x as i32,
        center_y as i32,
    );

    // Draw the simplified outline on top in yellow
    let pts = simplified.into_iter().collect::<Vec<_>>();
    for i in 0..pts.len() {
        let p1 = pts[i];
        let p2 = pts[(i + 1) % pts.len()];
        draw_line_segment_mut(
            &mut overlay,
            (p1.x as f32, p1.y as f32),
            (p2.x as f32, p2.y as f32),
            Rgba([255, 255, 0, 255]),
        );
    }

    // Save debug image
    let debug_path = std::env::temp_dir().join("segmented_mask_debug.png");
    let _ = overlay.save(&debug_path);

    Ok(result_latlng)
}

pub fn simplify_and_subtract_obstacles(
    field_points: Vec<LatLng>,
    obstacles: Vec<Vec<LatLng>>,
) -> Vec<LatLng> {
    if field_points.is_empty() {
        return field_points;
    }

    // Convert to geo::Polygon
    let ext_coords: Vec<(f64, f64)> = field_points.iter().map(|p| (p.lng, p.lat)).collect();
    let ls = LineString::from(ext_coords);
    let mut field_poly = Polygon::new(ls, vec![]);

    // Simplify using Ramer-Douglas-Peucker
    // A tolerance of 0.00001 degrees is roughly 1 meter
    field_poly = field_poly.simplify(0.00001);

    // Subtract obstacles
    for obs_points in obstacles {
        if obs_points.is_empty() {
            continue;
        }
        let obs_coords: Vec<(f64, f64)> = obs_points.iter().map(|p| (p.lng, p.lat)).collect();
        let obs_ls = LineString::from(obs_coords);
        let obs_poly = Polygon::new(obs_ls, vec![]);

        let difference = field_poly.difference(&obs_poly);

        // Difference can result in MultiPolygon. We just take the largest one or the first one.
        if !difference.0.is_empty() {
            // Find the polygon with largest area (roughly by bounding box)
            field_poly = difference
                .0
                .into_iter()
                .max_by(|a, b| {
                    let a_area = a
                        .bounding_rect()
                        .map(|r| r.width() * r.height())
                        .unwrap_or(0.0);
                    let b_area = b
                        .bounding_rect()
                        .map(|r| r.width() * r.height())
                        .unwrap_or(0.0);
                    a_area.partial_cmp(&b_area).unwrap()
                })
                .unwrap();
        }
    }

    // Convert back to LatLng
    let mut final_points = vec![];
    for coord in field_poly.exterior().points() {
        final_points.push(LatLng {
            lat: coord.y(),
            lng: coord.x(),
        });
    }

    final_points
}
