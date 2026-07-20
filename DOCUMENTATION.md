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
5. **Agentic Recommendation (LLM Integration)**: A ChatGPT-style split-pane chat interface where farmers can ask for agronomic advice. Features include:
   - **Provider Support**: Seamless support for both **Google Gemini** (via API key) and local, private models via **Ollama**.
   - **Chat History**: Infinite scrollable sidebar of chat history. Sessions automatically generate their own titles by analyzing the user's first prompt.
   - **Token Tracking**: Persistent token usage tracking across both LLM providers.
6. **Onboarding & Settings**: Geocoding via Photon API to easily locate farms via address or coordinates, and profile settings for customizing the application.

## Model Context Protocol (MCP) Architecture
To grant the LLM profound context about the farm, AcreHiveMind implements the **Model Context Protocol (MCP)**. 

### How it Works
1. **Backend Server**: The Rust backend spins up an independent Axum microservice (`http://127.0.0.1:3030`) that serves two primary MCP endpoints:
   - `GET /mcp/sse`: Establishes a Server-Sent Events stream to push Tool definitions to the client.
   - `POST /mcp/messages`: Accepts JSON-RPC tool invocations and executes them securely inside the Rust sandbox, querying the SQLite database or external APIs.
2. **Frontend Intermediary**: `main.ts` connects to `/mcp/sse`, dynamically parses the available tools, and seamlessly translates them into both Gemini's Function Calling schema and Ollama's OpenAI Tool schema.
3. **Autonomous Execution Loop**: When the user sends a prompt, the frontend enters a `while` loop. If the LLM requests a tool (e.g., `get_field_and_weather_data`), the frontend automatically POSTs that request to the Rust MCP backend, waits for the result, and loops it back into the LLM context. This continues until the LLM yields a final text response. Timeouts are gracefully handled and communicated to the LLM.

### LLM Data Access (Available Tools)
Through MCP, the AI acts autonomously and has real-time access to the following data sources:
1. **`get_field_and_weather_data(fieldId)`**: The flagship tool. Provides the AI with:
   - Basic field properties (Crop, Stage, Area).
   - Recent historical weather and the full 16-day predictive forecast.
   - **5-Year Historical Summaries**: Aggregated annual precipitation and sun exposure totals for the past 5 years to determine historical baselines.
   - **Advanced Agronomy Metrics**: `deltaT` (evaluating spraying suitability), `inversionRisk`, `trafficability`, `growingDegreeDays`, `wind`, `humidity`, `leafWetness`, and `subsurfaceSoilProfiles`.
2. **`get_calendar_events(fieldId)`**: Fetches all logged farm events, tasks, verification tokens, and text notes associated with the field.
3. **`get_ndvi_heatmap(fieldId)`**: Generates a procedurally evaluated NDVI satellite heatmap of the field. The LLM can render this directly in the chat via Markdown linking to `http://127.0.0.1:3030/api/ndvi?fieldId={}`.

## Development Commands
- `npm run dev`: Starts the Vite development server.
- `npm run build`: Compiles TypeScript and builds the Vite frontend.
- `npm run tauri`: Runs Tauri commands (e.g., `npm run tauri dev` to run the desktop app).

## Documentation Policy
Whenever significant changes are made to the codebase (e.g., new entities, architectural shifts, or major UI overhauls), this `DOCUMENTATION.md` file must be updated to reflect the new state of the project.
