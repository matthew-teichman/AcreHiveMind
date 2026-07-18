<#
.SYNOPSIS
Sets up a plain Windows system for AcreHiveMind development.

.DESCRIPTION
This script uses 'winget' to install:
- Node.js
- Git
- Visual Studio Build Tools (C++ workloads required for compiling Rust)
- Rust (via rustup)
- Miniconda (for prebuilt GDAL dependencies)
#>

Write-Host "Starting AcreHiveMind Development Environment Setup..." -ForegroundColor Cyan

# Ensure winget is available
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget is not found. Please ensure you are on Windows 10/11 and have the App Installer installed from the Microsoft Store." -ForegroundColor Red
    exit
}

Write-Host "`n[1/5] Installing Node.js..." -ForegroundColor Yellow
winget install OpenJS.NodeJS -e --silent --accept-source-agreements --accept-package-agreements

Write-Host "`n[2/5] Installing Git..." -ForegroundColor Yellow
winget install Git.Git -e --silent --accept-source-agreements --accept-package-agreements

Write-Host "`n[3/5] Installing Visual Studio C++ Build Tools (This may take a while)..." -ForegroundColor Yellow
winget install Microsoft.VisualStudio.2022.BuildTools -e --silent --accept-source-agreements --accept-package-agreements --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

Write-Host "`n[4/5] Installing Miniconda3 (For fast GDAL setup)..." -ForegroundColor Yellow
winget install Anaconda.Miniconda3 -e --silent --accept-source-agreements --accept-package-agreements

Write-Host "`n[5/5] Installing Rust Toolchain..." -ForegroundColor Yellow
$rustupPath = "$env:TEMP\rustup-init.exe"
Invoke-WebRequest -Uri "https://win.rustup.rs" -OutFile $rustupPath
& $rustupPath -y --default-toolchain stable --default-host x86_64-pc-windows-msvc
Remove-Item $rustupPath

Write-Host "`n=======================================================" -ForegroundColor Green
Write-Host " SETUP ALMOST COMPLETE! " -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host "IMPORTANT NEXT STEPS:"
Write-Host "1. Restart your terminal (or computer) to apply environment PATH changes."
Write-Host "2. Open a new terminal and set up the GDAL environment by running:"
Write-Host "   conda create -n gdal-env -c conda-forge gdal=3.7.0 -y"
Write-Host "3. To build the project, run:"
Write-Host "   npm install"
Write-Host "   npm run tauri dev"
Write-Host "======================================================="
