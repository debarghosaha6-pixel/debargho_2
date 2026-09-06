# GeoPixel Studio — Modern Raster Data Analyzer

A Flask-based GIS web application for uploading, analyzing, and normalizing
GeoTIFF raster datasets (single-band or multi-band), with full-resolution
CRS-preserving min-max normalization and CSV/PNG/GeoTIFF export.

## Features
- Drag & drop or browse GeoTIFF upload (.tif / .tiff, up to 100 MB)
- Multi-band support with per-band statistics and dynamic band switching
- Backend-sampled visualization grid (5–60 rows/cols) — never floods the browser
- Min-max normalization (0–1) computed independently per band, on the
  full-resolution raster, preserving width, height, band count, CRS and
  affine transform
- Viridis / Turbo / Grayscale / Terrain color palettes
- Raw & normalized CSV and PNG export
- Full-resolution normalized GeoTIFF download (ArcGIS/QGIS compatible)

## Local setup (Windows PowerShell)

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If `py` is not recognized, use:

```powershell
python -m pip install -r requirements.txt
```

Run the app locally:

```powershell
python app.py
```

Then open: http://127.0.0.1:5000

## Render deployment

- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app`
- The Flask application object is named `app` in `app.py`, so `gunicorn app:app` works as-is.
