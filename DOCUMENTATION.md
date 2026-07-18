# AcreHiveMind - Project Documentation

## Overview
AcreHiveMind is a farm management desktop application built using **Tauri**, **Vanilla TypeScript**, **HTML/CSS**, and **Vite**. The application provides an interactive map for defining farm fields and obstacles, tracking crop stages, viewing detailed weather/climate data, and managing farm profiles.

## Architecture & Technology Stack
- **Frontend Framework**: Vanilla HTML, CSS, and TypeScript.
- **Build Tool**: Vite.
- **Desktop Environment**: Tauri (Rust backend).
- **Mapping**: Leaflet and Leaflet Geoman for drawing field boundaries and obstacles.
- **Data Visualization**: Chart.js for rendering historical weather data.
- **Machine Learning**: Integrates with a local machine learning workspace (`ml_workspace`) utilizing MobileSAM for field/obstacle segmentation.

## Directory Structure
- `/src`: Frontend source files.
  - `main.ts`: Application logic, UI state management, Tauri API calls, and event listeners.
  - `map.ts`: Leaflet map initialization, polygon drawing, selection, editing, and minimap logic.
  - `styles.css`: Global styles, layout, and theming.
  - `/assets`: Images and UI resources.
- `/src-tauri`: Tauri Rust backend for OS integration, database management, and heavy processing.
- `/ml_workspace`: Python scripts and outputs for ML tasks (e.g., `debug_sam.py` for MobileSAM segmentation).
- `index.html`: The main entry point, containing the application layout, sidebars, and modals.

## Core Entities
1. **UserProfile**: Contains farm owner details, farm coordinates/address, and preferred climate model.
2. **FarmField**: Represents a drawn field on the map. Contains properties like `name`, `crop`, `stage`, `areaHectares`, `pointsJson`, and an associated `WeatherSummary`.
3. **Obstacle**: Represents physical obstacles in a field (e.g., Creek, Tree Stump, Gate).
4. **WeatherData**: Forecast, historical, and climate outlook data used for charting and decision making.

## Key Features
1. **Field Map & Drawing**: Users can interactively draw, select, and edit field boundaries and obstacles on a satellite map.
2. **Field Management Table**: Tabular view of all fields tracking their current stage, area, and summarized weather statistics.
3. **Scheduling Calendar**: A scrollable monthly calendar on the Scheduling tab that displays historical weather and a 16-day forecast for the farm, complete with dynamic weather icons (including support for winter conditions like Snow and Freezing Rain) and precipitation tracking.
4. **Weather Modals**: 16-day forecasts, long-term climate outlooks, soil/hydrology data, and a 5-year historical Chart.js visualization.
5. **Onboarding & Settings**: Geocoding via Photon API to easily locate farms via address or coordinates, and profile settings for customizing the application.
6. **Local LLM & ML Status**: A status indicator in the UI hints at local LLM capabilities, while `ml_workspace` is set up for image segmentation.

## Development Commands
- `npm run dev`: Starts the Vite development server.
- `npm run build`: Compiles TypeScript and builds the Vite frontend.
- `npm run tauri`: Runs Tauri commands (e.g., `npm run tauri dev` to run the desktop app).

## Documentation Policy
Whenever significant changes are made to the codebase (e.g., new entities, architectural shifts, or major UI overhauls), this `DOCUMENTATION.md` file must be updated to reflect the new state of the project.
