## Advanced Statistics for North American Crop Farmers

This document details the ideal statistics to help North American crop farmers in the data field. This include the following:

1. Spraying & Field Operation Metrics (Tactical Data)
- Before a farmer loads up a sprayer or drives a heavy tractor into a field, they need to know if the conditions are safe and legal.
- Wind Speed & Gust Direction: Absolutely critical for spraying. If the wind is too high, expensive chemicals drift into neighboring fields.
- Delta T ($\Delta T$): The standard indicator for evaporation rates during spraying. If Delta T is too high, droplets evaporate before hitting the leaf; if it's too low, they don't evaporate at all.
- Temperature Inversion Risk: A simple Yes/No/High/Low indicator. Spraying during an inversion can cause chemicals to hang in the air and travel miles away.
- Field Trafficability Index: A calculated metric (combining recent rain, soil type, and evapotranspiration) that tells the farmer, "Is the mud going to swallow my 15-ton autonomous tractor today?

2. Crop Development & Agronomics
- Farmers track time not just by the calendar, but by accumulated heat and satellite imagery.
- Growing Degree Days (GDD) / Crop Heat Units (CHU): This is the ultimate clock for North American agriculture. Tracking accumulated heat units tells a farmer exactly when soybeans will flower or when corn will dent, regardless of the physical date.
- NDVI (Normalized Difference Vegetation Index): Since you are already pulling satellite tiles for field boundaries, calculating the NDVI average for the field gives a daily "Greenness/Vigor" score to track crop health.Leaf
- Wetness Duration: A major predictor for fungal diseases. If leaves stay wet for over 12 hours, the risk for blights or molds spikes.

3. Subsurface Soil Dynamics
- You currently have surface moisture (0-7cm), which is great for seed germination, but mature crops pull from deeper reserves.Root-Zone Soil Moisture (15cm, 30cm, 60cm): Showing a profile of moisture at deeper depths tells the farmer if the crop has enough water to survive an upcoming two-week dry spell.
- Soil Temperature at Planting Depth (5cm): In the spring, seeds won't germinate until the soil hits specific temperatures (e.g., $10^\circ$C for corn, $15^\circ$C for soybeans). A dedicated gauge for this dictates planting day.

4. Harvest & Yield Projections
- At the end of the season, data is all about logistics and drying costs.
- Estimated Crop Moisture Percentage: Estimating how wet the grain or forage is. If a farmer harvests too wet, they lose margin paying for propane grain dryers.
- Harvest Window Probability: A predictive metric that combines forecast clear skies, low humidity, and dry soils to highlight the optimal 3-to-4 day stretches for running the combines.


Tasks Implement Advanced Statistics:

The system must process weather, agronomic data, and pull windowed Sentinel-2 satellite imagery to generate a masked False-Color NDVI Heatmap.

Step 1: Open-Meteo API FetcherCreate a new module src/weather_api.rs. Use reqwest and serde to execute an asynchronous HTTP GET request to the Open-Meteo API for a specific coordinate.Extract the following variables:
- Wind speed and wind direction at 10m.
- Temperature (2m and 180m) and Relative Humidity.
- Precipitation (past 48 hours).
- Evapotranspiration (ET₀)
  Growing Degree Days (GDD).
- Mean leaf wetness probability
- Subsurface soil moisture and temperature arrays (0-7cm, 7-28cm, 28-100cm, 100-255cm).

Step 2: Agronomic Calculation EngineCreate a module src/agronomy_math.rs. Implement standard Rust functions to process the raw API arrays into operational metrics:
- Delta T: Calculate wet bulb temperature, then compute $\Delta T$ by subtracting it from the dry bulb temperature.Inversion
- Risk: Return a boolean flag evaluating to true if the 180m temperature is warmer than the 2m temperature during dawn hours.
- Trafficability Index: Implement an algorithm returning a 0-100 score using a weighted combination of 48-hour precipitation, surface soil moisture (0-7cm), and ET₀ rates.- Harvest Window: Iterate over the 14-day forecast array and return the index dates of any consecutive 3-day block containing 0mm precipitation and high sunshine duration.

Step 3: Axum Windowed NDVI MicroserviceCreate a new module src/satellite.rs exposing a dedicated axum endpoint for processing NDVI data:Input:
- Accept a POST request containing a GeoJSON Polygon representing a farm field boundary.STAC Query: Use reqwest to query the Element84 Earth Search REST API (https://earth-search.aws.element84.com/v1/search). Post a JSON payload filtering for the sentinel-2-l2a collection, intersecting the input GeoJSON, sorting by newest, and filtering for eo:cloud_cover < 10.
- Extract URLs: Parse the STAC JSON response using serde_json to extract the href URLs for the Cloud-Optimized GeoTIFF (COG) assets specifically for red (Band 4) and nir08 (Band 8).
- Windowed Read (VSI): Use the gdal crate utilizing GDAL's Virtual File System (/vsicurl/) to open the remote COG URLs without downloading them entirely. Read only the pixel window that intersects with the user's bounding box.
- NDVI Array Math: Load the clipped raster bands into ndarray::Array2<f32> structures. Perform the calculation: (nir - red) / (nir + red). Handle divide-by-zero by setting those pixels to NaN or a designated NoData value.
- Color Mapping: Iterate over the ndarray. Map the values (-1.0 to 1.0) to a gradient False-Color Heatmap (Red-to-Yellow-to-Green) using the image crate. Assign transparent alpha channels (0) to any pixels outside the actual GeoJSON polygon mask geometry.
- Return Output: Encode the mapped image buffer as a PNG in memory and return it as the HTTP response with the Content-Type: image/png header.

Step 4: Local Database Caching Strategy
- Add the following advanced statistics for each field into the database.
- Expiration Rule: When fetching field metrics, check the local database first. Only trigger outbound network requests to Open-Meteo or Sentinel Hub if the cached data for that specific field is older than 6 hours. If fresh, parse the local cache directly.
- When requesting data from open-meteo and sentinel hub using the loading progress bar at top of the application. Make sure it disappear once complete, same as before.

Step 5: Tauri Command & Tabbed Frontend IntegrationIn src/main.rs:
- Expose a #[tauri::command] named get_field_statistics that checks the databsase, coordinates the data calculations, and returns a unified payload to the frontend.
- Frontend Refactor: Update the UI layout component for the field statistics panel into a Tab View layout to save space and reduce visual clutter:
    - Tab 1 (Weather): Displays current temperature, forecast trends, wind speed, gust direction, and humidity.
    - Tab 2 (Agronomy, Soil & Hydrology): Combines the calculated GDD trackers, Delta T values, Inversion Risks, Trafficability indices, Harvest windows, and the sub-surface soil moisture profile gauges (0cm to 255cm).
- Map Rendering: Configure MapLibre GL to use the binary PNG image stream from your Axum server as a dynamic image layer overlay source, binding it perfectly to the geographic boundaries of the field polygon